#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Engine } = require('../src/engine');
const { parseCommandFile } = require('../src/loader');

const ROOT = process.cwd();
// minimal .env support (no extra dependency)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const commandsDir = path.resolve(process.env.COMMANDS_DIR || 'commands');
const dataFile = path.resolve(process.env.DATA_FILE || 'data/variables.json');
const prefix = process.env.PREFIX || '!';

const fakeEnv = (args) => ({
  args,
  mentions: args.map((a) => /^<@!?(\d+)>$/.exec(a)?.[1]).filter(Boolean),
  author: { id: '100000000000000001', username: 'tester', displayName: 'Tester', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', bot: false },
  guild: { id: '200000000000000002', name: 'Test Server', memberCount: 42 },
  channel: { id: '300000000000000003', name: 'general' },
  messageId: '400000000000000004',
  send: async (ch, p) => { console.log(`  → [send to ${ch || 'this channel'}] ${p.content}`); return '500000000000000005'; },
});

function show(r) {
  if (r.content) console.log(r.content);
  for (const e of r.embeds) console.log('[embed]', JSON.stringify(e, null, 2));
  for (const row of r.components) console.log('[buttons]', row.components.map((b) => `[${b.label}]`).join(' '));
  for (const f of r.files || []) console.log(`[file] ${f.name} (${Buffer.byteLength(f.content)} bytes)`);
  const flags = ['reply', 'ephemeral', 'deleteCommand'].filter((f) => r[f]);
  console.log(`\x1b[2m(${r.ms}ms${flags.length ? ', ' + flags.join(', ') : ''})\x1b[0m`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start': {
      const { startBot } = require('../src/bot');
      const { startPanel } = require('../src/panel');
      const panel = ({ client, engine }) => startPanel({
        engine, client, commandsDir, envFile,
        password: process.env.PANEL_PASSWORD,
        port: Number(process.env.PANEL_PORT) || 3200,
        host: process.env.PANEL_HOST || '0.0.0.0',
      });
      if (!process.env.DISCORD_TOKEN) {
        // No token yet: still open the panel so it can be set from the browser.
        console.error('Set DISCORD_TOKEN in .env (see .env.example), or in the web panel Settings');
        const engine = new Engine({ commandsDir, dataFile, prefix });
        if (!panel({ client: null, engine })) process.exit(1);
        break;
      }
      try {
        await startBot({ token: process.env.DISCORD_TOKEN, commandsDir, dataFile, prefix, beforeLogin: panel });
      } catch (e) {
        // Wrong token and the like. Keep the panel up so it can be fixed from there.
        console.error(`Could not log in to Discord: ${e.message}`);
        if (!process.env.PANEL_PASSWORD) process.exit(1);
      }
      break;
    }
    case 'check': {
      const engine = new Engine({ commandsDir, dataFile: null, prefix });
      const res = engine.reload();
      for (const c of engine.commands) console.log(`  ${c.type.padEnd(8)} ${c.name}${c.aliases.length ? ` (${c.aliases.join(', ')})` : ''}  — ${path.relative(ROOT, c.file)}`);
      res.errors.forEach((e) => console.error(`  ✗ ${e}`));
      console.log(`${res.count} command(s), ${res.errors.length} error(s)`);
      process.exit(res.errors.length ? 1 : 0);
    }
    // eslint-disable-next-line no-fallthrough
    case 'run': {
      // bdx run <command name or file> [args...]   — test without Discord
      const engine = new Engine({ commandsDir, dataFile, prefix });
      const target = rest[0];
      if (!target) { console.error('usage: bdx run <command|file.bdx> [args...]'); process.exit(1); }
      let command = engine.byTrigger.get(target.toLowerCase()) || engine.commands.find((c) => c.name.toLowerCase() === target.toLowerCase() || c.aliases.includes(target));
      if (!command && fs.existsSync(target)) command = parseCommandFile(fs.readFileSync(target, 'utf8'), target, engine.registry)[0];
      if (!command) { console.error(`no command "${target}"`); process.exit(1); }
      show(await engine.execute(command, fakeEnv(rest.slice(1))));
      engine.store.flush();
      break;
    }
    case 'repl': {
      const engine = new Engine({ commandsDir, dataFile, prefix });
      const { parse } = require('../src/parser');
      console.log('BDX REPL — type code, e.g. $math[2+2] or !ping (runs a command). Ctrl+C to exit.');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'bdx> ' });
      rl.prompt();
      rl.on('line', async (line) => {
        const hit = engine.match(line);
        const command = hit ? hit.cmd : { name: 'repl', ast: parse(line, engine.registry) };
        show(await engine.execute(command, fakeEnv(hit ? hit.args : [])));
        rl.prompt();
      });
      rl.on('close', () => { engine.store.flush(); process.exit(0); });
      break;
    }
    case 'functions': {
      const { FUNCTIONS } = require('../src/functions');
      console.log(Object.keys(FUNCTIONS).map((n) => `$${n}`).join('  '));
      break;
    }
    default:
      console.log(`BDX — BDFD-style bots on your own hardware

  bdx start              run the bot (needs DISCORD_TOKEN in .env)
  bdx check              validate every command file
  bdx run <cmd> [args]   run a command locally, no Discord needed
  bdx repl               interactive playground
  bdx functions          list all functions`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
