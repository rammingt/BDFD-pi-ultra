'use strict';
// The BDX standard library. Names are case-insensitive in scripts.
// Each entry: fn(ctx, args, node) where args is string[] (or null when the
// function was written without brackets). `lazy: true` entries receive
// thunks instead, so they can skip evaluating branches.
const { math, condition } = require('./expr');
const { StopExecution, BdxError } = require('./interpreter');

const fail = (msg) => { throw new BdxError(msg); };
const arg = (a, i, def = '') => (a && a[i] !== undefined && a[i] !== '' ? a[i] : def);
const need = (a, n, usage) => { if (!a || a.length < n) fail(`needs ${n} argument(s): ${usage}`); return a; };
const num = (v, what = 'value') => { const n = Number(v); if (v === '' || isNaN(n)) fail(`"${v}" is not a valid number (${what})`); return n; };
const bool = (v, def = false) => (v === '' || v === undefined ? def : ['yes', 'true', '1'].includes(String(v).toLowerCase()));
const stripId = (v) => String(v).replace(/[<@!#&>]/g, '').trim();

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
function parseDuration(v) {
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000; // bare number = seconds
  let total = 0; let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gi)) { total += Number(m[1]) * UNITS[m[2].toLowerCase()]; matched = true; }
  if (!matched) fail(`invalid duration "${v}" (use e.g. 10s, 5m, 1h30m)`);
  return total;
}
function formatDuration(ms) {
  let s = Math.ceil(ms / 1000);
  const parts = [];
  for (const [u, n] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (s >= n) { parts.push(`${Math.floor(s / n)}${u}`); s %= n; }
  }
  return parts.join(' ') || '0s';
}
const tmpl = (msg, map) => msg.replace(/%(\w+)%/g, (m, k) => (k in map ? map[k] : m));

function embed(ctx) {
  if (!ctx.out.embeds[0]) ctx.out.embeds[0] = { fields: [] };
  return ctx.out.embeds[0];
}

// Where a container piece goes: the named container, the open one, or the message itself.
function place(ctx, id) {
  if (id) {
    const box = ctx.out.containers[id];
    if (!box) fail(`no container called "${id}". Make it first with $addContainer[${id}]`);
    return box.components;
  }
  return ctx.out.container ? ctx.out.container.components : ctx.out.layout;
}

function userFromArg(ctx, v) {
  const id = v ? stripId(v) : ctx.author.id;
  return ctx.users?.get(id) || (id === ctx.author.id ? ctx.author : null);
}

async function fetchUser(ctx, v) {
  const local = userFromArg(ctx, v);
  if (local) return local;
  const client = ctx.discord?.client;
  if (!client) fail(`user "${v}" not found`);
  const u = await client.users.fetch(stripId(v)).catch(() => null);
  if (!u) fail(`user "${v}" not found`);
  return { id: u.id, username: u.username, displayName: u.globalName || u.username, avatar: u.displayAvatarURL({ size: 1024 }), bot: u.bot, createdAt: u.createdTimestamp };
}

function discordGuild(ctx) {
  const g = ctx.discord?.guild;
  if (!g) fail('this only works inside a server');
  return g;
}

function checkCooldown(ctx, key, time, error) {
  const ms = parseDuration(time);
  const now = Date.now();
  const until = ctx.cooldowns.get(key);
  if (until && until > now) throw new StopExecution(tmpl(error || '⏳ Slow down! Try again in %time%.', { time: formatDuration(until - now) }));
  ctx.cooldowns.set(key, now + ms);
  return '';
}

const F = {
  // ───────────── control flow ─────────────
  if: { lazy: true, async fn(ctx, a) {
    need(a, 2, '$if[condition;then;else?] (or block form $if[condition] ... $endif)');
    return condition(await a[0]()) ? a[1]() : (a[2] ? a[2]() : '');
  } },
  elseif: { fn: () => fail('$elseif without $if') },
  else: { fn: () => fail('$else without $if') },
  endif: { fn: () => fail('$endif without $if') },
  and: { fn: (ctx, a) => String(need(a, 1, '$and[cond;cond...]').every((c) => condition(c))) },
  or: { fn: (ctx, a) => String(need(a, 1, '$or[cond;cond...]').some((c) => condition(c))) },
  not: { fn: (ctx, a) => String(!condition(arg(a, 0))) },
  checkCondition: { fn: (ctx, a) => String(condition(arg(a, 0))) },
  onlyIf: { lazy: true, async fn(ctx, a) {
    need(a, 1, '$onlyIf[condition;error message?]');
    if (!condition(await a[0]())) throw new StopExecution(a[1] ? await a[1]() : '');
    return '';
  } },
  stop: { fn(ctx, a) { throw new StopExecution(arg(a, 0)); } },
  c: { lazy: true, requiresArgs: true, fn: () => '' }, // comment: never evaluated
  repeat: { lazy: true, async fn(ctx, a) {
    need(a, 2, '$repeat[times;code;separator?]');
    const n = Math.min(num(await a[0](), 'times'), 1000);
    const sep = a[2] ? await a[2]() : '';
    const out = [];
    const prev = ctx.vars.get('index');
    for (let i = 1; i <= n; i++) { ctx.vars.set('index', String(i)); out.push(await a[1]()); }
    if (prev !== undefined) ctx.vars.set('index', prev); else ctx.vars.delete('index');
    return out.join(sep);
  } },
  index: { fn: (ctx) => ctx.vars.get('index') ?? '' },
  wait: { async fn(ctx, a) {
    const ms = Math.min(parseDuration(need(a, 1, '$wait[duration]')[0]), 15 * 60000);
    // Timer-based: other commands keep running while this one sleeps.
    await new Promise((r) => setTimeout(r, ms));
    return '';
  } },
  suppressErrors: { fn(ctx, a) { ctx.errorMessage = arg(a, 0); return ''; } },

  // ───────────── variables ─────────────
  var: { fn(ctx, a) {
    need(a, 1, '$var[name;value?]');
    if (a.length > 1) { ctx.vars.set(a[0], a[1]); return ''; }
    return ctx.vars.get(a[0]) ?? '';
  } },
  setVar: { fn(ctx, a) { need(a, 2, '$setVar[name;value;userID?]'); ctx.store.set(a[0], a[1], a[2] || undefined); return ''; } },
  getVar: { fn: (ctx, a) => ctx.store.get(need(a, 1, '$getVar[name;userID?]')[0], a[1] || undefined) },
  setUserVar: { fn(ctx, a) {
    need(a, 2, '$setUserVar[name;value;userID?]');
    ctx.store.set(a[0], a[1], `u:${stripId(arg(a, 2, ctx.author.id))}`); return '';
  } },
  getUserVar: { fn: (ctx, a) => ctx.store.get(need(a, 1, '$getUserVar[name;userID?]')[0], `u:${stripId(arg(a, 1, ctx.author.id))}`) },
  setServerVar: { fn(ctx, a) {
    need(a, 2, '$setServerVar[name;value;serverID?]');
    ctx.store.set(a[0], a[1], `g:${arg(a, 2, ctx.guild?.id || 'dm')}`); return '';
  } },
  getServerVar: { fn: (ctx, a) => ctx.store.get(need(a, 1, '$getServerVar[name;serverID?]')[0], `g:${arg(a, 1, ctx.guild?.id || 'dm')}`) },
  resetUserVar: { fn(ctx, a) {
    const name = need(a, 1, '$resetUserVar[name]')[0];
    for (const [scope] of ctx.store.entries(name)) if (scope.startsWith('u:')) ctx.store.delete(name, scope);
    return '';
  } },
  varExists: { fn: (ctx, a) => String(need(a, 1, '$varExists[name]')[0] in ctx.store.defaults) },
  userLeaderboard: { fn(ctx, a) {
    need(a, 1, '$userLeaderboard[variable;count?;format?] — format uses %pos% %user% %value%');
    const count = Number(arg(a, 1, 10));
    const format = arg(a, 2, '#%pos% <@%user%> — %value%');
    return ctx.store.entries(a[0]).filter(([s]) => s.startsWith('u:'))
      .map(([s, v]) => [s.slice(2), Number(v) || 0]).sort((x, y) => y[1] - x[1]).slice(0, count)
      .map(([u, v], i) => tmpl(format, { pos: i + 1, user: u, value: v })).join('\n');
  } },

  // ───────────── message & args ─────────────
  message: { fn(ctx, a) {
    if (!a || a[0] === '') return ctx.args.join(' ');
    if (a[0] === '>') return ctx.args.slice(1).join(' ');
    if (ctx.options && a[0] in ctx.options) return ctx.options[a[0]];
    const n = Number(a[0]);
    if (!isNaN(n)) return ctx.args[n - 1] ?? '';
    return ctx.options?.[a[0]] ?? '';
  } },
  argsCount: { fn: (ctx) => String(ctx.args.length) },
  argsCheck: { fn(ctx, a) {
    need(a, 1, '$argsCheck[count|>count|<count;error?]');
    const m = /^([<>]?)(\d+)$/.exec(a[0].trim());
    if (!m) fail('first argument must look like 2, >1 or <3');
    const n = ctx.args.length; const want = Number(m[2]);
    const ok = m[1] === '>' ? n >= want : m[1] === '<' ? n <= want : n === want;
    if (!ok) throw new StopExecution(arg(a, 1));
    return '';
  } },
  noMentionMessage: { fn: (ctx) => ctx.args.filter((w) => !/^<[@#][!&]?\d+>$/.test(w)).join(' ') },
  mentioned: { fn(ctx, a) {
    const i = Number(arg(a, 0, 1)) - 1;
    return ctx.mentions[i] ?? (bool(arg(a, 1)) ? ctx.author.id : '');
  } },
  customID: { fn: (ctx) => ctx.customId || '' },
  commandName: { fn: (ctx) => ctx.command?.name || '' },
  prefix: { fn: (ctx) => ctx.prefix },

  // ───────────── text ─────────────
  replaceText: { fn(ctx, a) {
    need(a, 3, '$replaceText[text;find;replace;howMany?]');
    const how = Number(arg(a, 3, -1));
    if (how < 0) return a[0].split(a[1]).join(a[2]);
    let s = a[0];
    for (let i = 0; i < how && s.includes(a[1]); i++) s = s.replace(a[1], a[2]);
    return s;
  } },
  toUppercase: { fn: (ctx, a) => arg(a, 0).toUpperCase() },
  toLowercase: { fn: (ctx, a) => arg(a, 0).toLowerCase() },
  toTitleCase: { fn: (ctx, a) => arg(a, 0).replace(/\b\w/g, (c) => c.toUpperCase()) },
  length: { fn: (ctx, a) => String([...arg(a, 0)].length) },
  charCount: { fn: (ctx, a) => String([...(a ? a[0] : ctx.args.join(' '))].length) },
  cropText: { fn: (ctx, a) => [...need(a, 2, '$cropText[text;maxLength]')[0]].slice(0, num(a[1])).join('') },
  trimSpace: { fn: (ctx, a) => arg(a, 0).trim() },
  repeatMessage: { fn: (ctx, a) => need(a, 2, '$repeatMessage[times;text]')[1].repeat(Math.min(num(a[0]), 2000)) },
  checkContains: { fn(ctx, a) {
    need(a, 2, '$checkContains[text;phrase;phrase...]');
    const t = a[0].toLowerCase();
    return String(a.slice(1).some((p) => t.includes(p.toLowerCase())));
  } },
  isNumber: { fn: (ctx, a) => String(arg(a, 0) !== '' && !isNaN(Number(arg(a, 0)))) },
  isInteger: { fn: (ctx, a) => String(/^-?\d+$/.test(arg(a, 0))) },
  textSplit: { fn(ctx, a) { need(a, 1, '$textSplit[text;separator?]'); ctx.split = a[0].split(arg(a, 1, ' ')); return ''; } },
  splitText: { fn: (ctx, a) => (ctx.split || [])[num(need(a, 1, '$splitText[index]')[0]) - 1] ?? '' },
  getTextSplitLength: { fn: (ctx) => String((ctx.split || []).length) },
  joinSplitText: { fn: (ctx, a) => (ctx.split || []).join(arg(a, 0, ' ')) },
  url: { fn(ctx, a) {
    need(a, 2, '$url[encode|decode;text]');
    return a[0].toLowerCase() === 'decode' ? decodeURIComponent(a[1]) : encodeURIComponent(a[1]);
  } },

  // ───────────── math & random ─────────────
  math: { fn: (ctx, a) => String(math(need(a, 1, '$math[expression]')[0])) },
  calculate: { fn: (ctx, a) => String(math(need(a, 1, '$calculate[expression]')[0])) },
  sum: { fn: (ctx, a) => String(need(a, 1, '$sum[n;n...]').reduce((s, v) => s + num(v), 0)) },
  sub: { fn: (ctx, a) => String(need(a, 2, '$sub[n;n...]').slice(1).reduce((s, v) => s - num(v), num(a[0]))) },
  multi: { fn: (ctx, a) => String(need(a, 2, '$multi[n;n...]').reduce((s, v) => s * num(v), 1)) },
  divide: { fn: (ctx, a) => String(need(a, 2, '$divide[n;n...]').slice(1).reduce((s, v) => s / num(v), num(a[0]))) },
  modulo: { fn: (ctx, a) => String(num(need(a, 2, '$modulo[a;b]')[0]) % num(a[1])) },
  round: { fn(ctx, a) { const p = 10 ** Number(arg(a, 1, 0)); return String(Math.round(num(arg(a, 0)) * p) / p); } },
  floor: { fn: (ctx, a) => String(Math.floor(num(arg(a, 0)))) },
  ceil: { fn: (ctx, a) => String(Math.ceil(num(arg(a, 0)))) },
  abs: { fn: (ctx, a) => String(Math.abs(num(arg(a, 0)))) },
  sqrt: { fn: (ctx, a) => String(Math.sqrt(num(arg(a, 0)))) },
  max: { fn: (ctx, a) => String(Math.max(...need(a, 1, '$max[n;n...]').map((v) => num(v)))) },
  min: { fn: (ctx, a) => String(Math.min(...need(a, 1, '$min[n;n...]').map((v) => num(v)))) },
  random: { fn(ctx, a) {
    need(a, 2, '$random[min;max]');
    const lo = Math.ceil(num(a[0])); const hi = Math.floor(num(a[1]));
    return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
  } },
  randomText: { fn: (ctx, a) => { need(a, 1, '$randomText[a;b;c...]'); return a[Math.floor(Math.random() * a.length)]; } },
  randomString: { fn(ctx, a) {
    const n = Math.min(num(arg(a, 0, 8)), 2000);
    const cs = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let s = ''; for (let i = 0; i < n; i++) s += cs[Math.floor(Math.random() * cs.length)];
    return s;
  } },
  numberSeparator: { fn: (ctx, a) => num(arg(a, 0)).toLocaleString('en-US').replace(/,/g, arg(a, 1, ',')) },

  // ───────────── time ─────────────
  ping: { fn: (ctx) => String(Math.max(0, Math.round(ctx.discord?.client?.ws?.ping ?? 0))) },
  executionTime: { fn: (ctx) => String(Date.now() - ctx.startedAt) },
  uptime: { fn: (ctx) => formatDuration(process.uptime() * 1000) },
  getTimestamp: { fn: (ctx, a) => String(arg(a, 0) === 'ms' ? Date.now() : Math.floor(Date.now() / 1000)) },
  date: { fn: () => new Date().toISOString().slice(0, 10) },
  time: { fn: () => new Date().toTimeString().slice(0, 8) },
  formatDuration: { fn: (ctx, a) => formatDuration(parseDuration(arg(a, 0, '0s'))) },
  cooldown: { fn: (ctx, a) => checkCooldown(ctx, `c:${ctx.command.name}:${ctx.author.id}`, need(a, 1, '$cooldown[time;error?]')[0], arg(a, 1)) },
  serverCooldown: { fn: (ctx, a) => checkCooldown(ctx, `s:${ctx.command.name}:${ctx.guild?.id}`, need(a, 1, '$serverCooldown[time;error?]')[0], arg(a, 1)) },
  globalCooldown: { fn: (ctx, a) => checkCooldown(ctx, `g:${ctx.command.name}`, need(a, 1, '$globalCooldown[time;error?]')[0], arg(a, 1)) },

  // ───────────── users & server ─────────────
  authorID: { fn: (ctx) => ctx.author.id },
  userID: { async fn(ctx, a) { return a ? (await fetchUser(ctx, a[0])).id : ctx.author.id; } },
  username: { async fn(ctx, a) { return (await fetchUser(ctx, arg(a, 0))).username; } },
  displayName: { async fn(ctx, a) { return (await fetchUser(ctx, arg(a, 0))).displayName; } },
  userAvatar: { async fn(ctx, a) { return (await fetchUser(ctx, arg(a, 0))).avatar || ''; } },
  authorAvatar: { fn: (ctx) => ctx.author.avatar || '' },
  isBot: { async fn(ctx, a) { return String(!!(await fetchUser(ctx, arg(a, 0))).bot); } },
  creationDate: { async fn(ctx, a) { const u = await fetchUser(ctx, arg(a, 0)); return u.createdAt ? `<t:${Math.floor(u.createdAt / 1000)}:D>` : ''; } },
  findUser: { async fn(ctx, a) {
    const q = need(a, 1, '$findUser[name or id]')[0];
    if (/^<?@?!?\d{15,}>?$/.test(q)) return stripId(q);
    const g = ctx.discord?.guild;
    if (!g) return '';
    const res = await g.members.fetch({ query: q, limit: 1 }).catch(() => null);
    return res?.first()?.id || '';
  } },
  guildID: { fn: (ctx) => ctx.guild?.id || '' },
  serverID: { fn: (ctx) => ctx.guild?.id || '' },
  serverName: { fn: (ctx) => ctx.guild?.name || '' },
  membersCount: { fn: (ctx) => String(ctx.guild?.memberCount ?? 0) },
  serverIcon: { fn: (ctx) => ctx.guild?.icon || '' },
  channelID: { fn: (ctx) => ctx.channel?.id || '' },
  channelName: { fn: (ctx) => ctx.channel?.name || '' },
  messageID: { fn: (ctx) => ctx.messageId || '' },
  botID: { fn: (ctx) => ctx.discord?.client?.user?.id || '' },
  hasRole: { async fn(ctx, a) {
    need(a, 2, '$hasRole[userID;roleID]');
    const m = await discordGuild(ctx).members.fetch(stripId(a[0])).catch(() => null);
    return String(!!m?.roles.cache.has(stripId(a[1])));
  } },
  hasPerms: { async fn(ctx, a) {
    need(a, 2, '$hasPerms[userID;perm;perm...]');
    const m = await discordGuild(ctx).members.fetch(stripId(a[0])).catch(() => null);
    return String(!!m && a.slice(1).every((p) => m.permissions.has(permName(p))));
  } },
  onlyPerms: { async fn(ctx, a) {
    need(a, 2, '$onlyPerms[perm;perm...;error]');
    const perms = a.slice(0, -1);
    const m = ctx.discord?.member;
    if (!m || !perms.every((p) => m.permissions.has(permName(p)))) throw new StopExecution(a[a.length - 1]);
    return '';
  } },
  onlyForIDs: { fn(ctx, a) {
    need(a, 2, '$onlyForIDs[id;id...;error]');
    if (!a.slice(0, -1).includes(ctx.author.id)) throw new StopExecution(a[a.length - 1]);
    return '';
  } },
  onlyForServers: { fn(ctx, a) {
    need(a, 2, '$onlyForServers[id;id...;error]');
    if (!a.slice(0, -1).includes(ctx.guild?.id)) throw new StopExecution(a[a.length - 1]);
    return '';
  } },

  // ───────────── embeds ─────────────
  title: { fn(ctx, a) { embed(ctx).title = arg(a, 0); if (a?.[1]) embed(ctx).url = a[1]; return ''; } },
  description: { fn(ctx, a) { embed(ctx).description = arg(a, 0); return ''; } },
  color: { fn(ctx, a) {
    const c = arg(a, 0).replace('#', '');
    const n = parseInt(c, 16);
    if (isNaN(n)) fail(`invalid hex color "${arg(a, 0)}"`);
    embed(ctx).color = n; return '';
  } },
  footer: { fn(ctx, a) { embed(ctx).footer = { text: arg(a, 0), ...(a?.[1] ? { icon_url: a[1] } : {}) }; return ''; } },
  author: { fn(ctx, a) { embed(ctx).author = { name: arg(a, 0), ...(a?.[1] ? { icon_url: a[1] } : {}), ...(a?.[2] ? { url: a[2] } : {}) }; return ''; } },
  addField: { fn(ctx, a) {
    need(a, 2, '$addField[name;value;inline?]');
    embed(ctx).fields.push({ name: a[0], value: a[1], inline: bool(a[2]) }); return '';
  } },
  thumbnail: { fn(ctx, a) { embed(ctx).thumbnail = { url: arg(a, 0) }; return ''; } },
  image: { fn(ctx, a) { embed(ctx).image = { url: arg(a, 0) }; return ''; } },
  addTimestamp: { fn(ctx) { embed(ctx).timestamp = new Date().toISOString(); return ''; } },

  // ───────────── containers (Discord's newer message layout) ─────────────
  // A message with any of these is sent in the new layout, which can't have embeds.
  // Each one goes into the container named in its last argument, or the most
  // recently opened container, or straight into the message if none is open.
  addContainer: { fn(ctx, a) {
    const id = arg(a, 0) || `container${Object.keys(ctx.out.containers).length + 1}`;
    const box = { type: 17, components: [] };
    const color = arg(a, 1).replace('#', '');
    if (color) { const n = parseInt(color, 16); if (isNaN(n)) fail(`invalid hex color "${a[1]}"`); box.accent_color = n; }
    if (bool(a?.[2])) box.spoiler = true;
    ctx.out.containers[id] = box;
    ctx.out.container = box;
    ctx.out.layout.push(box);
    return '';
  } },
  closeContainer: { fn(ctx) { ctx.out.container = null; return ''; } },
  addTextDisplay: { fn(ctx, a) {
    const text = need(a, 1, '$addTextDisplay[text;containerID?]')[0];
    if (text.trim()) place(ctx, arg(a, 1)).push({ type: 10, content: text.slice(0, 4000) });
    return '';
  } },
  addSection: { fn(ctx, a) {
    const text = need(a, 1, '$addSection[text;thumbnail URL?;containerID?]')[0];
    const url = arg(a, 1).trim();
    const target = place(ctx, arg(a, 2));
    if (!url) { if (text.trim()) target.push({ type: 10, content: text.slice(0, 4000) }); return ''; }
    target.push({ type: 9, components: [{ type: 10, content: (text.trim() || '​').slice(0, 4000) }], accessory: { type: 11, media: { url } } });
    return '';
  } },
  addSeparator: { fn(ctx, a) {
    const divider = a?.[0] ? bool(a[0]) : true;
    const spacing = arg(a, 1).toLowerCase() === 'large' ? 2 : 1;
    place(ctx, arg(a, 2)).push({ type: 14, divider, spacing });
    return '';
  } },
  addMediaGallery: { fn(ctx, a) {
    const urls = need(a, 1, '$addMediaGallery[image URL;image URL...]').map((u) => u.trim()).filter(Boolean).slice(0, 10);
    if (urls.length) place(ctx, '').push({ type: 12, items: urls.map((url) => ({ media: { url } })) });
    return '';
  } },

  // ───────────── response behaviour ─────────────
  reply: { fn(ctx) { ctx.out.reply = true; return ''; } },
  attachFile: { fn(ctx, a) {
    const [name, content] = need(a, 2, '$attachFile[file name;content]');
    if (ctx.out.files.length >= 10) fail('a message can carry at most 10 files');
    ctx.out.files.push({ name: name.trim() || 'file.txt', content });
    return '';
  } },
  // Runs a "@type snippet" command in place, sharing this command's variables,
  // HTTP result and embed. Handy for code two commands both need.
  include: { async fn(ctx, a) {
    const name = need(a, 1, '$include[snippet name]')[0].trim().toLowerCase();
    const snip = ctx.engine.ofType('snippet').find((c) => c.name.toLowerCase() === name);
    if (!snip) fail(`no snippet called "${name}"`);
    if (ctx.includeDepth >= 10) fail('snippets include each other too deep');
    ctx.includeDepth++;
    try { return await ctx.engine.interpreter.evalNodes(snip.ast, ctx); } finally { ctx.includeDepth--; }
  } },
  ephemeral: { fn(ctx) { ctx.out.ephemeral = true; return ''; } },
  deleteCommand: { fn(ctx) { ctx.out.deleteCommand = true; return ''; } },
  dm: { fn(ctx, a) { ctx.out.dm = arg(a, 0, ctx.author.id); return ''; } },
  useChannel: { fn(ctx, a) { ctx.out.channelId = stripId(need(a, 1, '$useChannel[channelID]')[0]); return ''; } },
  allowMention: { fn(ctx) { ctx.out.allowMentions = true; return ''; } },
  disableMentions: { fn(ctx) { ctx.out.allowMentions = false; return ''; } },
  addReactions: { fn(ctx, a) { ctx.out.reactions.push(...need(a, 1, '$addReactions[emoji;emoji...]')); return ''; } },
  addButton: { fn(ctx, a) {
    need(a, 3, '$addButton[newRow(yes/no);customID or URL;label;style?;disabled?;emoji?]');
    const style = arg(a, 3, 'primary').toLowerCase();
    const styles = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
    if (!styles[style]) fail(`style must be one of ${Object.keys(styles).join(', ')}`);
    // Inside an open container the button goes into the container; otherwise below the message.
    const list = ctx.out.container ? ctx.out.container.components : ctx.out.components;
    const last = list[list.length - 1];
    if (!last || last.type !== 1 || bool(a[0]) || last.components.length >= 5) list.push({ type: 1, components: [] });
    const b = { type: 2, style: styles[style], label: a[2], disabled: bool(a[4]) };
    if (style === 'link') b.url = a[1]; else b.custom_id = a[1];
    if (a[5]) b.emoji = /^\d+$/.test(a[5]) ? { id: a[5] } : { name: a[5] };
    list[list.length - 1].components.push(b);
    return '';
  } },
  sendMessage: { async fn(ctx, a) {
    need(a, 1, '$sendMessage[text;returnID?]');
    const id = await ctx.send(null, { content: a[0] });
    return bool(a[1]) ? id || '' : '';
  } },
  channelSendMessage: { async fn(ctx, a) {
    need(a, 2, '$channelSendMessage[channelID;text;returnID?]');
    const id = await ctx.send(stripId(a[0]), { content: a[1] });
    return bool(a[2]) ? id || '' : '';
  } },

  // ───────────── moderation ─────────────
  ban: { async fn(ctx, a) {
    need(a, 1, '$ban[userID;reason?]');
    await discordGuild(ctx).members.ban(stripId(a[0]), { reason: arg(a, 1) || undefined });
    return '';
  } },
  unban: { async fn(ctx, a) { await discordGuild(ctx).members.unban(stripId(need(a, 1, '$unban[userID]')[0])); return ''; } },
  kick: { async fn(ctx, a) {
    need(a, 1, '$kick[userID;reason?]');
    const m = await discordGuild(ctx).members.fetch(stripId(a[0]));
    await m.kick(arg(a, 1) || undefined); return '';
  } },
  timeout: { async fn(ctx, a) {
    need(a, 2, '$timeout[userID;duration;reason?]');
    const m = await discordGuild(ctx).members.fetch(stripId(a[0]));
    await m.timeout(parseDuration(a[1]), arg(a, 2) || undefined); return '';
  } },
  giveRole: { async fn(ctx, a) {
    need(a, 2, '$giveRole[userID;roleID]');
    const m = await discordGuild(ctx).members.fetch(stripId(a[0])); await m.roles.add(stripId(a[1])); return '';
  } },
  takeRole: { async fn(ctx, a) {
    need(a, 2, '$takeRole[userID;roleID]');
    const m = await discordGuild(ctx).members.fetch(stripId(a[0])); await m.roles.remove(stripId(a[1])); return '';
  } },
  clear: { async fn(ctx, a) {
    const n = Math.min(Math.max(num(need(a, 1, '$clear[amount]')[0]), 1), 100);
    const ch = ctx.discord?.channel; if (!ch?.bulkDelete) fail('cannot clear messages here');
    const del = await ch.bulkDelete(n, true); return String(del.size);
  } },

  // ───────────── JSON & web ─────────────
  jsonParse: { fn(ctx, a) {
    try { ctx.json = JSON.parse(need(a, 1, '$jsonParse[text]')[0]); } catch { fail('invalid JSON'); }
    return '';
  } },
  json: { fn(ctx, a) {
    let v = ctx.json;
    for (const k of a || []) v = v == null ? undefined : v[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  } },
  jsonSet: { fn(ctx, a) {
    need(a, 2, '$jsonSet[key;key...;value]');
    if (typeof ctx.json !== 'object' || ctx.json === null) ctx.json = {};
    let o = ctx.json;
    for (const k of a.slice(0, -2)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
    o[a[a.length - 2]] = a[a.length - 1]; return '';
  } },
  jsonStringify: { fn: (ctx) => JSON.stringify(ctx.json ?? null) },
  jsonPretty: { fn(ctx, a) {
    let v = ctx.json;
    for (const k of a || []) v = v == null ? undefined : v[k];
    return v === undefined ? '' : JSON.stringify(v, null, 2);
  } },
  httpAddHeader: { fn(ctx, a) {
    need(a, 2, '$httpAddHeader[name;value]');
    (ctx.httpHeaders ??= {})[a[0]] = a[1];
    return '';
  } },
  httpGet: { async fn(ctx, a) {
    const url = need(a, 1, '$httpGet[url]')[0];
    if (!/^https?:\/\//.test(url)) fail('url must start with http:// or https://');
    const headers = ctx.httpHeaders || {};
    ctx.httpHeaders = {}; // headers apply to the next request only, like BDFD
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    ctx.vars.set('httpStatus', String(res.status));
    ctx.json = undefined;
    try { ctx.json = JSON.parse(text); } catch { /* not JSON, fine */ }
    ctx.httpResult = text;
    return '';
  } },
  httpStatus: { fn: (ctx) => ctx.vars.get('httpStatus') || '' },
  // Reads a setting from .env. Only names starting with BDX_ are allowed, so a
  // command can never print DISCORD_TOKEN or anything else that lives there.
  env: { fn(ctx, a) {
    const name = need(a, 1, '$env[BDX_NAME]')[0].trim();
    if (!name.startsWith('BDX_')) fail('only settings that start with BDX_ can be read');
    return process.env[name] ?? '';
  } },
  httpResult: { fn: (ctx, a) => {
    if (a && a.length) { let v = ctx.json; for (const k of a) v = v?.[k]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
    return ctx.httpResult || '';
  } },
};

function permName(p) {
  const map = { admin: 'Administrator', administrator: 'Administrator', manageserver: 'ManageGuild', manageguild: 'ManageGuild',
    managemessages: 'ManageMessages', managechannels: 'ManageChannels', manageroles: 'ManageRoles', ban: 'BanMembers',
    banmembers: 'BanMembers', kick: 'KickMembers', kickmembers: 'KickMembers', moderatemembers: 'ModerateMembers', timeout: 'ModerateMembers' };
  return map[p.toLowerCase().replace(/[\s_]/g, '')] || p;
}

function buildRegistry(extra = {}) {
  const reg = new Map();
  for (const [name, def] of Object.entries({ ...F, ...extra })) reg.set(name.toLowerCase(), { ...def, display: name });
  return reg;
}

module.exports = { buildRegistry, parseDuration, formatDuration, FUNCTIONS: F };
