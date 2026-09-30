'use strict';
// The AESU shift tracker, running inside BDX. BDX owns the Discord client and the
// commands (commands/aesu/*.bdx); this starts everything that runs on its own:
// the database, the presence watcher, the OAuth web server, event timing, sheet
// sync, application posts, the shift log and duty roles.
//
// Off unless AESU_ENABLED=yes, so a BDX without the tracker never touches its settings.
const { Events } = require('discord.js');

const runtime = { started: false, startedAt: 0, store: null, manager: null, events: null, ranks: null, sheets: null, applications: null, watcher: null, client: null, server: null };

function isEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.AESU_ENABLED || '').trim().toLowerCase());
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_TICK_INTERVAL_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;

function reportConfig(log) {
  const { inspectConfig } = require('./config/index');
  const { SHIFT_TYPE_VALUES, unmatchedAnyGameKeys } = require('./shifts/types');
  const strays = unmatchedAnyGameKeys();
  if (strays.length > 0) {
    log.warn(
      `SHIFT_TYPES_ANY_GAME names ${strays.map((key) => `"${key}"`).join(', ')}, which no shift type uses. ` +
        `Those types are not exempt from the tracked game rule. Configured keys: ${SHIFT_TYPE_VALUES.join(', ')}`,
    );
  }
  for (const issue of inspectConfig()) log.warn(`${issue.variable}: ${issue.message}`);
}

/** Called by BDX before it logs in. Never throws: a broken tracker must not take the bot down. */
async function start({ client, engine }) {
  if (!isEnabled() || runtime.started) return runtime;
  const { createLogger, describeError } = require('./util/logger');
  const log = createLogger('bootstrap');
  try {
    await boot({ client, engine, log, describeError });
  } catch (error) {
    log.error(`The shift tracker could not start: ${describeError(error)}`);
  }
  return runtime;
}

async function boot({ client, engine, log, describeError }) {
  const { config, isPresenceTrackingEnabled } = require('./config/index');
  const { createStore } = require('./db/index');
  const { ShiftManager } = require('./shifts/manager');
  const { EventManager } = require('./events/manager');
  const { RankManager } = require('./ranks/manager');
  const { createSheetsSync } = require('./sheets/sync');
  const { createApplicationWatcher } = require('./sheets/applications');
  const { isGroupConfigured, verifyGroupAccess } = require('./roblox/group');
  const { verifyCookie } = require('./roblox/presence');
  const { PresenceWatcher } = require('./watcher/presenceWatcher');
  const { createWebServer } = require('./web/server');
  const { registerShiftLogging } = require('./discord/shiftLog');
  const { registerDutyRoles } = require('./discord/roles');
  const { registerEventPosts } = require('./discord/eventLog');
  const ui = require('./ui');

  ui.attach(engine, client);
  reportConfig(log);

  const startedAt = Date.now();
  const store = await createStore();
  const manager = new ShiftManager(store);
  const events = new EventManager(store, manager);
  const ranks = new RankManager(store, manager, events);
  await ranks.init();
  const sheets = createSheetsSync(ranks);
  const applications = createApplicationWatcher(store);
  Object.assign(runtime, { started: true, startedAt, store, manager, events, ranks, sheets, applications, client });

  registerShiftLogging(manager);
  registerDutyRoles(client, manager);
  registerEventPosts(events);

  const server = createWebServer({ store, client, manager, startedAt });
  runtime.server = server;
  server.on('error', (error) => log.error(`The web server could not start on port ${config.web.port}: ${error.message}. Is the old shift tracker still running?`));
  server.listen(config.web.port, () => log.info(`HTTP server listening on :${config.web.port}`));
  if (config.roblox.redirectUri) log.info(`OAuth redirect URI: ${config.roblox.redirectUri}`);

  const watcher = new PresenceWatcher(client, store, manager, events);
  runtime.watcher = watcher;

  // Runs regardless of presence tracking so a forgotten shift still gets closed.
  setInterval(() => {
    void manager.sweepStaleShifts().catch((error) => log.error(`Stale shift sweep failed: ${describeError(error)}`));
  }, SWEEP_INTERVAL_MS).unref();

  // Starts and closes events on time even when presence tracking is off.
  setInterval(() => {
    void events.tick().catch((error) => log.error(`Event tick failed: ${describeError(error)}`));
  }, EVENT_TICK_INTERVAL_MS).unref();

  const syncSheets = async () => {
    if (sheets) await sheets.syncNow().catch((error) => log.error(`Sheet sync failed: ${describeError(error)}`));
    if (applications) await applications.poll(client).catch((error) => log.error(`Application check failed: ${describeError(error)}`));
  };
  setInterval(() => void syncSheets(), config.sheets.syncIntervalMinutes * MINUTE_MS).unref();

  const onReady = async () => {
    // Group management stands on its own, so it is checked before the presence bail out.
    if (isGroupConfigured()) {
      const group = await verifyGroupAccess();
      if (!group.ok) {
        log.error(`Group management is configured but unusable: ${group.reason}`);
      } else {
        log.info(`Group management is on for ${group.name}, acting as ${group.role}`);
        const missing = [
          group.can?.accept ? null : 'accept join requests',
          group.can?.rank ? null : 'change ranks',
          group.can?.remove ? null : 'remove members',
        ].filter(Boolean);
        if (missing.length) log.warn(`That rank cannot ${missing.join(', ')}. Run /diagnose for the detail.`);
      }
    }

    // Discord has to be up first, since the sheet records display names.
    const readApplications = (async () => {
      // A first run must not dump every application ever submitted into the channel.
      if (applications && !(await applications.hasCursor())) {
        const skipped = await applications.skipExisting()
          .catch((error) => void log.error(`Could not read the applications sheet: ${describeError(error)}`));
        if (typeof skipped === 'number') log.info(`Ignoring ${skipped} application(s) already in the sheet; only new ones will be posted`);
      }
      await syncSheets();
    })();

    if (!isPresenceTrackingEnabled()) {
      log.warn(
        'Presence tracking is off (needs ROBLOX_COOKIE plus TRACKED_UNIVERSE_IDS or TRACKED_PLACE_IDS). ' +
          'Shifts can still be run by hand from /shift manage.',
      );
    } else {
      const cookie = await verifyCookie();
      if (!cookie.ok) log.error(`Roblox cookie check failed (${cookie.reason}). Presence tracking is disabled this run.`);
      else {
        log.info(`Roblox presence account: ${cookie.username}`);
        watcher.start();
      }
    }
    await readApplications;
  };
  const ready = () => void onReady().catch((error) => log.error(`Start up checks failed: ${describeError(error)}`));
  if (client.isReady()) ready();
  else client.once(Events.ClientReady, ready);

  const stop = async () => {
    watcher.stop();
    server.close();
    await store.close().catch(() => {});
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  log.info('Shift tracker started');
}

module.exports = { start, isEnabled, runtime };
