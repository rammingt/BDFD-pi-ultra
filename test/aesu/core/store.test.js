'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { makeShift, withStore } = require('./helpers');

function link(overrides = {}) {
  const now = Date.now();
  return {
    discordId: 'u1',
    robloxId: '777',
    robloxUsername: 'tester',
    robloxDisplayName: 'Tester',
    accessToken: 'at',
    refreshToken: 'rt',
    tokenExpiresAt: now + 3_600_000,
    linkedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function watchState(overrides = {}) {
  return {
    discordId: 'u1',
    sessionKey: 'abc',
    universeId: '111',
    placeId: '222',
    gameName: 'Test Game',
    lastSeenInGameAt: Date.now(),
    missingSince: null,
    promptStatus: 'sent',
    promptSentAt: Date.now(),
    promptChannelId: 'c1',
    promptMessageId: 'm1',
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('JsonStore', () => {
  it('round-trips a Roblox link', async () => {
    await withStore(async (store) => {
      await store.upsertLink(link());
      assert.equal((await store.getLinkByDiscordId('u1'))?.robloxUsername, 'tester');
      assert.equal((await store.getLinkByRobloxId('777'))?.discordId, 'u1');
      assert.equal((await store.listLinks()).length, 1);

      const removed = await store.deleteLink('u1');
      assert.equal(removed?.robloxId, '777');
      assert.equal(await store.getLinkByDiscordId('u1'), null);
    });
  });

  it('moves a Roblox account when it is linked from another Discord account', async () => {
    await withStore(async (store) => {
      await store.upsertLink(link({ discordId: 'u1' }));
      await store.upsertLink(link({ discordId: 'u2' }));

      assert.equal(await store.getLinkByDiscordId('u1'), null, 'the old link is dropped');
      assert.equal((await store.getLinkByRobloxId('777'))?.discordId, 'u2');
      assert.equal((await store.listLinks()).length, 1);
    });
  });

  it('consumes an OAuth state exactly once and purges expired ones', async () => {
    await withStore(async (store) => {
      const now = Date.now();
      await store.createOAuthState({
        state: 'state-1',
        discordId: 'u1',
        guildId: 'g1',
        codeVerifier: 'verifier',
        createdAt: now,
        expiresAt: now + 60_000,
      });
      await store.createOAuthState({
        state: 'state-old',
        discordId: 'u2',
        guildId: null,
        codeVerifier: 'verifier',
        createdAt: now - 120_000,
        expiresAt: now - 60_000,
      });

      assert.equal((await store.consumeOAuthState('state-1'))?.codeVerifier, 'verifier');
      assert.equal(await store.consumeOAuthState('state-1'), null, 'a state cannot be replayed');

      await store.purgeExpiredOAuthStates(now);
      assert.equal(await store.consumeOAuthState('state-old'), null);
    });
  });

  it('reports the newest unconsumed OAuth state per member', async () => {
    await withStore(async (store) => {
      const now = Date.now();
      assert.equal(await store.latestOAuthState('u1'), null, 'nothing pending before /connect');

      await store.createOAuthState({
        state: 'older',
        discordId: 'u1',
        guildId: null,
        codeVerifier: 'v1',
        createdAt: now - 60_000,
        expiresAt: now + 60_000,
      });
      await store.createOAuthState({
        state: 'newer',
        discordId: 'u1',
        guildId: null,
        codeVerifier: 'v2',
        createdAt: now,
        expiresAt: now + 120_000,
      });
      await store.createOAuthState({
        state: 'other-member',
        discordId: 'u2',
        guildId: null,
        codeVerifier: 'v3',
        createdAt: now,
        expiresAt: now + 120_000,
      });

      assert.equal((await store.latestOAuthState('u1'))?.state, 'newer');
      assert.equal((await store.latestOAuthState('u2'))?.state, 'other-member');

      // A completed callback consumes the state, which is what clears the warning.
      await store.consumeOAuthState('newer');
      assert.equal((await store.latestOAuthState('u1'))?.state, 'older');
    });
  });

  it('filters shift history by range, type and open state', async () => {
    await withStore(async (store) => {
      const now = Date.now();
      await store.createShift(makeShift({ id: 's1', startedAt: now - 10_000, endedAt: now, type: 'shift_guard' }));
      await store.createShift(
        makeShift({ id: 's2', startedAt: now - 10 * 86_400_000, endedAt: now - 9 * 86_400_000, type: 'deployment' }),
      );
      await store.createShift(
        makeShift({ id: 's3', startedAt: now - 5_000, endedAt: null, endReason: null, status: 'active' }),
      );

      assert.deepEqual((await store.listShifts('user-1')).map((shift) => shift.id), ['s1', 's2']);
      assert.deepEqual(
        (await store.listShifts('user-1', { includeOpen: true })).map((shift) => shift.id),
        ['s3', 's1', 's2'],
        'newest first',
      );
      assert.deepEqual(
        (await store.listShifts('user-1', { since: now - 86_400_000 })).map((shift) => shift.id),
        ['s1'],
      );
      assert.deepEqual(
        (await store.listShifts('user-1', { type: 'deployment' })).map((shift) => shift.id),
        ['s2'],
      );
      assert.equal((await store.listShifts('user-1', { limit: 1 })).length, 1);
      assert.equal((await store.getOpenShift('user-1'))?.id, 's3');
    });
  });

  it('round-trips watch state', async () => {
    await withStore(async (store) => {
      await store.upsertWatchState(watchState());
      assert.equal((await store.getWatchState('u1'))?.sessionKey, 'abc');

      await store.upsertWatchState(watchState({ sessionKey: null, promptStatus: 'none', promptSentAt: null }));
      assert.equal((await store.getWatchState('u1'))?.sessionKey, null);

      await store.deleteWatchState('u1');
      assert.equal(await store.getWatchState('u1'), null);
    });
  });
});
