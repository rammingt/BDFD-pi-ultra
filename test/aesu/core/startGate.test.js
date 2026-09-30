'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.TRACKED_UNIVERSE_IDS = '111';
process.env.TRACKED_PLACE_IDS = '222';
process.env.LOG_LEVEL = 'error';

const { evaluateStart } = require('../../../src/aesu/shifts/startGate');
const { isAnyGameType } = require('../../../src/aesu/shifts/types');

function presence(fields) {
  return {
    userId: '777',
    presenceType: 2,
    universeId: null,
    placeId: null,
    rootPlaceId: null,
    gameId: null,
    lastLocation: null,
    ...fields,
  };
}

const TRACKED = presence({ universeId: '111', placeId: '333', lastLocation: 'Aesu HQ' });
const UNTRACKED = presence({ universeId: '999', placeId: '888', lastLocation: 'Random Obby' });

describe('isAnyGameType', () => {
  it('covers game night and nothing else by default', () => {
    assert.equal(isAnyGameType('game_night'), true);
    assert.equal(isAnyGameType('shift_guard'), false);
    assert.equal(isAnyGameType('deployment'), false);
  });
});

describe('evaluateStart', () => {
  it('allows an ordinary shift inside a tracked game', () => {
    assert.deepEqual(evaluateStart('shift_guard', 'visible', TRACKED), {
      allowed: true,
      universeId: '111',
      placeId: '333',
    });
  });

  it('matches a tracked game by its root place too', () => {
    const hop = presence({ universeId: '999', placeId: '444', rootPlaceId: '222' });
    assert.equal(evaluateStart('shift_guard', 'visible', hop).allowed, true);
  });

  it('refuses an ordinary shift in a game that is not tracked', () => {
    assert.deepEqual(evaluateStart('shift_guard', 'visible', UNTRACKED), {
      allowed: false,
      refusal: 'untracked_game',
    });
  });

  it('lets a game night run in any game, and records which one', () => {
    assert.deepEqual(evaluateStart('game_night', 'visible', UNTRACKED), {
      allowed: true,
      universeId: '999',
      placeId: '888',
    });
  });

  it('refuses anybody who is not in a game', () => {
    for (const type of ['shift_guard', 'game_night']) {
      assert.deepEqual(evaluateStart(type, 'unknown', presence({ presenceType: 1 })), {
        allowed: false,
        refusal: 'not_in_game',
      });
      assert.deepEqual(evaluateStart(type, 'unknown', null), { allowed: false, refusal: 'not_in_game' });
    }
  });

  it('refuses a hidden join status, game night included', () => {
    const concealed = presence({});
    assert.deepEqual(evaluateStart('shift_guard', 'hidden', concealed), { allowed: false, refusal: 'hidden' });
    assert.deepEqual(
      evaluateStart('game_night', 'hidden', concealed),
      { allowed: false, refusal: 'hidden' },
      'the bot cannot name the game it cannot see',
    );
  });
});
