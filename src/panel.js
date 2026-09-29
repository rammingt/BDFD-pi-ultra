'use strict';
// Web panel: edit commands and settings from a browser or phone.
// Runs inside the bot process so it can check and test code with the real engine.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { parseCommandFile } = require('./loader');

const STATIC_DIR = path.join(__dirname, '..', 'panel');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const FILE_NAME = /^[\w .()]{1,60}\.bdx$|^variables\.json$/;
const SECRET_KEYS = /TOKEN|PASSWORD|KEY|SECRET/i;
const RESTART_KEYS = new Set(['DISCORD_TOKEN', 'PANEL_PASSWORD', 'PANEL_PORT', 'PANEL_HOST', 'COMMANDS_DIR', 'DATA_FILE']);
const SESSION_DAYS = 30;

/* ---------- log capture, so the panel can show what the bot printed ---------- */
const logs = [];
function captureLogs() {
  for (const level of ['log', 'error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      logs.push({ t: Date.now(), level, text: text.slice(0, 4000) });
      if (logs.length > 300) logs.shift();
    };
  }
}

/* ---------- checking code without running it ---------- */

// Usage hints for every function, pulled from the need(...) calls in functions.js.
function functionDocs(registry) {
  const src = fs.readFileSync(path.join(__dirname, 'functions.js'), 'utf8');
  const usage = {};
  let current = null;
  for (const line of src.split('\n')) {
    const def = /^ {2}(\w+): \{/.exec(line);
    if (def) current = def[1].toLowerCase();
    const need = /need\(a, \d+, '(\$[^']+)'\)/.exec(line);
    if (current && need && !usage[current]) usage[current] = need[1];
  }
  return [...registry.values()].map((d) => ({ name: d.display, usage: usage[d.display.toLowerCase()] || `$${d.display}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function lint(code, registry) {
  const warnings = [];
  const lines = code.split('\n');
  const lineOf = (i) => code.slice(0, i).split('\n').length;
  let depth = 0; let blockIfs = 0; let endifs = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth < 0) { warnings.push({ line: lineOf(i), text: 'This ] has no [ to close. Write \\] if you meant the character.' }); depth = 0; }
    } else if (ch === '$') {
      const m = /^\$([a-zA-Z0-9]+)(\[?)/.exec(code.slice(i));
      if (!m) continue;
      const word = m[1].toLowerCase();
      if (m[2] && !registry.has(word)) {
        // Longest known prefix is what BDX will run. Only warn when nothing matches the whole name.
        let known = null;
        for (let k = word.length; k > 0; k--) if (registry.has(word.slice(0, k))) { known = word.slice(0, k); break; }
        warnings.push({ line: lineOf(i), text: known ? `$${m[1]} is not a function. BDX will read it as $${known} followed by "${m[1].slice(known.length)}".` : `$${m[1]} is not a function. Check the spelling.` });
      }
      if (word === 'endif') endifs++;
      if (word === 'if' && m[2]) {
        // Block $if has one argument: no ; at the top level of its brackets.
        let d = 0; let semis = 0;
        for (let j = i + 3; j < code.length; j++) {
          if (code[j] === '\\') { j++; continue; }
          if (code[j] === '[') d++;
          else if (code[j] === ']') { if (--d === 0) break; }
          else if (code[j] === ';' && d === 1) semis++;
        }
        if (semis === 0) blockIfs++;
      }
    }
  }
  if (depth > 0) warnings.push({ line: lines.length, text: `${depth} [ ${depth === 1 ? 'is' : 'are'} never closed with ].` });
  if (blockIfs > endifs) warnings.push({ line: lines.length, text: `${blockIfs - endifs} $if block${blockIfs - endifs === 1 ? ' is' : 's are'} missing $endif.` });
  if (endifs > blockIfs) warnings.push({ line: lines.length, text: `There ${endifs - blockIfs === 1 ? 'is an extra $endif' : `are ${endifs - blockIfs} extra $endif`} with no $if.` });
  return warnings;
}

function checkFile(name, content, registry) {
  if (name === 'variables.json') {
    try { JSON.parse(content); return { errors: [], warnings: [], commands: [] }; } catch (e) { return { errors: [e.message], warnings: [], commands: [] }; }
  }
  let commands = [];
  const errors = [];
  try { commands = parseCommandFile(content, name, registry); } catch (e) { errors.push(e.message.replace(`${name}: `, '')); }
  // Line numbers for warnings are per file, so lint each command chunk with its offset.
  const warnings = [];
  let offset = 0;
  for (const chunk of content.replace(/\r\n/g, '\n').split(/^---\s*$/m)) {
    const lines = chunk.split('\n');
    let skip = 0;
    while (skip < lines.length && (lines[skip].trim() === '' || lines[skip].trimStart().startsWith('@'))) skip++;
    for (const w of lint(lines.slice(skip).join('\n'), registry)) warnings.push({ line: w.line + offset + skip, text: w.text });
    offset += lines.length;
  }
  return { errors, warnings, commands: commands.map((c) => ({ name: c.name, type: c.type, aliases: c.aliases })) };
}

/* ---------- .env editing ---------- */

function readEnv(envFile) {
  if (!fs.existsSync(envFile)) return [];
  return fs.readFileSync(envFile, 'utf8').split('\n');
}

function envEntries(envFile) {
  const out = [];
  let note = [];
  for (const line of readEnv(envFile)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) {
      const secret = SECRET_KEYS.test(m[1]);
      out.push({ key: m[1], value: secret ? '' : m[2], secret, isSet: m[2] !== '', note: note.join(' ') });
      note = [];
    } else if (line.trim().startsWith('#')) note.push(line.replace(/^\s*#\s?/, ''));
    else note = [];
  }
  return out;
}

function writeEnv(envFile, changes) {
  const lines = readEnv(envFile);
  const done = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(lines[i]);
    if (m && m[1] in changes) { lines[i] = `${m[1]}=${changes[m[1]]}`; done.add(m[1]); }
  }
  for (const [k, v] of Object.entries(changes)) if (!done.has(k)) lines.push(`${k}=${v}`);
  atomicWrite(envFile, lines.join('\n'));
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o600 });
  fs.renameSync(tmp, file);
}

/* ---------- http helpers ---------- */

// A route returns plain data for 200, or reply(status, body) for anything else.
const STATUS = Symbol('status');
const reply = (status, body) => ({ [STATUS]: status, body });

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

/* ---------- the server ---------- */

function startPanel({ engine, client, commandsDir, envFile, password, port = 3200, host = '0.0.0.0' }) {
  if (!password) { console.log('[panel] off. Set PANEL_PASSWORD in .env to turn on the web editor.'); return null; }
  captureLogs();
  const sessions = new Map(); // token -> expiry
  const failures = new Map(); // ip -> { count, until }
  const startedAt = Date.now();
  const docs = functionDocs(engine.registry);

  const safePath = (name) => {
    if (!FILE_NAME.test(name || '') || name.includes('..')) return null;
    const full = path.join(commandsDir, name);
    return path.dirname(full) === path.resolve(commandsDir) ? full : null;
  };

  const listFiles = () => fs.readdirSync(commandsDir)
    .filter((n) => n.endsWith('.bdx') || n === 'variables.json')
    .map((name) => {
      const full = path.join(commandsDir, name);
      const cmds = engine.commands.filter((c) => path.resolve(c.file) === full).map((c) => ({ name: c.name, type: c.type }));
      return { name, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs, commands: cmds };
    })
    .sort((a, b) => (a.name === 'variables.json') - (b.name === 'variables.json') || a.name.localeCompare(b.name));

  const testEnv = (args) => ({
    args,
    mentions: args.map((a) => /^<@!?(\d+)>$/.exec(a)?.[1]).filter(Boolean),
    author: { id: '100000000000000001', username: 'tester', displayName: 'Tester', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', bot: false },
    guild: { id: '200000000000000002', name: 'Test Server', memberCount: 42 },
    channel: { id: '300000000000000003', name: 'test' },
    messageId: '400000000000000004',
    discord: client?.isReady() ? { client } : null,
    send: async (ch, p) => { sent.push(`Would send to ${ch || 'this channel'}: ${p.content}`); return '500000000000000005'; },
  });
  let sent = [];

  const routes = {
    'GET /api/status': () => ({
      bot: client?.isReady() ? { tag: client.user.tag, servers: client.guilds.cache.size, avatar: client.user.displayAvatarURL() } : null,
      uptime: Date.now() - startedAt,
      commands: engine.commands.length,
      prefix: engine.prefix,
    }),
    'GET /api/files': () => listFiles(),
    'GET /api/file': (q) => {
      const full = safePath(q.get('name'));
      if (!full || !fs.existsSync(full)) return reply(404, { error: 'No such file' });
      return { name: q.get('name'), content: fs.readFileSync(full, 'utf8') };
    },
    'PUT /api/file': (q, body) => {
      const name = q.get('name');
      const full = safePath(name);
      if (!full) return reply(400, { error: 'File names can use letters, numbers, spaces and _ . ( ) and must end in .bdx' });
      if (typeof body.content !== 'string') return reply(400, { error: 'No content' });
      const result = checkFile(name, body.content, engine.registry);
      if (result.errors.length && !body.force) return reply(422, { saved: false, ...result });
      if (body.create && fs.existsSync(full)) return reply(409, { error: 'A file with that name already exists' });
      atomicWrite(full, body.content);
      const reload = engine.reload(); // the file watcher also reloads, this just makes the reply up to date
      return { saved: true, ...result, loadErrors: reload.errors };
    },
    'DELETE /api/file': (q) => {
      const full = safePath(q.get('name'));
      if (!full || !fs.existsSync(full)) return reply(404, { error: 'No such file' });
      if (q.get('name') === 'variables.json') return reply(400, { error: 'variables.json can be emptied but not deleted' });
      fs.renameSync(full, `${full}.deleted-${Date.now()}`); // kept on disk, just in case
      engine.reload();
      return { deleted: true };
    },
    'POST /api/check': (q, body) => checkFile(body.name || 'draft.bdx', String(body.content || ''), engine.registry),
    'POST /api/run': async (q, body) => {
      let cmds;
      try { cmds = parseCommandFile(String(body.content || ''), body.name || 'draft.bdx', engine.registry); } catch (e) { return reply(422, { error: e.message }); }
      const cmd = cmds.find((c) => c.name === body.command) || cmds[0];
      if (!cmd) return reply(422, { error: 'There is no command in this file to run' });
      if (cmd.type === 'snippet') return reply(422, { error: 'Snippets run inside other commands. Test the command that uses it.' });
      sent = [];
      const args = String(body.args || '').split(/\s+/).filter(Boolean);
      const extra = cmd.type === 'button' ? { customId: `${cmd.name}:${args.join(':')}` } : {};
      const r = await engine.execute(cmd, { ...testEnv(args), ...extra });
      return {
        command: cmd.name, type: cmd.type, content: r.content, embeds: r.embeds, stopped: r.stopped, ms: r.ms,
        ephemeral: r.ephemeral, channelId: r.channelId, layout: r.layout,
        buttons: r.components.flatMap((row) => row.components.map((b) => ({ label: b.label, url: b.url || null, id: b.custom_id || null, style: b.style }))),
        files: (r.files || []).map((f) => {
          const bytes = Buffer.from(f.content, f.encoding || 'utf8');
          const image = /\.(png|jpe?g|gif|webp)$/i.test(f.name) && f.encoding === 'base64';
          return image
            ? { name: f.name, size: bytes.length, image: `data:image/${f.name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')};base64,${f.content.trim()}` }
            : { name: f.name, size: bytes.length, preview: bytes.toString('utf8').slice(0, 20000) };
        }),
        sent,
      };
    },
    'GET /api/functions': () => docs,
    'GET /api/settings': () => envEntries(envFile),
    'PUT /api/settings': (q, body) => {
      const changes = {};
      for (const [k, v] of Object.entries(body.changes || {})) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v)) return reply(400, { error: `Bad setting ${k}` });
        changes[k] = v.trim();
      }
      writeEnv(envFile, changes);
      let restart = false;
      for (const [k, v] of Object.entries(changes)) {
        if (RESTART_KEYS.has(k)) { restart = true; continue; }
        process.env[k] = v; // $env reads process.env, so BDX_ settings apply right away
        if (k === 'PREFIX') engine.prefix = v || '!';
      }
      return { saved: true, restart };
    },
    'GET /api/logs': () => logs,
    'POST /api/restart': () => {
      // systemd starts the bot again (Restart=always), which also reloads .env
      setTimeout(() => { engine.store.flush(); process.exit(0); }, 300);
      return { restarting: true };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://panel');
    const ip = req.socket.remoteAddress;
    try {
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const f = failures.get(ip);
        if (f && f.until > Date.now()) return send(res, 429, { error: 'Too many wrong passwords. Try again in a few minutes.' });
        const body = await readBody(req);
        const given = Buffer.from(String(body.password || ''));
        const want = Buffer.from(password);
        if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
          const n = (f?.count || 0) + 1;
          failures.set(ip, { count: n, until: n >= 8 ? Date.now() + 5 * 60e3 : 0 });
          await new Promise((r) => setTimeout(r, 800));
          return send(res, 401, { error: 'Wrong password' });
        }
        failures.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_DAYS * 864e5);
        return send(res, 200, { ok: true }, { 'set-cookie': `bdx_panel=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      }

      if (url.pathname.startsWith('/api/')) {
        const token = cookie(req, 'bdx_panel');
        const exp = token && sessions.get(token);
        if (!exp || exp < Date.now()) return send(res, 401, { error: 'Please log in' });
        if (url.pathname === '/api/logout') {
          sessions.delete(token);
          return send(res, 200, { ok: true }, { 'set-cookie': 'bdx_panel=; Path=/; Max-Age=0' });
        }
        // Writes must come from the panel's own page (SameSite cookie plus a JSON body).
        if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
          return send(res, 415, { error: 'Send JSON' });
        }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return send(res, 404, { error: 'Not found' });
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await route(url.searchParams, body);
        return out && out[STATUS] ? send(res, out[STATUS], out.body) : send(res, 200, out);
      }

      // static files
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(STATIC_DIR, file);
      if (!full.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found');
      res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      console.error('[panel]', e);
      send(res, 500, { error: e.message });
    }
  });
  server.listen(port, host, () => console.log(`[panel] web editor on http://${host === '0.0.0.0' ? 'this-pi' : host}:${port}`));
  return server;
}

module.exports = { startPanel, checkFile, lint };
