'use strict';
const { config } = require('../config/index');
const { HttpError, describeNetworkError, request } = require('../util/http');
const { createLogger } = require('../util/logger');

const log = createLogger('rovuew');

/** RoVuew's own per-key cooldown, so a second click is refused rather than queued. */
const COOLDOWN_SECONDS = 20;

/** One reputation provider's answer, as RoVuew's behaviourApis normalises them. */

/** The subset of RoVuew's /fullcheck payload this bot reads. */

function isRovuewConfigured() {
  return Boolean(config.rovuew.baseUrl && config.rovuew.apiKey);
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
  if (!isRovuewConfigured()) return { status: 'off' };

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

    return { status: 'ok', result: (await response.json()) };
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
