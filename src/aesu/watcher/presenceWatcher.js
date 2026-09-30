'use strict';
const { config } = require('../config/index');
const ui = require('../ui');
const { resolveUniverseNames } = require('../roblox/games');
const { fetchPresences, isTrackedPresence, PresenceType } = require('../roblox/presence');
const { isAnyGameType } = require('../shifts/types');
const { randomId } = require('../util/ids');
const { createLogger, describeError } = require('../util/logger');

const log = createLogger('watcher');

function blankState(discordId) {
  return {
    discordId,
    sessionKey: null,
    universeId: null,
    placeId: null,
    gameName: null,
    lastSeenInGameAt: null,
    missingSince: null,
    promptStatus: 'none',
    promptSentAt: null,
    promptChannelId: null,
    promptMessageId: null,
    updatedAt: Date.now(),
  };
}

/**
 * What the event side needs out of one presence reading. Game nights count any game,
 * so the untracked case has to be described rather than collapsed to a boolean.
 */
function snapshot(presence) {
  const inAnyGame = presence.presenceType === PresenceType.InGame;
  return {
    inTrackedGame: isTrackedPresence(presence),
    inAnyGame,
    universeId: inAnyGame ? presence.universeId : null,
    placeId: inAnyGame ? presence.placeId ?? presence.rootPlaceId : null,
    gameName: inAnyGame ? presence.lastLocation : null,
  };
}

/**
 * Polls Roblox presence for every linked member and turns the transitions into
 * shift activity: a prompt when they join a tracked game, and an automatic
 * close-out when they leave it.
 */
class PresenceWatcher {
  timer = null;
  running = false;
  consecutiveFailures = 0;

  constructor(
    client,
    store,
    manager,
    events = null,
  ) {
    this.client = client;
    this.store = store;
    this.manager = manager;
    this.events = events;
  }

  start() {
    if (this.timer) return;
    const intervalMs = config.tracking.pollIntervalSeconds * 1000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Unref so the interval alone never keeps the process alive during shutdown.
    this.timer.unref?.();
    log.info(`Watching ${config.tracking.universeIds.length + config.tracking.placeIds.length} game(s) every ${config.tracking.pollIntervalSeconds}s`);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) {
      log.debug('Previous poll is still running; skipping this tick');
      return;
    }
    this.running = true;

    try {
      const links = await this.store.listLinks();
      if (links.length === 0) return;

      const presences = await fetchPresences(links.map((link) => link.robloxId));
      this.consecutiveFailures = 0;

      await this.hydrateGameNames(presences);

      const seen = new Map();

      for (const link of links) {
        const presence = presences.get(link.robloxId);
        // A member missing from the response is unknown, not offline - never end a
        // shift on missing data.
        if (!presence) continue;
        seen.set(link.discordId, snapshot(presence));
        try {
          await this.evaluate(link, presence);
        } catch (error) {
          log.error(`Failed to process presence for ${link.discordId}: ${describeError(error)}`);
        }
      }

      if (this.events) {
        try {
          await this.events.recordAttendance(seen);
        } catch (error) {
          log.error(`Could not record event attendance: ${describeError(error)}`);
        }
      }

      await this.manager.sweepStaleShifts();
    } catch (error) {
      this.consecutiveFailures += 1;
      const level = this.consecutiveFailures > 3 ? 'error' : 'warn';
      log[level](`Presence poll failed (${this.consecutiveFailures} in a row): ${describeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Warms the universe-name cache so prompts can name the game people just joined. */
  async hydrateGameNames(presences) {
    const universeIds = [...presences.values()]
      .filter((presence) => isTrackedPresence(presence))
      .map((presence) => presence.universeId)
      .filter((id) => Boolean(id));

    if (universeIds.length > 0) await resolveUniverseNames(universeIds);
  }

  async evaluate(link, presence) {
    const now = Date.now();
    const state = (await this.store.getWatchState(link.discordId)) ?? blankState(link.discordId);
    const tracked = isTrackedPresence(presence);

    // A game night runs in whatever game they picked, so an open shift of that kind
    // keeps its session alive anywhere - and ends when they leave games altogether.
    let openShift = null;
    let inSession = tracked;
    if (!inSession && presence.presenceType === PresenceType.InGame) {
      openShift = await this.manager.getOpenShift(link.discordId);
      inSession = openShift !== null && isAnyGameType(openShift.type);
    }

    log.debug(
      `${link.robloxUsername ?? link.robloxId}: presenceType=${PresenceType[presence.presenceType] ?? presence.presenceType} ` +
        `universeId=${presence.universeId ?? 'null'} placeId=${presence.placeId ?? 'null'} ` +
        `rootPlaceId=${presence.rootPlaceId ?? 'null'} lastLocation=${presence.lastLocation ?? 'null'} -> ` +
        `${tracked ? 'tracked' : inSession ? 'any-game shift' : 'not tracked'}`,
    );

    if (inSession) await this.handleInGame(link, presence, state, now, openShift);
    else await this.handleOutOfGame(link, state, now);
  }

  async handleInGame(
    link,
    presence,
    state,
    now,
    knownOpenShift = null,
  ) {
    const names = await resolveUniverseNames(presence.universeId ? [presence.universeId] : []);
    const gameName = (presence.universeId ? names.get(presence.universeId) : null) ?? presence.lastLocation ?? null;

    const isNewSession = state.sessionKey === null;
    const next = {
      ...state,
      sessionKey: state.sessionKey ?? randomId(8),
      universeId: presence.universeId,
      placeId: presence.placeId ?? presence.rootPlaceId,
      gameName,
      lastSeenInGameAt: now,
      missingSince: null,
      promptStatus: isNewSession ? 'none' : state.promptStatus,
      promptSentAt: isNewSession ? null : state.promptSentAt,
      promptChannelId: isNewSession ? null : state.promptChannelId,
      promptMessageId: isNewSession ? null : state.promptMessageId,
      updatedAt: now,
    };

    if (isNewSession) log.info(`${link.discordId} joined ${gameName ?? 'a game'}`);

    const openShift = knownOpenShift ?? (await this.manager.getOpenShift(link.discordId));

    if (openShift) {
      // Already on shift - no prompt, but make sure the record names the right game.
      next.promptStatus = 'accepted';
      await this.store.upsertWatchState(next);
      await this.manager.attachGameContext(openShift.id, {
        universeId: next.universeId,
        placeId: next.placeId,
        gameName: next.gameName,
      });
      return;
    }

    if (next.promptStatus === 'none') {
      const sent = await this.sendPrompt(link.discordId, gameName, link.robloxUsername);
      if (sent) {
        next.promptStatus = 'sent';
        next.promptSentAt = now;
        next.promptChannelId = sent.channelId;
        next.promptMessageId = sent.messageId;
      } else {
        // Do not retry every tick for the rest of this session - that would spam the
        // logs (and possibly the channel) until they leave the game.
        next.promptStatus = 'declined';
      }
      await this.store.upsertWatchState(next);
      return;
    }

    if (next.promptStatus === 'sent' && next.promptSentAt !== null) {
      const expiresAt = next.promptSentAt + config.tracking.promptTimeoutSeconds * 1000;
      if (now >= expiresAt) {
        await this.expirePrompt(next);
        next.promptStatus = 'declined';
        next.promptMessageId = null;
      }
    }

    await this.store.upsertWatchState(next);
  }

  async handleOutOfGame(link, state, now) {
    if (state.sessionKey === null) return;

    if (state.missingSince === null) {
      // Start the grace window - a server hop briefly looks like leaving.
      await this.store.upsertWatchState({ ...state, missingSince: now, updatedAt: now });
      return;
    }

    if (now - state.missingSince < config.tracking.leaveGraceSeconds * 1000) return;

    // The member is really gone: bank the shift as of the last time we saw them in game.
    const leftAt = state.lastSeenInGameAt ?? state.missingSince;
    const ended = await this.manager.endIfOpen(link.discordId, 'left_game', leftAt);
    if (ended) log.info(`${link.discordId} left ${state.gameName ?? 'the game'}; shift ${ended.id} closed`);

    if (state.promptStatus === 'sent') await this.expirePrompt(state);

    await this.store.upsertWatchState({ ...blankState(link.discordId), updatedAt: now });
  }

  async sendPrompt(
    discordId,
    gameName,
    robloxUsername,
  ) {
    if (!config.discord.promptChannelId) return null;

    try {
      // The "shift prompt" hook draws it; only the member it is for gets pinged.
      const message = await ui.post(
        config.discord.promptChannelId,
        'shift prompt',
        { discordId, gameName: gameName ?? '', robloxUsername: robloxUsername ?? '' },
        { about: discordId, ping: [discordId] },
      );
      if (!message) return null;
      log.info(`Asked ${discordId} whether to log their ${gameName ?? 'game'} session`);
      return { channelId: message.channelId, messageId: message.id };
    } catch (error) {
      log.error(
        `Could not post the join prompt for ${discordId} in channel ${config.discord.promptChannelId} ` +
          `(check the bot's View Channel and Send Messages permissions). Not retrying this session: ${describeError(error)}`,
      );
      return null;
    }
  }

  async expirePrompt(state) {
    if (!state.promptChannelId || !state.promptMessageId) return;
    await ui.edit(state.promptChannelId, state.promptMessageId, 'shift prompt closed', {
      discordId: state.discordId, gameName: state.gameName ?? '', accepted: 'no',
    }, { about: state.discordId });
  }
}

module.exports = { PresenceWatcher };
