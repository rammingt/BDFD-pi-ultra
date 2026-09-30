'use strict';
const { isTrackedPresence, PresenceType } = require('../roblox/presence');
const { isAnyGameType } = require('./types');

/**
 * Decides whether a shift of this type may be opened from what Roblox is willing to
 * say about the member right now. Any-game types take whatever game they are in;
 * every other type has to be one of the tracked ones.
 */
function evaluateStart(
  type,
  status,
  presence,
) {
  if (status === 'hidden') return { allowed: false, refusal: 'hidden' };
  if (!presence || presence.presenceType !== PresenceType.InGame) {
    return { allowed: false, refusal: 'not_in_game' };
  }
  if (!isAnyGameType(type) && !isTrackedPresence(presence)) {
    return { allowed: false, refusal: 'untracked_game' };
  }

  return {
    allowed: true,
    universeId: presence.universeId,
    placeId: presence.placeId ?? presence.rootPlaceId,
  };
}

module.exports = { evaluateStart };
