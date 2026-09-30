'use strict';
// What /diagnose checks, in the order a problem usually shows up: where data lives,
// which games are tracked, starting rules, the group, roles, channels, the tracking
// account, the member's own link, and what Roblox says about them right now.
const { PermissionsBitField } = require('discord.js');
const { config, isOAuthConfigured, isPresenceTrackingEnabled } = require('./config/index');
const { resolveUniverseIdForPlace } = require('./roblox/games');
const { fetchPresences, isTrackedPresence, PresenceType, verifyCookie } = require('./roblox/presence');
const { isGroupConfigured, verifyGroupAccess } = require('./roblox/group');
const { anyGameTypeLabels } = require('./shifts/types');
const { SQUADS, squadRoleIds } = require('./squads/types');
const { describeError } = require('./util/logger');
const { resolveSendableChannel } = require('./discord/channels');

const MARK = { ok: '✅', warn: '⚠️', bad: '❌' };

function idList(ids) {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(', ') : '_none_';
}

/** The single thing to change, given how far down the chain the check got. */
async function verdict(presence) {
  if (!presence) {
    return { status: 'bad', text: '**Roblox returned no presence for your account.** The poll may be failing. Check the BDX log for `Presence poll failed`.' };
  }
  if (presence.presenceType !== PresenceType.InGame) {
    const state = PresenceType[presence.presenceType] ?? String(presence.presenceType);
    return {
      status: 'warn',
      text: `**Roblox reports you as \`${state}\`, not in a game.**\nJoin the game, wait a few seconds, then run this again. `
        + 'If it still says this while you are in game, Roblox is hiding your status from the tracking account. See the privacy note below.',
    };
  }
  if (!presence.universeId && !presence.placeId && !presence.rootPlaceId) {
    return {
      status: 'bad',
      text: '**Roblox says you are in a game but will not say which one.**\n'
        + 'This is a privacy restriction, not a bug. The tracking account cannot see your join status. Fix it by either:\n'
        + '• setting Settings > Privacy > Who can see my join status to **Everyone** on the account you are playing on, or\n'
        + '• adding the tracking account as a friend of the account you are playing on.',
    };
  }
  if (isTrackedPresence(presence)) {
    return { status: 'ok', text: `**This game is tracked.** You should have been prompted. If not, check the bot can post in <#${config.discord.promptChannelId}>.` };
  }
  // In a game, location is visible, but it is not one of the configured ids.
  const lines = ['**You are in a game that is not in the tracked list.**', '', 'Set **one** of these in the panel Settings, then restart:'];
  if (presence.universeId) lines.push('```', `TRACKED_UNIVERSE_IDS=${presence.universeId}`, '```');
  else if (presence.rootPlaceId ?? presence.placeId) {
    const placeId = presence.rootPlaceId ?? presence.placeId;
    const universeId = await resolveUniverseIdForPlace(placeId).catch(() => null);
    lines.push('```', universeId ? `TRACKED_UNIVERSE_IDS=${universeId}` : `TRACKED_PLACE_IDS=${placeId}`, '```');
  }
  return { status: 'bad', text: lines.join('\n') };
}

/**
 * Every role the bot hands out has the same two ways to fail: the id is not a role
 * in this server, or the bot's own role sits below it. Both look like the bot
 * silently ignoring you.
 */
async function roleReport(guild) {
  const managed = [
    ...[config.discord.onDutyRoleId, config.discord.onBreakRoleId, config.discord.offDutyRoleId].filter(Boolean).map((id) => ({ id, what: 'duty' })),
    ...squadRoleIds().map((id) => ({ id, what: 'squad' })),
  ];
  const section = (status, lines) => ({ title: 'Roles', status, lines });
  if (managed.length === 0) return section('warn', ['No duty or squad roles are configured.']);
  if (!guild) return section('warn', ['Run this in the server to check the role setup.']);

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) return section('bad', ['I could not read my own membership in this server.']);
  // An empty cache would report every role as missing, which is a false alarm.
  if (guild.roles.cache.size === 0) await guild.roles.fetch().catch(() => null);

  const canManage = me.permissions.has(PermissionsBitField.Flags.ManageRoles);
  const missing = managed.filter(({ id }) => !guild.roles.cache.has(id));
  const tooHigh = managed.filter(({ id }) => {
    const role = guild.roles.cache.get(id);
    return role ? me.roles.highest.comparePositionTo(role) <= 0 : false;
  });
  const healthy = canManage && missing.length === 0 && tooHigh.length === 0;
  const lines = [];
  if (!canManage) lines.push(`${MARK.bad} The bot does not have **Manage Roles**, so it cannot give anybody a role.`);
  if (missing.length > 0) lines.push(`${MARK.bad} Not a role in this server: ${missing.map(({ id }) => `\`${id}\``).join(', ')}`);
  if (tooHigh.length > 0) {
    lines.push(`${MARK.bad} These sit **above** the bot's own role, so it cannot assign them: ${tooHigh.map(({ id }) => `<@&${id}>`).join(', ')}. `
      + "Drag the bot's role above them in Server Settings > Roles.");
  }
  if (healthy) lines.push(`All ${managed.length} duty and squad role(s) are assignable.`);
  lines.push(`Squads: ${SQUADS.map((squad) => squad.label).join(', ')}`);
  return section(healthy ? 'ok' : 'bad', lines);
}

async function diagnose({ store, client, userId, guild }) {
  const sections = [];
  const add = (title, status, lines) => sections.push({ title, status, mark: MARK[status] ?? '', text: lines.filter((l) => l !== null).join('\n') });
  const done = (last = null) => ({ sections, verdict: last });

  // Only the owner sees where the Pi's control panel lives.
  if (config.discord.ownerId && userId === config.discord.ownerId) {
    add('Pi panel', config.web.panelUrl ? 'ok' : 'warn', [config.web.panelUrl
      ? `${config.web.panelUrl} · temperature, power, logs, restart and shutdown. Needs Tailscale on when you are away from home.`
      : '`PANEL_URL` is not set.']);
  }

  const usingPostgres = Boolean(config.storage.databaseUrl);
  add('Storage', usingPostgres ? 'ok' : 'warn', [usingPostgres
    ? 'Postgres. Links and shifts are kept.'
    : `JSON file at \`${config.storage.dataFile}\`. Fine on the Pi, but set \`DATABASE_URL\` to keep using the Postgres database the old tracker had.`]);

  const trackedCount = config.tracking.universeIds.length + config.tracking.placeIds.length;
  add('Tracked games', trackedCount > 0 ? 'ok' : 'bad', [
    `Universe IDs: ${idList(config.tracking.universeIds)}`,
    `Place IDs: ${idList(config.tracking.placeIds)}`,
    `Polling every \`${config.tracking.pollIntervalSeconds}s\``,
  ]);

  // ALLOW_MANUAL_START_OUTSIDE_GAME quietly overrides the in game rule, which looks like a bug.
  const enforced = !config.tracking.allowManualStartOutsideGame && isPresenceTrackingEnabled();
  const anyGame = anyGameTypeLabels();
  add('Starting shifts', enforced ? 'ok' : 'warn', enforced
    ? ['Members have to be in a tracked game to start a shift.', anyGame.length > 0 ? `**${anyGame.join('**, **')}** may be started in any game, and record which one.` : null]
    : [config.tracking.allowManualStartOutsideGame
      ? '`ALLOW_MANUAL_START_OUTSIDE_GAME` is **true**, so anyone can start a shift at any time, in game or not. Set it to `false` and restart to require being in game.'
      : 'Not enforced, because presence tracking is off. It needs `ROBLOX_COOKIE` plus `TRACKED_UNIVERSE_IDS` or `TRACKED_PLACE_IDS`.']);

  // Group management uses its own account and fails in its own ways.
  const groupLines = [];
  let groupStatus = isGroupConfigured() ? 'ok' : 'warn';
  if (!config.roblox.groupId) groupLines.push('`ROBLOX_GROUP_ID` is not set, so `/group` and the application buttons cannot rank anyone.');
  else if (!config.roblox.groupCookie && !config.roblox.cookie) groupLines.push('`ROBLOX_GROUP_COOKIE` is not set, so there is no account to act as.');
  else {
    const group = await verifyGroupAccess();
    if (!group.ok) {
      groupStatus = 'bad';
      groupLines.push(`Cannot act on group \`${config.roblox.groupId}\`${group.name ? ` (**${group.name}**)` : ''}: ${group.reason}`);
    } else {
      groupLines.push(`Managing **${group.name}** as **${group.role}**`);
      // A cookie that can read the group but not rank anybody looks like a working
      // setup until the first /group promote fails.
      const missing = [group.can?.accept ? null : 'accept join requests', group.can?.rank ? null : 'change ranks', group.can?.remove ? null : 'remove members'].filter(Boolean);
      if (missing.length) groupStatus = 'bad';
      groupLines.push(missing.length === 0
        ? 'That rank can accept, rank and remove members.'
        : `That rank **cannot ${missing.join(', cannot ')}**. Give it those group permissions, or use a higher ranked account.`);
    }
    if (!config.roblox.groupCookie) {
      groupLines.push(`${MARK.warn} Using \`ROBLOX_COOKIE\` for group actions. That account is meant to be a throwaway and almost certainly cannot rank anyone. Set \`ROBLOX_GROUP_COOKIE\` to an account with a ranking permission.`);
    }
  }
  add('Group management', groupStatus, groupLines);

  const roles = await roleReport(guild);
  add(roles.title, roles.status, roles.lines);

  // sendPrompt gives up quietly for the rest of a session when this fails, so it has to show here.
  const promptChannel = config.discord.promptChannelId ? await resolveSendableChannel(client, config.discord.promptChannelId) : null;
  const channelLines = [];
  if (!config.discord.promptChannelId) channelLines.push('`SHIFT_PROMPT_CHANNEL_ID` is not set, so the bot has nowhere to ping you when you join.');
  else if (!promptChannel) channelLines.push(`Cannot post in <#${config.discord.promptChannelId}>. Give the bot **View Channel** and **Send Messages** there, or check the id is right.`);
  else channelLines.push(`Pings go to <#${promptChannel.id}>.`);
  if (config.discord.logChannelId) {
    const logChannel = await resolveSendableChannel(client, config.discord.logChannelId);
    channelLines.push(logChannel ? `Shift records go to <#${logChannel.id}>.` : `${MARK.warn} Cannot post shift records in <#${config.discord.logChannelId}>.`);
  } else {
    channelLines.push(`${MARK.warn} \`SHIFT_LOG_CHANNEL_ID\` is not set, so shifts are recorded but not posted anywhere.`);
  }
  add('Prompt channel', promptChannel ? 'ok' : 'bad', channelLines);

  if (!isPresenceTrackingEnabled()) {
    return done({ status: 'bad', text: '**Presence tracking is off.** It needs `ROBLOX_COOKIE` plus at least one of `TRACKED_UNIVERSE_IDS` or `TRACKED_PLACE_IDS`. Shifts still work by hand from `/shift manage`.' });
  }

  const cookie = await verifyCookie();
  add('Tracking account', cookie.ok ? 'ok' : 'bad', [cookie.ok ? `Logged in as \`${cookie.username}\`` : `Cookie rejected: ${cookie.reason}`]);
  if (!cookie.ok) return done({ status: 'bad', text: 'Refresh `ROBLOX_COOKIE` with a new `.ROBLOSECURITY` value and restart.' });

  const link = await store.getLinkByDiscordId(userId);
  if (!link) {
    add('Your link', 'bad', ['Not linked.']);
    add('Linking', isOAuthConfigured() ? 'ok' : 'bad', [config.roblox.redirectUri ? `Redirect URI: \`${config.roblox.redirectUri}\`` : '`PUBLIC_BASE_URL` is not set, so there is no redirect URI.']);
    const pending = await store.latestOAuthState(userId);
    if (pending) {
      const minutes = Math.round((Date.now() - pending.createdAt) / 60_000);
      return done({
        status: 'bad',
        text: `**You started \`/connect\` ${minutes} minute(s) ago but never came back.**\nRoblox never returned you to the bot, so the link was never made. `
          + 'Check that the redirect URI above is registered **character for character** on your Roblox OAuth app at <https://create.roblox.com/dashboard/credentials>.',
      });
    }
    return done({ status: 'bad', text: 'No linking attempt on record. Run `/connect` and follow it through to the confirmation page.' });
  }
  add('Your link', 'ok', [`Linked to \`${link.robloxUsername}\` (id \`${link.robloxId}\`)`]);

  let presence;
  try {
    presence = (await fetchPresences([link.robloxId])).get(link.robloxId);
  } catch (error) {
    add('Live presence', 'bad', [`Lookup failed: ${describeError(error)}`]);
    return done();
  }
  add('Live presence', presence ? 'ok' : 'bad', presence ? [
    `State: \`${PresenceType[presence.presenceType] ?? presence.presenceType}\``,
    `universeId: \`${presence.universeId ?? 'null'}\``,
    `placeId: \`${presence.placeId ?? 'null'}\``,
    `rootPlaceId: \`${presence.rootPlaceId ?? 'null'}\``,
    `lastLocation: \`${presence.lastLocation ?? 'null'}\``,
  ] : ['Roblox returned no entry for your account.']);
  return done(await verdict(presence));
}

module.exports = { diagnose, MARK };
