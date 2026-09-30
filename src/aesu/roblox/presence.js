'use strict';
const { config, isTrackedGame } = require('../config/index');
const { HttpError, request } = require('../util/http');
const { createLogger } = require('../util/logger');
const { robloxAuthed } = require('./authed');

const log = createLogger('roblox:presence');

const PRESENCE_URL = 'https://presence.roblox.com/v1/presence/users';
const BATCH_SIZE = 50;

const PresenceType = Object.freeze({
  Offline: 0,
  0: 'Offline',
  Online: 1,
  1: 'Online',
  InGame: 2,
  2: 'InGame',
  InStudio: 3,
  3: 'InStudio',
});

function toPresence(entry) {
  return {
    userId: String(entry.userId),
    presenceType: entry.userPresenceType,
    universeId: entry.universeId === null || entry.universeId === undefined ? null : String(entry.universeId),
    placeId: entry.placeId === null || entry.placeId === undefined ? null : String(entry.placeId),
    rootPlaceId: entry.rootPlaceId === null || entry.rootPlaceId === undefined ? null : String(entry.rootPlaceId),
    gameId: entry.gameId ?? null,
    lastLocation: entry.lastLocation ?? null,
  };
}

/**
 * Reads presence for the given Roblox user ids.
 *
 * placeId/universeId are only populated when the bot account is allowed to see the
 * member's join status - see the README note about the "Who can see my join status"
 * privacy setting.
 */
async function fetchPresences(userIds) {
  const result = new Map();
  if (userIds.length === 0) return result;
  if (!config.roblox.cookie) {
    log.debug('ROBLOX_COOKIE is not set; skipping presence lookup');
    return result;
  }

  for (let index = 0; index < userIds.length; index += BATCH_SIZE) {
    const batch = userIds.slice(index, index + BATCH_SIZE).map((id) => Number(id));
    const response = await robloxAuthed(PRESENCE_URL, {
      cookie: config.roblox.cookie,
      method: 'POST',
      body: JSON.stringify({ userIds: batch }),
    });
    const body = (await response.json());
    for (const entry of body.userPresences ?? []) {
      const presence = toPresence(entry);
      result.set(presence.userId, presence);
    }
  }

  return result;
}

/** Presence reports the place the member is in; TRACKED_PLACE_IDS may name any of them. */
function isTrackedPresence(presence) {
  if (presence.presenceType !== PresenceType.InGame) return false;
  return isTrackedGame(presence.universeId, presence.placeId) || isTrackedGame(null, presence.rootPlaceId);
}

/** Cheap credential check used at boot so a bad cookie is obvious in the logs. */
async function verifyCookie() {
  if (!config.roblox.cookie) return { ok: false, reason: 'ROBLOX_COOKIE is not set' };
  try {
    const response = await request('https://users.roblox.com/v1/users/authenticated', {
      headers: { Cookie: `.ROBLOSECURITY=${config.roblox.cookie}`, Accept: 'application/json' },
      retries: 1,
    });
    const body = (await response.json());
    return { ok: true, username: body.name ?? 'unknown' };
  } catch (error) {
    const reason = error instanceof HttpError && error.status === 401 ? 'cookie is invalid or expired' : String(error);
    return { ok: false, reason };
  }
}

module.exports = { PresenceType, fetchPresences, isTrackedPresence, verifyCookie };
