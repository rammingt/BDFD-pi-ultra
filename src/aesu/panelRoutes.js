'use strict';
// Web panel routes for the shift tracker: how it is doing, who is on shift (with
// a way to end one), and bringing the old tracker's settings over in one paste.
const { runtime, isEnabled } = require('./index');

const mod = (name) => require(`./${name}`);

// Settings the old tracker had that mean something else to BDX, and what they become.
const RENAMED = { PORT: 'AESU_PORT', DATA_FILE: 'AESU_DATA_FILE' };
// BDX logs in with its own bot, and RoVuew now runs inside BDX, so these are left
// out (and the panel says so).
const SKIPPED = new Set(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'LOG_LEVEL', 'NODE_ENV', 'ROVUEW_BASE_URL', 'ROVUEW_API_KEY']);

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

module.exports = (reply, { readEnv, writeEnv, author }) => ({
  'GET /api/aesu/status': async () => {
    if (!runtime.started) {
      return { on: false, enabled: isEnabled(), note: isEnabled() ? 'AESU_ENABLED is yes, but the tracker did not start. The Logs tab says why.' : 'Off. Import the old settings below, or set AESU_ENABLED=yes in Settings, then restart.' };
    }
    const { config, isOAuthConfigured, isPresenceTrackingEnabled } = mod('config/index');
    const { computeDurations } = mod('shifts/manager');
    const { shiftTypeLabel } = mod('shifts/types');
    const { formatDuration } = mod('util/time');
    const [links, open] = await Promise.all([runtime.store.listLinks(), runtime.store.listOpenShifts()]);
    const now = Date.now();
    return {
      on: true,
      storage: config.storage.databaseUrl ? 'Postgres' : `JSON file ${config.storage.dataFile}`,
      linked: links.length,
      presence: isPresenceTrackingEnabled(),
      oauth: isOAuthConfigured(),
      redirect: config.roblox.redirectUri,
      webPort: config.web.port,
      trackedGames: config.tracking.universeIds.length + config.tracking.placeIds.length,
      applications: Boolean(runtime.applications),
      sheets: Boolean(runtime.sheets),
      shifts: open.map((shift) => {
        const link = links.find((l) => l.discordId === shift.discordId);
        const user = runtime.client?.users?.cache?.get(shift.discordId);
        return {
          discordId: shift.discordId,
          name: user?.globalName || user?.username || link?.robloxUsername || shift.discordId,
          roblox: shift.robloxUsername ?? link?.robloxUsername ?? '',
          type: shiftTypeLabel(shift.type),
          status: shift.status === 'on_break' ? 'On break' : 'On shift',
          worked: formatDuration(computeDurations(shift, now).workedMs),
          game: shift.gameName ?? '',
          startedAt: shift.startedAt,
        };
      }),
    };
  },

  // Ends somebody's shift from the panel, the same as /admin action:endshift
  'POST /api/aesu/endshift': async (q, body) => {
    if (!runtime.started) return reply(400, { error: 'The shift tracker is not running' });
    const id = String(body.discordId || '').trim();
    const shift = await runtime.manager.endIfOpen(id, 'admin');
    if (!shift) return reply(404, { error: 'They were no longer on shift' });
    const { summarise } = mod('shifts/manager');
    const banked = mod('util/time').formatDuration(summarise([shift]).workedMs);
    const { config } = mod('config/index');
    if (config.discord.adminLogChannelId) {
      await mod('ui').post(config.discord.adminLogChannelId, 'admin log', { what: `Ended <@${id}>'s shift from the web panel, ${banked} banked.`, actorId: runtime.client?.user?.id ?? '' }).catch(() => {});
    }
    return { ended: true, banked, by: author };
  },

  // Paste the old tracker's .env. Every setting comes over; the ones BDX already uses
  // for something else get an AESU_ name so both keep working.
  'POST /api/aesu/import': (q, body) => {
    const incoming = parseEnv(body.content || '');
    const keys = Object.keys(incoming);
    if (keys.length === 0) return reply(400, { error: 'Nothing that looks like SETTING=value was in there' });
    const current = Object.fromEntries(readEnv().map((e) => [e.key, e]));
    const changes = { AESU_ENABLED: 'yes' };
    const renamed = []; const skipped = []; const copied = [];
    for (const key of keys) {
      const value = incoming[key];
      if (SKIPPED.has(key)) { skipped.push(key); continue; }
      let target = RENAMED[key] ?? key;
      // Already set in BDX to something different: keep BDX's, and give the tracker its own copy.
      if (target === key && current[key]?.isSet && !current[key].secret && current[key].value !== value) target = `AESU_${key}`;
      if (target === key && current[key]?.isSet && current[key].secret) target = `AESU_${key}`;
      if (target !== key) renamed.push(`${key} → ${target}`);
      else copied.push(key);
      changes[target] = value;
    }
    writeEnv(changes);
    return { saved: true, copied, renamed, skipped, restart: true };
  },
});
