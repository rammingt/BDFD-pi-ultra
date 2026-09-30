'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { computeDurations, summarise } = require('../../../src/aesu/shifts/manager');
const { formatDuration, formatHours } = require('../../../src/aesu/util/time');
const { makeShift } = require('./helpers');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('computeDurations', () => {
  it('counts wall-clock time for a finished shift with no breaks', () => {
    const shift = makeShift({ startedAt: 0, endedAt: 2 * HOUR });
    const { elapsedMs, breakMs, workedMs } = computeDurations(shift);
    assert.equal(elapsedMs, 2 * HOUR);
    assert.equal(breakMs, 0);
    assert.equal(workedMs, 2 * HOUR);
  });

  it('subtracts completed breaks from worked time', () => {
    const shift = makeShift({ startedAt: 0, endedAt: 2 * HOUR, breakMs: 30 * MINUTE, breakCount: 1 });
    const { workedMs, breakMs } = computeDurations(shift);
    assert.equal(breakMs, 30 * MINUTE);
    assert.equal(workedMs, 90 * MINUTE);
  });

  it('counts a break that is still running against the current moment', () => {
    const now = 3 * HOUR;
    const shift = makeShift({
      status: 'on_break',
      startedAt: 0,
      endedAt: null,
      breakStartedAt: 2 * HOUR,
      breakCount: 1,
    });
    const { elapsedMs, breakMs, workedMs } = computeDurations(shift, now);
    assert.equal(elapsedMs, 3 * HOUR);
    assert.equal(breakMs, HOUR);
    assert.equal(workedMs, 2 * HOUR);
  });

  it('never reports negative or over-long numbers', () => {
    const shift = makeShift({ startedAt: 0, endedAt: HOUR, breakMs: 5 * HOUR });
    const { workedMs, breakMs } = computeDurations(shift);
    assert.equal(workedMs, 0);
    assert.equal(breakMs, HOUR, 'break time is capped at the elapsed time');
  });
});

describe('summarise', () => {
  it('counts a type that is no longer configured', () => {
    const totals = summarise([makeShift({ startedAt: 0, endedAt: HOUR, type: 'retired_type' })]);
    assert.equal(totals.byType.retired_type?.count, 1);
    assert.equal(totals.workedMs, HOUR);
  });

  it('totals shifts and splits them by type', () => {
    const totals = summarise([
      makeShift({ startedAt: 0, endedAt: HOUR, type: 'shift_guard' }),
      makeShift({ startedAt: HOUR, endedAt: 3 * HOUR, type: 'deployment' }),
      makeShift({ startedAt: 4 * HOUR, endedAt: 5 * HOUR, type: 'shift_guard', breakMs: 15 * MINUTE }),
    ]);

    assert.equal(totals.shiftCount, 3);
    assert.equal(totals.workedMs, HOUR + 2 * HOUR + 45 * MINUTE);
    assert.equal(totals.breakMs, 15 * MINUTE);
    assert.equal(totals.byType.shift_guard?.count, 2);
    assert.equal(totals.byType.shift_guard?.workedMs, HOUR + 45 * MINUTE);
    assert.equal(totals.byType.deployment?.count, 1);
    assert.equal(totals.byType.game_night?.count, 0, 'a configured type with no shifts still shows up');
    assert.equal(totals.longestMs, 2 * HOUR);
    assert.equal(totals.firstStartedAt, 0);
    assert.equal(totals.lastEndedAt, 5 * HOUR);
  });

  it('returns a zeroed summary for someone with no shifts', () => {
    const totals = summarise([]);
    assert.equal(totals.shiftCount, 0);
    assert.equal(totals.workedMs, 0);
    assert.equal(totals.firstStartedAt, null);
  });
});

describe('formatting', () => {
  it('renders durations at a sensible precision', () => {
    assert.equal(formatDuration(0), '0m');
    assert.equal(formatDuration(-5), '0m');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(5 * MINUTE + 3_000), '5m 03s');
    assert.equal(formatDuration(2 * HOUR + 14 * MINUTE), '2h 14m');
    assert.equal(formatHours(90 * MINUTE), '1.50h');
  });
});
