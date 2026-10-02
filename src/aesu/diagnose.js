'use strict';
// What /diagnose checks, in the order a problem usually shows up: where data lives,
// which games are tracked, starting rules, the group, roles, channels, the tracking
// account, the member's own link, and what Roblox says about them right now.
const { PermissionsBitField } = require('discord.js');
const { config, isPresenceTrackingEnabled } = require('./config/index');
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
    return { status: 'bad', text: 'roblox gave nothing for ur acc, poll might be broken, check the log for `Presence poll failed`' };
  }
  if (presence.presenceType !== PresenceType.InGame) {
    const state = PresenceType[presence.presenceType] ?? String(presence.presenceType);
    return {
      status: 'warn',
      text: `roblox says ur \`${state}\`, not in game\njoin, wait a sec n run this again, if it still says this ur status is hidden`,
    };
  }
  if (!presence.universeId && !presence.placeId && !presence.rootPlaceId) {
    return {
      status: 'bad',
      text: 'roblox says ur in a game but wont say which, its ur privacy settings\n'
        + 'set Settings > Privacy > Who can see my join status to Everyone, or friend the tracking acc',
    };
  }
  if (isTrackedPresence(presence)) {
    return { status: 'ok', text: `this game is tracked so u shouldve got pinged, if not check the bot can post in <#${config.discord.promptChannelId}>` };
  }
  // In a game, location is visible, but it is not one of the configured ids.
  const lines = ['that game isnt tracked', '', 'put one of these in the panel Settings n restart:'];
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
  const section = (status, lines) => ({ title: 'roles', status, lines });
  if (managed.length === 0) return section('warn', ['no duty or squad roles set up']);
  if (!guild) return section('warn', ['run this in the server to check roles']);

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) return section('bad', ['bot cant read its own roles here']);
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
  if (!canManage) lines.push(`${MARK.bad} bot got no Manage Roles so it cant give roles`);
  if (missing.length > 0) lines.push(`${MARK.bad} not a role here: ${missing.map(({ id }) => `\`${id}\``).join(', ')}`);
  if (tooHigh.length > 0) {
    lines.push(`${MARK.bad} these r above the bot role so it cant give them: ${tooHigh.map(({ id }) => `<@&${id}>`).join(', ')}, drag the bot role higher`);
  }
  if (healthy) lines.push(`all ${managed.length} roles work`);
  lines.push(`squads: ${SQUADS.map((squad) => squad.label).join(', ')}`);
  return section(healthy ? 'ok' : 'bad', lines);
}

async function diagnose({ store, client, userId, guild }) {
  const sections = [];
  const add = (title, status, lines) => sections.push({ title, status, mark: MARK[status] ?? '', text: lines.filter((l) => l !== null).join('\n') });
  const done = (last = null) => ({ sections, verdict: last });

  // Only the owner sees where the Pi's control panel lives.
  if (config.discord.ownerId && userId === config.discord.ownerId) {
    add('pi panel', config.web.panelUrl ? 'ok' : 'warn', [config.web.panelUrl
      ? `${config.web.panelUrl} · turn tailscale on when ur not home`
      : '`PANEL_URL` isnt set']);
  }

  const usingPostgres = Boolean(config.storage.databaseUrl);
  add('storage', usingPostgres ? 'ok' : 'warn', [usingPostgres
    ? 'postgres'
    : `json file at \`${config.storage.dataFile}\`, set \`DATABASE_URL\` for the old postgres`]);

  const trackedCount = config.tracking.universeIds.length + config.tracking.placeIds.length;
  add('tracked games', trackedCount > 0 ? 'ok' : 'bad', [
    `universe ids: ${idList(config.tracking.universeIds)}`,
    `place ids: ${idList(config.tracking.placeIds)}`,
    `checks every \`${config.tracking.pollIntervalSeconds}s\``,
  ]);

  // ALLOW_MANUAL_START_OUTSIDE_GAME quietly overrides the in game rule, which looks like a bug.
  const enforced = !config.tracking.allowManualStartOutsideGame && isPresenceTrackingEnabled();
  const anyGame = anyGameTypeLabels();
  add('starting shifts', enforced ? 'ok' : 'warn', enforced
    ? ['gotta be in a tracked game to start', anyGame.length > 0 ? `${anyGame.join(', ')} works in any game` : null]
    : [config.tracking.allowManualStartOutsideGame
      ? '`ALLOW_MANUAL_START_OUTSIDE_GAME` is on so anyone can start anytime, set it `false` n restart to fix'
      : 'not checked cuz presence is off, needs `ROBLOX_COOKIE` n `TRACKED_UNIVERSE_IDS` or `TRACKED_PLACE_IDS`']);

  // Group management uses its own account and fails in its own ways.
  const groupLines = [];
  let groupStatus = isGroupConfigured() ? 'ok' : 'warn';
  if (!config.roblox.groupId) groupLines.push('`ROBLOX_GROUP_ID` isnt set so nothing can rank');
  else if (!config.roblox.groupCookie && !config.roblox.cookie) groupLines.push('`ROBLOX_GROUP_COOKIE` isnt set, no acc to use');
  else {
    const group = await verifyGroupAccess();
    if (!group.ok) {
      groupStatus = 'bad';
      groupLines.push(`cant use group \`${config.roblox.groupId}\`${group.name ? ` (${group.name})` : ''}: ${group.reason}`);
    } else {
      groupLines.push(`${group.name} as ${group.role}`);
      // A cookie that can read the group but not rank anybody looks like a working
      // setup until the first /group action:promote fails.
      const missing = [group.can?.accept ? null : 'accept join requests', group.can?.rank ? null : 'change ranks', group.can?.remove ? null : 'remove members'].filter(Boolean);
      if (missing.length) groupStatus = 'bad';
      groupLines.push(missing.length === 0
        ? 'that rank can do everything'
        : `that rank cant ${missing.join(' or ')}, give it perms or use a higher acc`);
    }
    if (!config.roblox.groupCookie) {
      groupLines.push(`${MARK.warn} using \`ROBLOX_COOKIE\` for group stuff, thats the throwaway acc n prob cant rank, set \`ROBLOX_GROUP_COOKIE\``);
    }
  }
  add('group', groupStatus, groupLines);

  const roles = await roleReport(guild);
  add(roles.title, roles.status, roles.lines);

  // sendPrompt gives up quietly for the rest of a session when this fails, so it has to show here.
  const promptChannel = config.discord.promptChannelId ? await resolveSendableChannel(client, config.discord.promptChannelId) : null;
  const channelLines = [];
  if (!config.discord.promptChannelId) channelLines.push('`SHIFT_PROMPT_CHANNEL_ID` isnt set, nowhere to ping');
  else if (!promptChannel) channelLines.push(`cant post in <#${config.discord.promptChannelId}>, give the bot perms there or check the id`);
  else channelLines.push(`pings go to <#${promptChannel.id}>`);
  if (config.discord.logChannelId) {
    const logChannel = await resolveSendableChannel(client, config.discord.logChannelId);
    channelLines.push(logChannel ? `shift logs go to <#${logChannel.id}>` : `${MARK.warn} cant post logs in <#${config.discord.logChannelId}>`);
  } else {
    channelLines.push(`${MARK.warn} \`SHIFT_LOG_CHANNEL_ID\` isnt set, shifts save but dont get posted`);
  }
  add('channels', promptChannel ? 'ok' : 'bad', channelLines);

  if (!isPresenceTrackingEnabled()) {
    return done({ status: 'bad', text: 'presence is off, needs `ROBLOX_COOKIE` n a tracked game id, `/shift action:manage` still works' });
  }

  const cookie = await verifyCookie();
  add('tracking acc', cookie.ok ? 'ok' : 'bad', [cookie.ok ? `logged in as \`${cookie.username}\`` : `cookie dead: ${cookie.reason}`]);
  if (!cookie.ok) return done({ status: 'bad', text: 'put a fresh `.ROBLOSECURITY` in `ROBLOX_COOKIE` n restart' });

  const link = await store.getLinkByDiscordId(userId);
  if (!link) {
    add('ur link', 'bad', ['not linked']);
    const bloxlink = require('./link').bloxlinkSettings(guild?.id ?? null);
    add('linking', bloxlink ? 'ok' : 'warn', [bloxlink
      ? 'bloxlink works, /connect just asks to confirm'
      : 'no bloxlink key so /connect needs a username n a code in the About']);
    return done({ status: 'bad', text: 'do /connect to link ur roblox' });
  }
  add('ur link', 'ok', [`\`${link.robloxUsername}\` (id \`${link.robloxId}\`)`]);

  let presence;
  try {
    presence = (await fetchPresences([link.robloxId])).get(link.robloxId);
  } catch (error) {
    add('presence', 'bad', [`lookup failed: ${describeError(error)}`]);
    return done();
  }
  add('presence', presence ? 'ok' : 'bad', presence ? [
    `state: \`${PresenceType[presence.presenceType] ?? presence.presenceType}\``,
    `universeId: \`${presence.universeId ?? 'null'}\``,
    `placeId: \`${presence.placeId ?? 'null'}\``,
    `rootPlaceId: \`${presence.rootPlaceId ?? 'null'}\``,
    `lastLocation: \`${presence.lastLocation ?? 'null'}\``,
  ] : ['roblox gave nothing for ur acc']);
  return done(await verdict(presence));
}

module.exports = { diagnose, MARK };
