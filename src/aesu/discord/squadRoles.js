'use strict';
const { DiscordAPIError } = require('discord.js');
const { squadFromRoles, squadRoleChange } = require('../squads/types');
const { createLogger } = require('../util/logger');
const { explainRoleError, resolveGuild } = require('./roles');

const log = createLogger('discord:squads');

async function memberFor(client, guildId, discordId) {
  const guild = await resolveGuild(client, guildId);
  if (!guild) return null;
  return guild.members.fetch(discordId).catch(() => null);
}

/**
 * Which squad somebody is in, read straight off their Discord roles. The role is the
 * record: nothing is stored, so this cannot drift out of step with the server, and a
 * squad given out by hand counts exactly the same as one given by `/squad action:set`.
 */
async function resolveSquad(
  client,
  guildId,
  discordId,
) {
  const member = await memberFor(client, guildId, discordId);
  return member ? squadFromRoles(member.roles.cache.keys()) : null;
}

/**
 * Moves somebody into a squad, or out of every squad when given null. Unlike the duty
 * roles this reports what went wrong, because somebody is waiting on the answer.
 */
async function applySquad(
  client,
  guildId,
  discordId,
  squad,
) {
  const guild = await resolveGuild(client, guildId);
  if (!guild) {
    return { ok: false, reason: 'cant tell which server, set `DISCORD_GUILD_ID`' };
  }

  const { wanted, unwanted } = squadRoleChange(squad);

  try {
    const member = await guild.members.fetch(discordId);
    const stale = unwanted.filter((id) => member.roles.cache.has(id));
    const missing = wanted.filter((id) => !member.roles.cache.has(id));
    const reason = squad ? `Moved to ${squad.label}` : 'Removed from their squad';

    // Removed first: somebody briefly holding two squad roles reads as the wrong one.
    if (stale.length > 0) await member.roles.remove(stale, reason);
    if (missing.length > 0) await member.roles.add(missing, reason);

    log.info(`${discordId} is now ${squad ? squad.label : 'unassigned'}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === 10007) {
      return { ok: false, reason: `theyre not in ${guild.name}` };
    }
    return { ok: false, reason: explainRoleError(error, guild, 'squad roles') };
  }
}

module.exports = { resolveSquad, applySquad };
