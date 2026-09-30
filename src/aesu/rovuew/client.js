'use strict';
const { config } = require('../config/index');
const { HttpError, describeNetworkError, request } = require('../util/http');
const { createLogger } = require('../util/logger');

const log = createLogger('rovuew');

/** RoVuew's own per-key cooldown, so a second click is refused rather than queued. */
const COOLDOWN_SECONDS = 20;

/** One reputation provider's answer, as RoVuew's behaviourApis normalises them. */

/** The subset of RoVuew's /fullcheck payload this bot reads. */

/** RoVuew is part of BDX, so a background check can always run. */
function isRovuewConfigured() {
  return true;
}

function isRemote() {
  return Boolean(config.rovuew.baseUrl && config.rovuew.apiKey);
}

/** The flagged item from a match, whichever way RoVuew wrapped it. */
function flatten(match) {
  const flag = match?.flag ?? match ?? {};
  let score = flag.score;
  try { score = require('../../rovuew/storage').flagScore(flag); } catch { /* not a flag entry */ }
  return {
    name: flag.name ?? match?.name,
    assetId: flag.assetId ?? match?.assetId,
    score: typeof score === 'number' ? score : match?.score,
    reason: flag.reason ?? (Array.isArray(match?.reasons) ? match.reasons.join('; ') : match?.reason),
  };
}

/** Matches come back as { flag }, which the report wants as plain items. */
function normalise(result) {
  const out = { ...result };
  for (const key of ['accessoryMatches', 'clothingMatches', 'badgeMatches', 'autoMatches']) {
    if (Array.isArray(result[key])) out[key] = result[key].map(flatten);
  }
  return out;
}

/** Runs the check in this process, with the flag list BDX already has. */
async function localCheck(robloxUser, discordUserId) {
  try {
    const result = await require('../../rovuew/checkService').fullCheck(robloxUser, { discordUserId });
    if (result.error === 'user_not_found') return { status: 'not_found' };
    return { status: 'ok', result: normalise(result) };
  } catch (error) {
    return { status: 'failed', reason: `The check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Asks RoVuew for everything it knows about somebody: flagged items from their
 * Roblox inventory, and their record with the reputation APIs it fronts.
 *
 * Passing the Discord id matters - the Discord-side provider is keyed by it, and
 * without one that half of the check silently does not run.
 */
async function fullCheck(
  robloxUser,
  discordUserId = null,
) {
  if (!isRemote()) return localCheck(robloxUser, discordUserId);

  const base = config.rovuew.baseUrl.replace(/\/+$/, '');
  const query = discordUserId ? `?discord=${encodeURIComponent(discordUserId)}` : '';
  const url = `${base}/fullcheck/${encodeURIComponent(robloxUser)}${query}`;

  try {
    const response = await request(url, {
      headers: { 'x-api-key': config.rovuew.apiKey, Accept: 'application/json' },
      // A full check fans out to Roblox and two or three reputation APIs, so it is
      // slower than anything else this bot calls.
      timeoutMs: 45_000,
      // Never retried: RoVuew rate limits per key, so a retry burns the cooldown
      // and comes back 429 rather than succeeding.
      retries: 0,
    });

    return { status: 'ok', result: normalise(await response.json()) };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      // Name the address as well as the reason: the usual cause is ROVUEW_BASE_URL
      // pointing somewhere nothing is deployed, and that is invisible otherwise.
      return { status: 'failed', reason: `Could not reach RoVuew at ${base} - ${describeNetworkError(error)}.` };
    }

    if (error.status === 404) return { status: 'not_found' };
    if (error.status === 429) {
      const body = safeJson(error.body);
      return { status: 'rate_limited', message: body?.error ?? `Try again in ${COOLDOWN_SECONDS}s.` };
    }
    if (error.status === 401) {
      log.warn('RoVuew rejected the API key');
      return { status: 'failed', reason: 'RoVuew rejected `ROVUEW_API_KEY`.' };
    }

    return { status: 'failed', reason: safeJson(error.body)?.error ?? `RoVuew returned HTTP ${error.status}.` };
  }
}

function safeJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

module.exports = { COOLDOWN_SECONDS, isRovuewConfigured, fullCheck };
