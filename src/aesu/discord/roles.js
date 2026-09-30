'use strict';
const { DiscordAPIError } = require('discord.js');
const { config } = require('../config/index');
const { createLogger, describeError } = require('../util/logger');

const log = createLogger('discord:roles');

function dutyState(shift) {
  if (!shift || shift.status === 'ended') return 'off_duty';
  return shift.status === 'on_break' ? 'on_break' : 'on_duty';
}

/** The one role this state should carry, and the others it should not. */
function roleChange(state) {
  const byState = {
    on_duty: config.discord.onDutyRoleId,
    on_break: config.discord.onBreakRoleId,
    off_duty: config.discord.offDutyRoleId,
  };

  const wanted = byState[state];
  const unwanted = [...new Set(Object.values(byState))].filter((id) => id && id !== wanted);
  return { wanted, unwanted };
}

function isDutyRoleSyncEnabled() {
  return Boolean(config.discord.onDutyRoleId || config.discord.onBreakRoleId || config.discord.offDutyRoleId);
}

/** The guild to act in: the one a record belongs to, the configured one, or the only one. */
async function resolveGuild(client, guildId) {
  const id = guildId || config.discord.guildId;
  if (id) return client.guilds.fetch(id).catch(() => null);
  // A bot in exactly one server needs no configuration to know which one.
  return client.guilds.cache.size === 1 ? (client.guilds.cache.first() ?? null) : null;
}

/** Turns Discord's numeric complaints into the thing somebody has to go and change. */
function explainRoleError(error, guild, what = 'duty roles') {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) {
      return (
        `The bot needs **Manage Roles** in ${guild.name}, and its own role has to sit above the ${what} ` +
        'in Server Settings > Roles.'
      );
    }
    if (error.code === 10011) return `One of the ${what} ids does not exist in ${guild.name}.`;
    if (error.code === 10007) return `They are not in ${guild.name}.`;
  }
  return `${guild.name}: ${describeError(error)}`;
}

/**
 * Puts the member on exactly one of the duty roles. The state is read back from
 * their open shift rather than taken from whichever shift triggered this, so a
 * missed or out-of-order change corrects itself on the next one.
 */
async function syncDutyRoles(
  client,
  manager,
  guildId,
  discordId,
) {
  if (!isDutyRoleSyncEnabled()) return;

  // Callers fire this and forget, so it must never reject.
  try {
    await applyDutyRoles(client, manager, guildId, discordId);
  } catch (error) {
    log.error(`Cant change role of ${discordId}, I hate discord.. ${describeError(error)}`);
  }
}

async function applyDutyRoles(
  client,
  manager,
  guildId,
  discordId,
) {
  const guild = await resolveGuild(client, guildId);
  if (!guild) {
    log.debug(`No guild to sync duty roles in for ${discordId}; set DISCORD_GUILD_ID`);
    return;
  }

  const { wanted, unwanted } = roleChange(dutyState(await manager.getOpenShift(discordId)));

  try {
    const member = await guild.members.fetch(discordId);
    const stale = unwanted.filter((id) => member.roles.cache.has(id));

    if (stale.length > 0) await member.roles.remove(stale, 'Shift status changed');
    if (wanted && !member.roles.cache.has(wanted)) await member.roles.add(wanted, 'Shift status changed');
  } catch (error) {
    // Somebody who has left the server is not a problem worth shouting about.
    if (error instanceof DiscordAPIError && error.code === 10007) return;
    log.error(`Could not update duty roles for ${discordId}. ${explainRoleError(error, guild)}`);
  }
}

function registerDutyRoles(client, manager) {
  if (!isDutyRoleSyncEnabled()) {
    log.info('Duty roles are not configured; nobody will be given one');
    return;
  }

  manager.onChange(async (_change, shift) => {
    await syncDutyRoles(client, manager, shift.guildId, shift.discordId);
  });
}

module.exports = { dutyState, roleChange, isDutyRoleSyncEnabled, resolveGuild, explainRoleError, syncDutyRoles, registerDutyRoles };
