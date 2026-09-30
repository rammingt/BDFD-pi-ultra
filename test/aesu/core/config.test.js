'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// config/ reads process.env at import time, so set everything before importing it.
process.env.DISCORD_TOKEN = 'token';
process.env.DISCORD_CLIENT_ID = '123';
process.env.TRACKED_UNIVERSE_IDS = '111, 222;333 444';
process.env.TRACKED_PLACE_IDS = '999,not-an-id,999';
process.env.PUBLIC_BASE_URL = 'https://shift.example.com/';
process.env.PRESENCE_POLL_INTERVAL_SECONDS = '5';
process.env.MAX_SHIFT_HOURS = 'nonsense';

const { config, inspectConfig, isTrackedGame } = require('../../../src/aesu/config/index');

describe('config parsing', () => {
  it('accepts commas, spaces and semicolons in id lists and drops junk', () => {
    assert.deepEqual(config.tracking.universeIds, ['111', '222', '333', '444']);
    assert.deepEqual(config.tracking.placeIds, ['999'], 'non-numeric entries and duplicates are dropped');
  });

  it('derives the OAuth redirect URI from PUBLIC_BASE_URL without a double slash', () => {
    assert.equal(config.roblox.redirectUri, 'https://shift.example.com/oauth/callback');
  });

  it('clamps out-of-range numbers and falls back on unparsable ones', () => {
    assert.equal(config.tracking.pollIntervalSeconds, 10, 'clamped up to the minimum');
    assert.equal(config.tracking.maxShiftHours, 12, 'fell back to the default');
  });

  it('matches tracked games by universe or place id', () => {
    assert.equal(isTrackedGame('222', null), true);
    assert.equal(isTrackedGame(null, '999'), true);
    assert.equal(isTrackedGame('555', '888'), false);
    assert.equal(isTrackedGame(null, null), false);
  });

  it('reports missing optional settings as warnings, not fatal errors', () => {
    const issues = inspectConfig();
    assert.equal(issues.some((issue) => issue.fatal), false);
    assert.ok(issues.some((issue) => issue.variable.startsWith('ROBLOX_CLIENT_ID')));
  });
});
