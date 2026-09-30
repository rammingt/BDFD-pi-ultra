'use strict';
const { config } = require('../config/index');
const { fetchPresences, PresenceType } = require('./presence');

/**
 * - `visible`: Roblox told us which game the member is in, so tracking works.
 * - `hidden`: Roblox says they are in a game but refuses to name it, which only
 *   happens when their join status is restricted from the tracking account.
 * - `unknown`: they are not in a game, so there is nothing to hide yet.
 */

const VISIBILITY_HINT =
  'Roblox is not telling the bot which game you are in, so your shifts and event attendance cannot be ' +
  'tracked. On the Roblox account you play on, open **Settings > Privacy** and set ' +
  '**Who can see my join status** to **Everyone**. Adding the tracking account as a friend works too.';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function classifyVisibility(presence) {
  if (!presence || presence.presenceType !== PresenceType.InGame) return 'unknown';
  return presence.universeId ?? presence.placeId ?? presence.rootPlaceId ? 'visible' : 'hidden';
}

/**
 * Answers whether the tracking account can see this member's game location.
 * Cached briefly so running several commands in a row does not hammer Roblox;
 * pass `fresh` when a stale answer would block something, such as somebody who
 * joined the game seconds ago trying to start a shift.
 */
async function checkJoinVisibility(
  robloxId,
  options = {},
) {
  if (!config.roblox.cookie) return { status: 'unknown', presence: null };

  const now = Date.now();
  const cached = cache.get(robloxId);
  if (!options.fresh && cached && cached.expiresAt > now) return cached.result;

  let presence;
  try {
    presence = (await fetchPresences([robloxId])).get(robloxId) ?? null;
  } catch {
    // A failed lookup proves nothing, and caching it would hide a later recovery.
    return { status: 'unknown', presence: null };
  }

  const result = { status: classifyVisibility(presence), presence };
  cache.set(robloxId, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

function clearVisibilityCache() {
  cache.clear();
}

module.exports = { VISIBILITY_HINT, classifyVisibility, checkJoinVisibility, clearVisibilityCache };
