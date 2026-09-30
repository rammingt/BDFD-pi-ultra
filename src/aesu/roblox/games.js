'use strict';
const { requestJson } = require('../util/http');
const { createLogger } = require('../util/logger');

const log = createLogger('roblox:games');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const universeNames = new Map();
const placeToUniverse = new Map();

/** Resolves universe ids to game names, with a long-lived cache (names rarely change). */
async function resolveUniverseNames(universeIds) {
  const now = Date.now();
  const resolved = new Map();
  const missing = [];

  for (const id of new Set(universeIds)) {
    const cached = universeNames.get(id);
    if (cached && cached.expiresAt > now) resolved.set(id, cached.name);
    else missing.push(id);
  }

  if (missing.length === 0) return resolved;

  try {
    const body = await requestJson(
      `https://games.roblox.com/v1/games?universeIds=${missing.join(',')}`,
      { retries: 1 },
    );
    for (const game of body.data ?? []) {
      const id = String(game.id);
      universeNames.set(id, { name: game.name, expiresAt: now + CACHE_TTL_MS });
      resolved.set(id, game.name);
    }
  } catch (error) {
    log.warn(`Could not resolve universe names: ${error instanceof Error ? error.message : String(error)}`);
  }

  return resolved;
}

async function resolveUniverseName(universeId) {
  if (!universeId) return null;
  const names = await resolveUniverseNames([universeId]);
  return names.get(universeId) ?? null;
}

/** Maps a place id to the universe that owns it, so TRACKED_PLACE_IDS and presence line up. */
async function resolveUniverseIdForPlace(placeId) {
  const now = Date.now();
  const cached = placeToUniverse.get(placeId);
  if (cached && cached.expiresAt > now) return cached.name;

  try {
    const body = await requestJson(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
      { retries: 1 },
    );
    if (body.universeId === null || body.universeId === undefined) return null;
    const universeId = String(body.universeId);
    placeToUniverse.set(placeId, { name: universeId, expiresAt: now + CACHE_TTL_MS });
    return universeId;
  } catch (error) {
    log.warn(`Could not resolve universe for place ${placeId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function robloxProfileUrl(robloxId) {
  return `https://www.roblox.com/users/${robloxId}/profile`;
}

function robloxGameUrl(placeId) {
  return placeId ? `https://www.roblox.com/games/${placeId}` : null;
}

module.exports = { resolveUniverseNames, resolveUniverseName, resolveUniverseIdForPlace, robloxProfileUrl, robloxGameUrl };
