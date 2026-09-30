'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { computeDurations, ShiftError, ShiftManager } = require('../../../src/aesu/shifts/manager');

const { makeShift, withStore } = require('./helpers');

const HOUR = 3_600_000;

describe('ShiftManager', () => {
  it('runs a shift through start, break, resume and end', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      const changes = [];
      manager.onChange((change) => {
        changes.push(change);
      });

      const started = await manager.start({
        discordId: 'u1',
        guildId: 'g1',
        type: 'solo_shift',
        source: 'panel',
        gameName: 'Test Game',
      });
      assert.equal(started.status, 'active');
      assert.equal(started.breakCount, 0);

      const onBreak = await manager.startBreak('u1');
      assert.equal(onBreak.status, 'on_break');
      assert.equal(onBreak.breakCount, 1);
      assert.ok(onBreak.breakStartedAt !== null);

      const resumed = await manager.endBreak('u1');
      assert.equal(resumed.status, 'active');
      assert.equal(resumed.breakStartedAt, null);
      assert.ok(resumed.breakMs >= 0);

      const ended = await manager.end('u1', 'manual');
      assert.equal(ended.status, 'ended');
      assert.equal(ended.endReason, 'manual');
      assert.ok(ended.endedAt !== null);

      assert.deepEqual(changes, ['started', 'break_started', 'break_ended', 'ended']);
      assert.equal(await manager.getOpenShift('u1'), null);
    });
  });

  it('refuses to start a second shift for the same member', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      await manager.start({ discordId: 'u1', guildId: null, type: 'shift_guard', source: 'panel' });
      await assert.rejects(
        () => manager.start({ discordId: 'u1', guildId: null, type: 'game_night', source: 'panel' }),
        ShiftError,
      );
    });
  });

  it('keeps different members independent', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      await manager.start({ discordId: 'u1', guildId: null, type: 'shift_guard', source: 'panel' });
      await manager.start({ discordId: 'u2', guildId: null, type: 'deployment', source: 'prompt' });

      assert.equal((await manager.listOpenShifts()).length, 2);
      await manager.end('u1', 'manual');
      assert.equal((await manager.listOpenShifts()).length, 1);
      assert.equal((await manager.getOpenShift('u2'))?.type, 'deployment');
    });
  });

  it('rejects break transitions that do not make sense', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      await assert.rejects(() => manager.startBreak('nobody'), ShiftError);
      await manager.start({ discordId: 'u1', guildId: null, type: 'shift_guard', source: 'panel' });
      await assert.rejects(() => manager.endBreak('u1'), ShiftError);
      await manager.startBreak('u1');
      await assert.rejects(() => manager.startBreak('u1'), ShiftError);
    });
  });

  it('closes an open break when the shift ends', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      const started = await manager.start({ discordId: 'u1', guildId: null, type: 'solo_shift', source: 'panel' });
      await manager.startBreak('u1');

      const ended = await manager.endIfOpen('u1', 'left_game', started.startedAt + HOUR);
      assert.ok(ended);
      assert.equal(ended.status, 'ended');
      assert.equal(ended.breakStartedAt, null);
      assert.equal(ended.endReason, 'left_game');
      // Practically the whole hour was break time, so nothing meaningful is banked.
      const { workedMs, breakMs } = computeDurations(ended);
      assert.ok(workedMs < 1_000, `expected almost no worked time, got ${workedMs}ms`);
      assert.ok(breakMs > HOUR - 1_000, `expected the hour to count as break, got ${breakMs}ms`);
    });
  });

  it('backdates an auto-end to when the member was last seen in game', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      const started = await manager.start({ discordId: 'u1', guildId: null, type: 'shift_guard', source: 'prompt' });
      const leftAt = started.startedAt + 2 * HOUR;

      const ended = await manager.endIfOpen('u1', 'left_game', leftAt);
      assert.ok(ended);
      assert.equal(ended.endedAt, leftAt);
      assert.equal(computeDurations(ended).workedMs, 2 * HOUR);
    });
  });

  it('endIfOpen is a no-op when nothing is running', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      assert.equal(await manager.endIfOpen('u1', 'left_game'), null);
    });
  });

  it('sweeps shifts that ran past the maximum length', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      const stale = makeShift({
        id: 'stale',
        discordId: 'u1',
        status: 'active',
        endedAt: null,
        endReason: null,
        startedAt: Date.now() - 48 * HOUR,
      });
      const fresh = makeShift({
        id: 'fresh',
        discordId: 'u2',
        status: 'active',
        endedAt: null,
        endReason: null,
        startedAt: Date.now() - HOUR,
      });
      await store.createShift(stale);
      await store.createShift(fresh);

      const closed = await manager.sweepStaleShifts();
      assert.equal(closed.length, 1);
      assert.equal(closed[0]?.endReason, 'max_duration');
      assert.equal(await manager.getOpenShift('u1'), null);
      assert.ok(await manager.getOpenShift('u2'), 'a shift inside the limit is left alone');
    });
  });

  it('serialises concurrent starts so only one shift is created', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      const results = await Promise.allSettled([
        manager.start({ discordId: 'u1', guildId: null, type: 'shift_guard', source: 'panel' }),
        manager.start({ discordId: 'u1', guildId: null, type: 'game_night', source: 'panel' }),
        manager.start({ discordId: 'u1', guildId: null, type: 'deployment', source: 'panel' }),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal((await manager.listOpenShifts()).length, 1);
    });
  });

  it('backfills the game a shift is being worked in', async () => {
    await withStore(async (store) => {
      const manager = new ShiftManager(store);
      const started = await manager.start({ discordId: 'u1', guildId: null, type: 'shift_guard', source: 'panel' });
      assert.equal(started.gameName, null);

      await manager.attachGameContext(started.id, { universeId: '99', placeId: '88', gameName: 'Aesu HQ' });
      const open = await manager.getOpenShift('u1');
      assert.equal(open?.gameName, 'Aesu HQ');
      assert.equal(open?.universeId, '99');
    });
  });
});
