'use strict';
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

// Config is read at import time, so the environment has to be set first.
process.env.EVENT_MIN_ATTENDANCE_MINUTES = '1';
process.env.EVENT_TIMEZONE = 'UTC';
process.env.MAX_SHIFT_HOURS = '12';
process.env.EVENT_MAX_HOURS = '12';
process.env.LEAVE_GRACE_SECONDS = '0';
process.env.LOG_LEVEL = 'error';

const { JsonStore } = require('../../../src/aesu/db/jsonStore');
const { EventManager } = require('../../../src/aesu/events/manager');
const {
  DECLINED_ROLE_KEY,
  EventInputError,
  parseRoles,
  parseStartTime,
  totalAttendance,
} = require('../../../src/aesu/events/types');
const { ShiftManager } = require('../../../src/aesu/shifts/manager');
const { classifyVisibility } = require('../../../src/aesu/roblox/visibility');
const { makeShift } = require('./helpers');

const MINUTE = 60_000;

/** In the tracked game, which is what every event except a game night counts. */
function atHq(present = true) {
  return present
    ? { inTrackedGame: true, inAnyGame: true, universeId: '111', placeId: '222', gameName: 'Aesu HQ' }
    : { inTrackedGame: false, inAnyGame: false, universeId: null, placeId: null, gameName: null };
}

/** In some other Roblox game entirely. */
function elsewhere() {
  return { inTrackedGame: false, inAnyGame: true, universeId: '999', placeId: '888', gameName: 'Random Obby' };
}

function saw(entries) {
  return new Map(Object.entries(entries));
}

describe('parseRoles', () => {
  it('reads labels and optional limits', () => {
    assert.deepEqual(parseRoles('Guard:8, Medic:2, Spectator'), [
      { key: 'guard', label: 'Guard', limit: 8 },
      { key: 'medic', label: 'Medic', limit: 2 },
      { key: 'spectator', label: 'Spectator', limit: null },
    ]);
  });

  it('slugs labels with punctuation in them', () => {
    assert.deepEqual(parseRoles('Front Line (HR)'), [{ key: 'front-line-hr', label: 'Front Line (HR)', limit: null }]);
  });

  it('rejects duplicates, the reserved option and an empty list', () => {
    assert.throws(() => parseRoles('Guard, guard'), EventInputError);
    assert.throws(() => parseRoles('Declined'), EventInputError);
    assert.throws(() => parseRoles('   '), EventInputError);
    assert.throws(() => parseRoles(Array.from({ length: 11 }, (_, i) => `Role ${i}`).join(', ')), EventInputError);
  });
});

describe('parseStartTime', () => {
  const now = Date.UTC(2026, 4, 10, 12, 0);

  it('handles now and relative offsets', () => {
    assert.equal(parseStartTime('now', 'UTC', now), now);
    assert.equal(parseStartTime('2h', 'UTC', now), now + 2 * 60 * MINUTE);
    assert.equal(parseStartTime('in 90m', 'UTC', now), now + 90 * MINUTE);
    assert.equal(parseStartTime('1h30m', 'UTC', now), now + 90 * MINUTE);
    assert.equal(parseStartTime('1d', 'UTC', now), now + 24 * 60 * MINUTE);
  });

  it('reads absolute times in the event timezone', () => {
    // Seoul is UTC+9 all year round.
    assert.equal(parseStartTime('2026-03-01 09:00', 'Asia/Seoul', now), Date.UTC(2026, 2, 1, 0, 0));
    assert.equal(parseStartTime('2026-03-01 09:00', 'UTC', now), Date.UTC(2026, 2, 1, 9, 0));
  });

  it('rolls a bare clock time forward when it has already passed', () => {
    assert.equal(parseStartTime('18:00', 'UTC', now), Date.UTC(2026, 4, 10, 18, 0));
    assert.equal(parseStartTime('09:00', 'UTC', now), Date.UTC(2026, 4, 11, 9, 0));
  });

  it('refuses anything it cannot read', () => {
    assert.throws(() => parseStartTime('next tuesday-ish', 'UTC', now), EventInputError);
  });
});

describe('classifyVisibility', () => {
  it('only calls out a member Roblox is actively hiding', () => {
    assert.equal(classifyVisibility(null), 'unknown');
    assert.equal(classifyVisibility({ presenceType: 1 }), 'unknown', 'online but not in a game');
    assert.equal(classifyVisibility({ presenceType: 2, universeId: '111' }), 'visible');
    assert.equal(
      classifyVisibility({ presenceType: 2, universeId: null, placeId: null, rootPlaceId: null }),
      'hidden',
    );
  });
});

describe('EventManager', () => {
  let dir;
  let store;
  let shifts;
  let events;
  let t0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shift-tracker-events-'));
    store = new JsonStore(join(dir, 'data.json'));
    await store.init();
    shifts = new ShiftManager(store);
    events = new EventManager(store, shifts);
    t0 = Date.now();
  });

  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const createEvent = (startsAt = t0, shiftType = 'deployment') =>
    events.create(
      {
        guildId: 'guild-1',
        hostId: 'host-1',
        name: 'Operation Dam',
        details: 'Bring a hard hat.',
        imageUrl: null,
        shiftType,
        startsAt,
        roles: parseRoles('Guard:2, Medic'),
      },
      t0,
    );

  it('counts the events somebody has hosted, and the ones still on', async () => {
    assert.deepEqual(await events.hostedCount('host-1'), { hosted: 0, live: 0 });

    const finished = await createEvent(t0);
    await events.finish(finished.id, t0 + 30 * MINUTE);
    assert.deepEqual(await events.hostedCount('host-1'), { hosted: 1, live: 0 });

    await createEvent(t0 + 60 * MINUTE);
    assert.deepEqual(
      await events.hostedCount('host-1'),
      { hosted: 1, live: 1 },
      'one run to the end, one still to come',
    );

    const called_off = await createEvent(t0);
    await events.cancel(called_off.id);
    assert.deepEqual(
      await events.hostedCount('host-1'),
      { hosted: 1, live: 1 },
      'a cancelled event is not an event they hosted',
    );

    assert.deepEqual(await events.hostedCount('somebody-else'), { hosted: 0, live: 0 });
  });

  it('starts straight away when scheduled for now, and waits otherwise', async () => {
    const running = await createEvent(t0);
    assert.equal(running.status, 'running');
    assert.equal(running.endsAt, null, 'it runs until the host ends it');
    assert.equal((await createEvent(t0 + 60 * MINUTE)).status, 'scheduled');
  });

  it('banks the time an attendee was actually in game', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 10 * MINUTE);

    const ended = await events.finish(event.id, t0 + 20 * MINUTE);
    assert.equal(ended?.status, 'ended');
    assert.equal(ended?.endsAt, t0 + 20 * MINUTE, 'the end time is stamped when the host stops it');

    const [shift] = await shifts.listShifts('discord-1');
    assert.ok(shift, 'attendance was logged as a shift');
    assert.equal(shift.type, 'deployment');
    assert.equal(shift.source, 'event');
    assert.equal(shift.endReason, 'event_ended');
    assert.equal((shift.endedAt ?? 0) - shift.startedAt, 10 * MINUTE);

    const [signup] = await events.listSignups(event.id);
    assert.equal(signup?.shiftId, shift.id);
    assert.equal(signup?.attendedMs, 10 * MINUTE);
  });

  it('does not count the gap after somebody was last seen in game', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 5 * MINUTE);
    await events.recordAttendance(saw({ 'discord-1': atHq(false) }), t0 + 6 * MINUTE);
    // Away for a while, then back for another stretch.
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 30 * MINUTE);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 33 * MINUTE);

    await events.finish(event.id, t0 + 40 * MINUTE);

    const [shift] = await shifts.listShifts('discord-1');
    assert.equal((shift?.endedAt ?? 0) - (shift?.startedAt ?? 0), 8 * MINUTE, '5 minutes plus 3, not the gap between');
  });

  it('leaves presence it was told nothing about alone', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    // A poll that did not include this member at all must not end their stretch.
    await events.recordAttendance(saw({ 'discord-2': atHq() }), t0 + 5 * MINUTE);

    const signup = await store.getSignup(event.id, 'discord-1');
    assert.equal(signup?.presentSince, t0);
    assert.equal(signup?.attendedMs, 0);
    assert.equal(totalAttendance(signup, t0 + 5 * MINUTE), 0, 'nothing is banked past the last sighting');
  });

  it('does not log time a member already banked on their own shift', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await store.createShift(
      makeShift({ discordId: 'discord-1', startedAt: t0, endedAt: t0 + 20 * MINUTE, endReason: 'left_game' }),
    );

    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 10 * MINUTE);
    await events.finish(event.id, t0 + 20 * MINUTE);

    assert.equal((await shifts.listShifts('discord-1')).length, 1, 'no second record for the same time');
    assert.equal((await store.getSignup(event.id, 'discord-1'))?.shiftId, null);
  });

  it('ignores anybody who said they could not make it', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', DECLINED_ROLE_KEY, '777');

    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 10 * MINUTE);
    await events.finish(event.id, t0 + 20 * MINUTE);

    assert.equal((await shifts.listShifts('discord-1')).length, 0);
  });

  it('enforces the limit the host set on a role', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '1');
    await events.signUp(event.id, 'discord-2', 'guard', '2');

    await assert.rejects(() => events.signUp(event.id, 'discord-3', 'guard', '3'), EventInputError);
    // The uncapped role is still open, and moving off a full role frees a place.
    await events.signUp(event.id, 'discord-3', 'medic', '3');
    await events.signUp(event.id, 'discord-1', DECLINED_ROLE_KEY, '1');
    await events.signUp(event.id, 'discord-3', 'guard', '3');

    const signups = await events.listSignups(event.id);
    assert.equal(signups.filter((signup) => signup.roleKey === 'guard').length, 2);
  });

  it('rejects sign-ups once the event is over, and refuses to end twice', async () => {
    const event = await createEvent();
    await events.finish(event.id, t0 + 10 * MINUTE);

    await assert.rejects(() => events.signUp(event.id, 'discord-1', 'guard', '1'), EventInputError);
    assert.equal(await events.finish(event.id, t0 + 20 * MINUTE), null);
  });

  it('cancels without banking anything', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '777');
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 10 * MINUTE);

    assert.equal((await events.cancel(event.id, t0 + 11 * MINUTE))?.status, 'cancelled');
    assert.equal((await shifts.listShifts('discord-1')).length, 0);
    assert.equal(await events.finish(event.id, t0 + 20 * MINUTE), null);
  });

  it('starts a due event on a tick and then leaves it running', async () => {
    const event = await createEvent(t0 + 10 * MINUTE);
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await events.tick(t0);
    assert.equal((await events.getEvent(event.id))?.status, 'scheduled');

    await events.tick(t0 + 10 * MINUTE);
    assert.equal((await events.getEvent(event.id))?.status, 'running');

    // Hours later it is still going, because only the host closes it.
    await events.tick(t0 + 6 * 60 * MINUTE);
    assert.equal((await events.getEvent(event.id))?.status, 'running');
  });

  it('closes an event the host forgot about once it passes the cap', async () => {
    const event = await createEvent();
    await events.signUp(event.id, 'discord-1', 'guard', '777');
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-1': atHq() }), t0 + 30 * MINUTE);

    await events.tick(t0 + 13 * 60 * MINUTE);

    const finished = await events.getEvent(event.id);
    assert.equal(finished?.status, 'ended');
    assert.equal(finished?.endsAt, t0 + 12 * 60 * MINUTE, 'banked at the cap, not whenever the tick ran');

    const [shift] = await shifts.listShifts('discord-1');
    assert.equal((shift?.endedAt ?? 0) - (shift?.startedAt ?? 0), 30 * MINUTE, 'only the time they were there');
  });

  it('counts any game for a game night event, and names it', async () => {
    const event = await createEvent(t0, 'game_night');
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await events.recordAttendance(saw({ 'discord-1': elsewhere() }), t0);
    await events.recordAttendance(saw({ 'discord-1': elsewhere() }), t0 + 10 * MINUTE);
    await events.finish(event.id, t0 + 15 * MINUTE);

    const [shift] = await shifts.listShifts('discord-1');
    assert.ok(shift, 'a game night counts time outside the tracked games');
    assert.equal((shift.endedAt ?? 0) - shift.startedAt, 10 * MINUTE);
    assert.equal(shift.type, 'game_night');
    assert.equal(shift.gameName, 'Random Obby', 'the record names the game they were actually in');
    assert.equal(shift.placeId, '888');
  });

  it('still ignores other games for an event that is not a game night', async () => {
    const event = await createEvent(t0, 'deployment');
    await events.signUp(event.id, 'discord-1', 'guard', '777');

    await events.recordAttendance(saw({ 'discord-1': elsewhere() }), t0);
    await events.recordAttendance(saw({ 'discord-1': elsewhere() }), t0 + 10 * MINUTE);
    await events.finish(event.id, t0 + 15 * MINUTE);

    assert.equal((await shifts.listShifts('discord-1')).length, 0, 'a deployment only counts the tracked game');
  });

  it('does not nag a game night host for being outside the tracked game', async () => {
    const event = await createEvent(t0, 'game_night');
    const nudges = [];
    events.onChange((change) => {
      if (change === 'host_away') nudges.push(change);
    });

    await events.recordAttendance(saw({ 'host-1': elsewhere() }), t0);
    await events.recordAttendance(saw({ 'host-1': elsewhere() }), t0 + MINUTE);
    await events.recordAttendance(saw({ 'host-1': elsewhere() }), t0 + 2 * MINUTE);

    assert.deepEqual(nudges, [], 'playing another game is the point of a game night');
    assert.equal((await events.getEvent(event.id))?.hostAwaySince, null);
  });

  it('nudges the host once when they leave the game, and again if they leave twice', async () => {
    const event = await createEvent();
    const nudges = [];
    events.onChange((change, changed) => {
      if (change === 'host_away') nudges.push(changed.id);
    });

    // In game: nothing to say.
    await events.recordAttendance(saw({ 'host-1': atHq() }), t0);
    assert.deepEqual(nudges, []);

    // First poll after leaving only opens the grace window.
    await events.recordAttendance(saw({ 'host-1': atHq(false) }), t0 + MINUTE);
    assert.deepEqual(nudges, []);
    assert.equal((await events.getEvent(event.id))?.hostAwaySince, t0 + MINUTE);

    await events.recordAttendance(saw({ 'host-1': atHq(false) }), t0 + 2 * MINUTE);
    assert.deepEqual(nudges, [event.id], 'the host is told the event is still running');

    // Still away - it must not repeat every poll.
    await events.recordAttendance(saw({ 'host-1': atHq(false) }), t0 + 3 * MINUTE);
    assert.deepEqual(nudges, [event.id]);

    // Back in game, then away again: the nudge is armed afresh.
    await events.recordAttendance(saw({ 'host-1': atHq() }), t0 + 4 * MINUTE);
    assert.equal((await events.getEvent(event.id))?.hostRemindedAt, null);
    await events.recordAttendance(saw({ 'host-1': atHq(false) }), t0 + 5 * MINUTE);
    await events.recordAttendance(saw({ 'host-1': atHq(false) }), t0 + 6 * MINUTE);
    assert.deepEqual(nudges, [event.id, event.id]);
  });

  it('says nothing about a host whose presence is unknown', async () => {
    const event = await createEvent();
    const nudges = [];
    events.onChange((change) => {
      if (change === 'host_away') nudges.push(change);
    });

    await events.recordAttendance(saw({ 'discord-9': atHq() }), t0);
    await events.recordAttendance(saw({ 'discord-9': atHq() }), t0 + 5 * MINUTE);

    assert.deepEqual(nudges, []);
    assert.equal((await events.getEvent(event.id))?.hostAwaySince, null);
  });
});
