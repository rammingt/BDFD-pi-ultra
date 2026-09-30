'use strict';
// Discord glue: turns gateway events into Engine.execute() calls.
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, ApplicationCommandOptionType, Events, MessageFlags } = require('discord.js');
const { payloadOf, withNote, asEdit } = require('./payload');
const { Engine } = require('./engine');
const { parseDuration } = require('./functions');

const OPTION_TYPES = {
  string: ApplicationCommandOptionType.String, text: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer, number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean, user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel, role: ApplicationCommandOptionType.Role,
};

const toUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.globalName || u.username, avatar: u.displayAvatarURL({ size: 1024 }), bot: u.bot, createdAt: u.createdTimestamp });
const toGuild = (g) => g && ({ id: g.id, name: g.name, memberCount: g.memberCount, icon: g.iconURL({ size: 1024 }) || '' });
const toChannel = (c) => c && ({ id: c.id, name: c.name || 'DM' });

async function startBot({ token, commandsDir, dataFile, prefix, watch = true, beforeLogin }) {
  const engine = new Engine({ commandsDir, dataFile, prefix });
  const first = engine.reload();
  first.errors.forEach((e) => console.error(`[load] ${e}`));
  console.log(`[bdx] loaded ${first.count} command(s)`);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  const sendTo = async (channelId, fallbackChannel, payload) => {
    const ch = channelId ? await client.channels.fetch(channelId).catch(() => null) : fallbackChannel;
    if (!ch?.send) throw new Error(`channel ${channelId} not found`);
    const m = await ch.send({ ...payload, allowedMentions: { parse: [] } });
    return m.id;
  };

  const baseEnv = (user, guild, channel, member) => ({
    author: toUser(user), guild: toGuild(guild), channel: toChannel(channel), prefix: engine.prefix,
    discord: { client, guild, channel, member },
    send: (id, payload) => sendTo(id, channel, payload),
  });

  // Does this command's code call $name anywhere (including inside $if branches)?
  const uses = (nodes, name) => (nodes || []).some((n) => (n.name === name)
    || (n.args || []).some((a) => uses(a, name))
    || (n.branches || []).some((b) => uses(b.cond, name) || uses(b.body, name))
    || uses(n.else, name));

  // Send a result in reply to a message (or to a channel for events).
  async function deliver(r, { message, channel }) {
    const payload = payloadOf(r);
    let sent = null;
    if (payload) {
      if (r.dm) { const u = await client.users.fetch(String(r.dm).replace(/\D/g, '')); sent = await u.send(payload); }
      else if (r.channelId) { const ch = await client.channels.fetch(r.channelId); sent = await ch.send(payload); }
      else if (r.reply && message) sent = await message.reply(payload);
      else if (channel?.send) sent = await channel.send(payload);
    }
    if (sent) for (const e of r.reactions) await sent.react(e).catch(() => {});
    if (r.deleteCommand && message) await message.delete().catch(() => {});
  }

  async function runSafe(label, fn) {
    try { await fn(); } catch (e) { console.error(`[${label}]`, e); }
  }

  client.on(Events.MessageCreate, (message) => runSafe('message', async () => {
    if (message.author.bot) return;
    const env0 = baseEnv(message.author, message.guild, message.channel, message.member);
    const users = new Map(message.mentions.users.map((u) => [u.id, toUser(u)]));
    const mentions = [...message.mentions.users.keys()].filter((id) => id !== client.user.id);
    const common = { ...env0, users, mentions, messageId: message.id };

    for (const cmd of engine.ofType('always')) {
      const args = message.content.split(/\s+/).filter(Boolean);
      await deliver(await engine.execute(cmd, { ...common, args }), { message, channel: message.channel });
    }
    const hit = engine.match(message.content);
    if (!hit) return;
    message.channel.sendTyping?.().catch(() => {});
    const r = await engine.execute(hit.cmd, { ...common, args: hit.args });
    await deliver(r, { message, channel: message.channel });
  }));

  // Button, menu and form commands are found by their custom ID: "vote" handles
  // "vote" and "vote:123", with the part after the colon read as arguments.
  const byCustomId = (type, id) => engine.ofType(type).find((c) => id === c.name || id.startsWith(`${c.name}:`));
  // "vote:123:yes" handled by "vote" has the arguments 123 and yes. A name can hold
  // colons itself ("aesu:event_join"), so the arguments are whatever follows it.
  const idArgs = (cmd, id) => (cmd && id.length > cmd.name.length ? id.slice(cmd.name.length + 1).split(':') : []);

  client.on(Events.InteractionCreate, (i) => runSafe('interaction', () => answer(i).catch(async (e) => {
    // Never leave somebody looking at "This interaction failed" with no idea why.
    const note = { content: 'Something went wrong handling that. Try again in a moment.', ephemeral: true };
    if (i.isRepliable()) await (i.deferred || i.replied ? i.followUp(note) : i.reply(note)).catch(() => {});
    throw e;
  })));

  async function answer(i) {
    let cmd; let extra = {};
    if (i.isChatInputCommand()) {
      // "/flag add" is the command named "flag add"
      const sub = i.options.getSubcommand(false);
      const fullName = sub ? `${i.commandName} ${sub}` : i.commandName;
      cmd = engine.ofType('slash').concat(engine.ofType('both')).find((c) => c.name.toLowerCase().split(/\s+/).join(' ') === fullName);
      const options = {};
      const users = new Map();
      for (const o of sub ? i.options.data[0].options || [] : i.options.data) {
        options[o.name] = String(o.user?.id ?? o.channel?.id ?? o.role?.id ?? o.value ?? '');
        if (o.user) users.set(o.user.id, toUser(o.user));
      }
      extra = { options, users, args: Object.values(options) };
    } else if (i.isButton()) {
      cmd = byCustomId('button', i.customId);
      extra = { customId: i.customId, args: idArgs(cmd, i.customId) };
    } else if (i.isStringSelectMenu()) {
      // The picked values are read with $selectedValues
      cmd = byCustomId('select', i.customId);
      extra = { customId: i.customId, args: idArgs(cmd, i.customId), selectValues: i.values };
    } else if (i.isModalSubmit()) {
      // What was typed in each box is read with $input[box ID]
      cmd = byCustomId('modal', i.customId);
      const inputs = {};
      for (const [id, field] of i.fields.fields) inputs[id] = field.value ?? (field.values || []).join(',');
      extra = { customId: i.customId, args: idArgs(cmd, i.customId), inputs };
    }
    if (!cmd) return;
    const onMessage = Boolean(i.message) && (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit());
    // $updateMessage swaps out the message the button was on instead of answering with a new one
    const mayUpdate = onMessage && uses(cmd.ast, 'updateMessage');
    // A form has to be the very first answer, so a command that opens one is never deferred
    const opensForm = uses(cmd.ast, 'showModal');
    // Discord drops an interaction nobody answers within 3 seconds. If the command
    // is still busy (an HTTP call, $wait) by then, tell Discord we're working on it.
    let deferring = null;
    const timer = opensForm ? null : setTimeout(() => {
      deferring = (mayUpdate ? i.deferUpdate() : i.deferReply({ ephemeral: uses(cmd.ast, 'ephemeral') })).then(() => true, () => false);
    }, 2000);
    const r = await engine.execute(cmd, { ...baseEnv(i.user, i.guild, i.channel, i.member), messageId: onMessage ? i.message.id : '', ...extra })
      .finally(() => clearTimeout(timer));

    if (r.modal && !r.stopped) {
      if (!r.modal.components.length) throw new Error(`${cmd.name}: $showModal needs at least one $addTextInput`);
      await i.showModal(r.modal);
      return;
    }

    let payload = payloadOf(r);
    // $dm: send the result to DMs and just confirm in the channel. Files show up
    // reliably there, while phones often can't open files in "only you" replies.
    if (r.dm && payload && !r.stopped) {
      try {
        const u = await client.users.fetch(String(r.dm).replace(/\D/g, ''));
        await u.send(payload);
        payload = { content: 'Sent to your DMs.' };
      } catch {
        payload = withNote(payload, "I couldn't DM you, so here it is instead. Turn on DMs from server members to get these in DMs.");
      }
      r.ephemeral = true;
    }
    const deferred = deferring && await deferring;
    const updating = mayUpdate && r.update;

    if (updating && !r.stopped && !r.dm) {
      // A stopped command's message is an error for this person only, so it never replaces the panel.
      if (!payload) { if (!deferred) await i.deferUpdate(); return; }
      if (deferred) await i.editReply(asEdit(payload));
      else await i.update(asEdit(payload));
      return;
    }
    if (deferred) {
      // Deferred as an update, but the answer is a new message: send it privately beside the panel.
      if (mayUpdate) { if (payload) await i.followUp({ ...payload, ephemeral: true }); return; }
      await i.editReply(payload || { content: '✅' });
      return;
    }
    if (!payload) { if (i.isButton() || i.isStringSelectMenu()) await i.deferUpdate(); else await i.reply({ content: '✅', ephemeral: true }); return; }
    await i.reply({ ...payload, ephemeral: r.ephemeral || r.stopped });
  }

  const memberEvent = (type) => (member) => runSafe(type, async () => {
    for (const cmd of engine.ofType(type)) {
      const env = baseEnv(member.user, member.guild, member.guild.systemChannel, member);
      const r = await engine.execute(cmd, env);
      await deliver(r, { channel: member.guild.systemChannel });
    }
  });
  client.on(Events.GuildMemberAdd, memberEvent('join'));
  client.on(Events.GuildMemberRemove, memberEvent('leave'));

  async function registerSlash() {
    const optionDef = (o) => {
      const type = OPTION_TYPES[o.type] ?? OPTION_TYPES.string;
      const numeric = type === OPTION_TYPES.integer || type === OPTION_TYPES.number;
      return {
        name: o.name, description: o.description, required: o.required, type,
        ...(o.choices?.length ? { choices: o.choices.slice(0, 25).map((ch) => ({ name: ch.name, value: numeric ? Number(ch.value) : ch.value })) } : {}),
      };
    };
    // Required options have to come first, or Discord refuses the command.
    const sortOptions = (opts) => [...opts].sort((a, b) => b.required - a.required).map(optionDef);
    const defs = [];
    const groups = new Map();
    for (const c of engine.ofType('slash').concat(engine.ofType('both'))) {
      const [parent, sub] = c.name.toLowerCase().split(/\s+/);
      if (!sub) { defs.push({ name: parent, description: c.description, options: sortOptions(c.options) }); continue; }
      if (!groups.has(parent)) {
        const g = { name: parent, description: c.parent || `${parent} commands`, options: [] };
        groups.set(parent, g); defs.push(g);
      }
      const g = groups.get(parent);
      if (c.parent) g.description = c.parent;
      g.options.push({ name: sub, description: c.description, type: 1, options: sortOptions(c.options) });
    }
    await client.application.commands.set(defs);
    console.log(`[bdx] registered ${defs.length} slash command(s)`);
  }

  let timers = [];
  function startIntervals() {
    timers.forEach(clearInterval);
    timers = engine.ofType('interval').map((cmd) => setInterval(() => runSafe('interval', async () => {
      const r = await engine.execute(cmd, { author: toUser(client.user), discord: { client }, send: (id, p) => sendTo(id, null, p) });
      if (r.content && r.channelId) await deliver(r, {});
    }), parseDuration(cmd.every || '1h')));
  }

  client.once(Events.ClientReady, () => runSafe('ready', async () => {
    console.log(`[bdx] online as ${client.user.tag}`);
    await registerSlash();
    startIntervals();
    for (const cmd of engine.ofType('ready')) await engine.execute(cmd, { author: toUser(client.user), discord: { client }, send: (id, p) => sendTo(id, null, p) });
  }));

  if (watch) {
    let t = null;
    fs.watch(commandsDir, { recursive: true }, () => {
      clearTimeout(t);
      t = setTimeout(() => runSafe('reload', async () => {
        const res = engine.reload();
        res.errors.forEach((e) => console.error(`[load] ${e}`));
        console.log(`[bdx] hot-reloaded ${res.count} command(s)`);
        if (client.isReady()) { await registerSlash(); startIntervals(); }
      }), 300);
    });
  }

  const shutdown = () => { engine.store.flush(); client.destroy(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (beforeLogin) beforeLogin({ client, engine });
  await client.login(token);
  return { client, engine };
}

module.exports = { startBot };
