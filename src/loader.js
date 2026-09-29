'use strict';
// Loads .bdx command files. A file can hold several commands separated by a
// line containing only "---". Each command starts with optional @directives:
//
//   @name ping                (default: file name)
//   @type prefix              prefix | slash | both | button | join | leave | ready | always | snippet
//   @aliases p, pong
//   @description Check the bot latency
//   @option user:user:Who to check:required     (slash options: name:type:description[:required][:choices])
//                             choices look like  badge=Badge|accessory=Accessory
//   @name flag add            a space makes a slash subcommand: /flag add
//   @parent Manage flags      description for the /flag group (optional)
//
// Everything after the directives is BDX code.
const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');

const TYPES = new Set(['prefix', 'slash', 'both', 'button', 'select', 'join', 'leave', 'ready', 'always', 'interval', 'snippet']);

function parseCommandFile(text, file, registry) {
  const chunks = text.replace(/\r\n/g, '\n').split(/^---\s*$/m);
  const base = path.basename(file, path.extname(file));
  return chunks.map((chunk, i) => parseCommand(chunk, chunks.length > 1 ? `${base}#${i + 1}` : base, file, registry))
    .filter((c) => c.code.trim() || c.explicit);
}

function parseCommand(chunk, fallbackName, file, registry) {
  const cmd = { name: fallbackName, type: 'prefix', aliases: [], description: 'A BDX command', options: [], file, explicit: false, every: null };
  const lines = chunk.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('@'))) {
    const line = lines[i].trim(); i++;
    if (!line) continue;
    const m = /^@(\w+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    cmd.explicit = true;
    switch (key.toLowerCase()) {
      case 'name': cmd.name = value.trim(); break;
      case 'type': {
        const t = value.trim().toLowerCase();
        if (!TYPES.has(t)) throw new Error(`${file}: unknown @type "${t}" (use ${[...TYPES].join(', ')})`);
        cmd.type = t; break;
      }
      case 'aliases': cmd.aliases = value.split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'description': cmd.description = value.trim().slice(0, 100) || cmd.description; break;
      case 'every': cmd.every = value.trim(); break;
      case 'parent': cmd.parent = value.trim().slice(0, 100); break;
      case 'option': {
        const [name, type = 'string', description = name, req = '', choices = ''] = value.split(':').map((s) => s.trim());
        cmd.options.push({
          name: name.toLowerCase(), type: type.toLowerCase(), description, required: req.toLowerCase() === 'required',
          choices: choices ? choices.split('|').map((c) => { const [v, label = v] = c.split('=').map((x) => x.trim()); return { value: v, name: label }; }) : [],
        });
        break;
      }
      default: throw new Error(`${file}: unknown directive @${key}`);
    }
  }
  cmd.code = lines.slice(i).join('\n').trim();
  cmd.ast = parse(cmd.code, registry);
  return cmd;
}

function loadDir(dir, registry) {
  const commands = [];
  const errors = [];
  if (!fs.existsSync(dir)) return { commands, errors };
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.bdx')) {
        try { commands.push(...parseCommandFile(fs.readFileSync(full, 'utf8'), full, registry)); } catch (e) { errors.push(e.message); }
      }
    }
  };
  walk(dir);
  return { commands, errors };
}

module.exports = { loadDir, parseCommandFile };
