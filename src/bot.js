'use strict';
// Discord glue: turns gateway events into Engine.execute() calls.
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, ApplicationCommandOptionType, Events } = require('discord.js');
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

async function startBot({ token, commandsDir, dataFile, prefix, watch = true }) {
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

  const payloadOf = (r) => {
    if (!r.content && !r.embeds.length) return null;
    return { content: r.content ? r.content.slice(0, 2000) : undefined, embeds: r.embeds, components: r.components,
      allowedMentions: r.allowMentions ? undefined : { parse: [] } };
  };

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

  client.on(Events.InteractionCreate, (i) => runSafe('interaction', async () => {
    let cmd; let extra = {};
    if (i.isChatInputCommand()) {
      cmd = engine.ofType('slash').concat(engine.ofType('both')).find((c) => c.name.toLowerCase() === i.commandName);
      const options = {};
      const users = new Map();
      for (const o of i.options.data) {
        options[o.name] = String(o.user?.id ?? o.channel?.id ?? o.role?.id ?? o.value ?? '');
        if (o.user) users.set(o.user.id, toUser(o.user));
      }
      extra = { options, users, args: Object.values(options) };
    } else if (i.isButton()) {
      // @name of a button command is matched against the button's custom ID (prefix match, so "vote" handles "vote:123")
      cmd = engine.ofType('button').find((c) => i.customId === c.name || i.customId.startsWith(`${c.name}:`));
      extra = { customId: i.customId, args: i.customId.split(':').slice(1) };
    }
    if (!cmd) return;
    const r = await engine.execute(cmd, { ...baseEnv(i.user, i.guild, i.channel, i.member), ...extra });
    const payload = payloadOf(r);
    if (!payload) { if (i.isButton()) await i.deferUpdate(); else await i.reply({ content: '✅', ephemeral: true }); return; }
    await i.reply({ ...payload, ephemeral: r.ephemeral || r.stopped });
  }));

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
    const defs = engine.ofType('slash').concat(engine.ofType('both')).map((c) => ({
      name: c.name.toLowerCase(), description: c.description,
      options: c.options.map((o) => ({ name: o.name, description: o.description, required: o.required, type: OPTION_TYPES[o.type] ?? OPTION_TYPES.string })),
    }));
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

  await client.login(token);
  return { client, engine };
}

module.exports = { startBot };
