'use strict';
// Every message the tracker sends on its own (shift log entries, join prompts,
// event posts, DMs) is drawn by a "@type hook" command in commands/aesu, so the
// wording and layout can be changed in the panel. This file runs those hooks and
// sends what they make. A hook reads what it is about with $json.
const { payloadOf, asEdit } = require('../payload');
const { createLogger, describeError } = require('./util/logger');
const { resolveSendableChannel } = require('./discord/channels');

const log = createLogger('ui');

let host = null;

/** Called once BDX has its engine and Discord client. */
function attach(engine, client) {
  host = { engine, client };
}

function userView(user) {
  return user && {
    id: user.id, username: user.username, displayName: user.globalName || user.username,
    avatar: user.displayAvatarURL({ size: 1024 }), bot: user.bot, createdAt: user.createdTimestamp,
  };
}

/**
 * Runs the hook and returns a message payload, or null when there is no such hook
 * or it ended with $stop (which is how a hook says "send nothing").
 * `about` is the Discord user the message concerns, so $username and friends work.
 */
async function render(name, data, { about = null, guildId = null } = {}) {
  if (!host) return null;
  const cmd = host.engine.hook(name);
  if (!cmd) {
    log.warn(`There is no hook called "${name}" in the commands folder, so nothing was sent`);
    return null;
  }
  const { client } = host;
  const user = about ? await client.users.fetch(about).catch(() => null) : null;
  const guild = guildId ? client.guilds.cache.get(guildId) ?? null : null;
  const r = await host.engine.execute(cmd, {
    json: data,
    author: userView(user ?? client.user),
    guild: guild && { id: guild.id, name: guild.name, memberCount: guild.memberCount, icon: guild.iconURL({ size: 1024 }) || '' },
    discord: { client, guild },
    send: async () => '',
  });
  if (r.stopped) {
    if (r.content) log.warn(`Hook "${name}" stopped: ${r.content}`);
    return null;
  }
  return payloadOf(r);
}

/** Posts a hook in a channel. `ping` lists the user IDs the message may mention. */
async function post(channelId, name, data, { about = null, guildId = null, ping = [] } = {}) {
  const channel = await resolveSendableChannel(host?.client, channelId);
  if (!channel) return null;
  const payload = await render(name, data, { about, guildId });
  if (!payload) return null;
  return channel.send({ ...payload, allowedMentions: { users: ping } });
}

/** Redraws an existing message with a hook. False when the message is gone. */
async function edit(channelId, messageId, name, data, { about = null, guildId = null } = {}) {
  try {
    const channel = await resolveSendableChannel(host?.client, channelId);
    if (!channel) return false;
    const payload = await render(name, data, { about, guildId });
    if (!payload) return false;
    const message = await channel.messages.fetch(messageId);
    await message.edit({ ...asEdit(payload), allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    log.debug(`Could not redraw message ${messageId} with "${name}": ${describeError(error)}`);
    return false;
  }
}

/** DMs a hook to somebody. False when their DMs are closed. */
async function dm(userId, name, data) {
  try {
    const payload = await render(name, data, { about: userId });
    if (!payload) return false;
    const user = await host.client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (error) {
    log.debug(`Could not DM ${userId}: ${describeError(error)}`);
    return false;
  }
}

module.exports = { attach, render, post, edit, dm, get client() { return host?.client ?? null; } };
