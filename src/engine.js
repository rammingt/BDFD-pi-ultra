'use strict';
// Discord-independent core: loads commands, indexes triggers, runs code.
const fs = require('fs');
const path = require('path');
const { buildRegistry } = require('./functions');
const { Interpreter, StopExecution } = require('./interpreter');
const { loadDir } = require('./loader');
const { Store } = require('./store');

class Engine {
  constructor({ commandsDir, dataFile, prefix = '!', maxSteps = 100000, extraFunctions } = {}) {
    this.commandsDir = commandsDir;
    this.prefix = prefix;
    this.maxSteps = maxSteps;
    this.registry = buildRegistry(extraFunctions);
    this.interpreter = new Interpreter(this.registry);
    this.store = new Store(dataFile);
    this.cooldowns = new Map();
    this.commands = [];
    this.byTrigger = new Map(); // lowercase name/alias -> command (O(1) lookup)
    this.byType = new Map();
    if (commandsDir) this.reload();
  }

  reload() {
    const { commands, errors } = loadDir(this.commandsDir, this.registry);
    this.setCommands(commands);
    const varsFile = path.join(this.commandsDir, 'variables.json');
    if (fs.existsSync(varsFile)) {
      try { this.store.setDefaults(JSON.parse(fs.readFileSync(varsFile, 'utf8'))); } catch (e) { errors.push(`variables.json: ${e.message}`); }
    }
    return { count: commands.length, errors };
  }

  setCommands(commands) {
    this.commands = commands;
    this.byTrigger = new Map();
    this.byType = new Map();
    for (const c of commands) {
      if (!this.byType.has(c.type)) this.byType.set(c.type, []);
      this.byType.get(c.type).push(c);
      if (c.type === 'prefix' || c.type === 'both') {
        for (const t of [c.name, ...c.aliases]) this.byTrigger.set(t.toLowerCase(), c);
      }
    }
  }

  ofType(type) { return this.byType.get(type) || []; }

  /** Find the prefix command for a raw message, or null. */
  match(content, prefix = this.prefix) {
    if (!content.startsWith(prefix)) return null;
    const words = content.slice(prefix.length).trim().split(/\s+/);
    const cmd = this.byTrigger.get((words[0] || '').toLowerCase());
    return cmd ? { cmd, args: words.slice(1).filter(Boolean) } : null;
  }

  /**
   * Run a command. `env` describes where it ran (see bot.js / cli for examples).
   * Returns { content, embeds, components, reply, ephemeral, ... }.
   */
  async execute(cmd, env) {
    const ctx = {
      steps: 0,
      maxSteps: this.maxSteps,
      errorMessage: undefined,
      startedAt: Date.now(),
      store: this.store,
      cooldowns: this.cooldowns,
      vars: new Map(),
      command: cmd,
      prefix: env.prefix ?? this.prefix,
      args: env.args || [],
      options: env.options || null,
      author: env.author,
      users: env.users || new Map(),
      guild: env.guild || null,
      channel: env.channel || null,
      messageId: env.messageId || '',
      mentions: env.mentions || [],
      customId: env.customId || '',
      discord: env.discord || null,
      send: env.send || (async () => ''),
      out: { embeds: [], components: [], reactions: [], reply: false, ephemeral: false, deleteCommand: false, dm: false, channelId: null, allowMentions: false },
    };
    let content;
    let stopped = false;
    try {
      content = await this.interpreter.evalNodes(cmd.ast, ctx);
    } catch (e) {
      if (!(e instanceof StopExecution)) throw e;
      content = e.userMessage;
      stopped = true;
      // a stopped command only shows its error message, not half-built embeds
      ctx.out.embeds = []; ctx.out.components = []; ctx.out.reactions = [];
    }
    const embeds = ctx.out.embeds.filter(Boolean).map((e) => (e.fields.length ? e : { ...e, fields: undefined }));
    return { ...ctx.out, embeds, content: content.trim(), stopped, ms: Date.now() - ctx.startedAt };
  }
}

module.exports = { Engine };
