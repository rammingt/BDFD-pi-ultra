'use strict';
// Finding the Roblox account a staff member means, and the optional record of what
// was done to it in GROUP_LOG_CHANNEL_ID (the "group log" hook).
const { config } = require('../config/index');
const { classifyTarget, findUserById, findUserByUsername, GroupError } = require('../roblox/group');
const { robloxProfileUrl } = require('../roblox/games');
const { createLogger, describeError } = require('../util/logger');
const ui = require('../ui');

const log = createLogger('discord:group');

/**
 * Turns whatever was typed into a Roblox account. A Discord member has to have used
 * `/connect`, since their Discord name is no help on Roblox.
 */
async function resolveTarget(store, input) {
  const { kind, value } = classifyTarget(input);

  if (kind === 'discord') {
    const link = await store.getLinkByDiscordId(value);
    if (!link) {
      throw new GroupError(
        `<@${value}> has not linked a Roblox account with \`/connect\`, so I cannot tell who they are in game. ` +
          'Pass their Roblox username instead.',
      );
    }
    const user = await findUserById(link.robloxId);
    if (!user) throw new GroupError(`Roblox has no account with the id \`${link.robloxId}\` any more.`);
    return { user, discordId: value };
  }

  if (kind === 'robloxId') {
    const user = await findUserById(value);
    if (!user) throw new GroupError(`Roblox has no account with the id \`${value}\`.`);
    return { user, discordId: (await store.getLinkByRobloxId(user.id))?.discordId ?? null };
  }

  return targetFromUsername(store, value);
}

/**
 * The username path on its own, for callers that already know they hold a username.
 * Going through `classifyTarget` would read a numeric one as an id and could act on a
 * completely different account.
 */
async function targetFromUsername(store, username) {
  const user = await findUserByUsername(username);
  if (!user) throw new GroupError(`Roblox has no account called \`${username}\`.`);

  const link = await store.getLinkByRobloxId(user.id);
  return { user, discordId: link?.discordId ?? null };
}

function describeUser(target) {
  const profile = `[${target.user.name}](${robloxProfileUrl(target.user.id)})`;
  return target.discordId ? `${profile} (<@${target.discordId}>)` : profile;
}

function describeRole(role) {
  return `${role.name} (rank ${role.rank})`;
}

/**
 * Writes an action to GROUP_LOG_CHANNEL_ID when one is set. A failure here must never
 * undo an action Roblox has already accepted.
 */
async function logGroupAction(client, entry) {
  if (!config.group.logChannelId) return;
  try {
    await ui.post(config.group.logChannelId, 'group log', {
      action: entry.action,
      user: describeUser(entry.target),
      robloxName: entry.target.user.name,
      robloxId: String(entry.target.user.id),
      discordId: entry.target.discordId ?? '',
      detail: entry.detail ?? '',
      actorId: entry.actorId,
    });
  } catch (error) {
    log.warn(`Could not write to the group log channel: ${describeError(error)}`);
  }
}

module.exports = { resolveTarget, targetFromUsername, describeUser, describeRole, logGroupAction };
