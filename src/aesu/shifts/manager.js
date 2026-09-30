'use strict';
const { randomUUID } = require('node:crypto');
const { config } = require('../config/index');
const { createLogger, describeError } = require('../util/logger');
const { KeyedMutex } = require('../util/mutex');
const { SHIFT_TYPE_VALUES } = require('./types');

const log = createLogger('shifts');

class ShiftError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShiftError';
  }
}

function computeDurations(shift, now = Date.now()) {
  const end = shift.endedAt ?? now;
  const elapsedMs = Math.max(0, end - shift.startedAt);
  const openBreakMs = shift.breakStartedAt === null ? 0 : Math.max(0, end - shift.breakStartedAt);
  const breakMs = Math.min(elapsedMs, shift.breakMs + openBreakMs);

  // The adjustment is applied after the clamp, so a removal can take a total below
  // what this one record holds. A single record going negative is the point: the sum
  // across somebody's shifts is what anybody reads.
  const workedMs = Math.max(0, elapsedMs - breakMs) + (shift.adjustmentMs ?? 0);
  return { elapsedMs, breakMs, workedMs };
}

/**
 * Owns every transition a shift can make. Discord interactions, the presence
 * watcher and the stale-shift sweeper all go through here so the log channel
 * and the database never disagree.
 */
class ShiftManager {
  listeners = [];
  locks = new KeyedMutex();

  constructor(store) {
    this.store = store;
  }

  onChange(listener) {
    this.listeners.push(listener);
  }

  async emit(change, shift) {
    for (const listener of this.listeners) {
      try {
        await listener(change, shift);
      } catch (error) {
        log.error(`Shift listener failed for ${change} on ${shift.id}: ${describeError(error)}`);
      }
    }
  }

  getOpenShift(discordId) {
    return this.store.getOpenShift(discordId);
  }

  listOpenShifts() {
    return this.store.listOpenShifts();
  }

  listShifts(discordId, query) {
    return this.store.listShifts(discordId, query);
  }

  async start(input) {
    return this.locks.run(input.discordId, async () => {
      const existing = await this.store.getOpenShift(input.discordId);
      if (existing) {
        throw new ShiftError('You already have a shift running. End it before starting another one.');
      }

      const now = Date.now();
      const shift = {
        id: randomUUID(),
        discordId: input.discordId,
        guildId: input.guildId,
        robloxId: input.robloxId ?? null,
        robloxUsername: input.robloxUsername ?? null,
        type: input.type,
        status: 'active',
        source: input.source,
        startedAt: now,
        endedAt: null,
        breakStartedAt: null,
        breakMs: 0,
        adjustmentMs: 0,
        breakCount: 0,
        universeId: input.universeId ?? null,
        placeId: input.placeId ?? null,
        gameName: input.gameName ?? null,
        endReason: null,
        logChannelId: null,
        logMessageId: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.createShift(shift);
      log.info(`${input.discordId} started a ${input.type} shift (${shift.id})`);
      await this.emit('started', shift);
      return shift;
    });
  }

  async startBreak(discordId) {
    return this.locks.run(discordId, async () => {
      const shift = await this.requireOpenShift(discordId);
      if (shift.status === 'on_break') throw new ShiftError('You are already on a break.');

      const now = Date.now();
      const updated = {
        ...shift,
        status: 'on_break',
        breakStartedAt: now,
        breakCount: shift.breakCount + 1,
        updatedAt: now,
      };
      await this.store.updateShift(updated);
      log.info(`${discordId} started a break on ${shift.id}`);
      await this.emit('break_started', updated);
      return updated;
    });
  }

  async endBreak(discordId) {
    return this.locks.run(discordId, async () => {
      const shift = await this.requireOpenShift(discordId);
      if (shift.status !== 'on_break') throw new ShiftError('You are not on a break right now.');

      const now = Date.now();
      const taken = shift.breakStartedAt === null ? 0 : Math.max(0, now - shift.breakStartedAt);
      const updated = {
        ...shift,
        status: 'active',
        breakStartedAt: null,
        breakMs: shift.breakMs + taken,
        updatedAt: now,
      };
      await this.store.updateShift(updated);
      log.info(`${discordId} ended a break on ${shift.id}`);
      await this.emit('break_ended', updated);
      return updated;
    });
  }

  async end(discordId, reason) {
    return this.locks.run(discordId, async () => {
      const shift = await this.requireOpenShift(discordId);
      return this.finalise(shift, reason);
    });
  }

  /** Ends a shift without taking the member lock - callers must already hold it. */
  async finalise(shift, reason, at = Date.now()) {
    const endedAt = Math.max(shift.startedAt, at);
    const openBreakMs = shift.breakStartedAt === null ? 0 : Math.max(0, endedAt - shift.breakStartedAt);

    const updated = {
      ...shift,
      status: 'ended',
      endedAt,
      breakStartedAt: null,
      breakMs: shift.breakMs + openBreakMs,
      endReason: reason,
      updatedAt: Date.now(),
    };

    await this.store.updateShift(updated);
    const { workedMs } = computeDurations(updated);
    log.info(`${shift.discordId} ended shift ${shift.id} (${reason}), banked ${Math.round(workedMs / 1000)}s`);
    await this.emit('ended', updated);
    return updated;
  }

  /** Used by the presence watcher; safely no-ops when the shift was already closed. */
  async endIfOpen(discordId, reason, at = Date.now()) {
    return this.locks.run(discordId, async () => {
      const shift = await this.store.getOpenShift(discordId);
      if (!shift) return null;
      return this.finalise(shift, reason, at);
    });
  }

  /**
   * Writes a shift that is already over. Used to bank event attendance, which is
   * measured after the fact rather than driven by start and end presses.
   */
  async recordCompleted(input) {
    return this.locks.run(input.discordId, async () => {
      const now = Date.now();
      const shift = {
        id: randomUUID(),
        discordId: input.discordId,
        guildId: input.guildId,
        robloxId: input.robloxId ?? null,
        robloxUsername: input.robloxUsername ?? null,
        type: input.type,
        status: 'ended',
        source: 'event',
        startedAt: input.startedAt,
        endedAt: Math.max(input.startedAt, input.endedAt),
        breakStartedAt: null,
        breakMs: 0,
        adjustmentMs: 0,
        breakCount: 0,
        universeId: input.universeId ?? null,
        placeId: input.placeId ?? null,
        gameName: input.gameName ?? null,
        endReason: 'event_ended',
        logChannelId: null,
        logMessageId: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.createShift(shift);
      const { workedMs } = computeDurations(shift);
      log.info(`Banked ${Math.round(workedMs / 1000)}s of event attendance for ${input.discordId} (${shift.id})`);
      await this.emit('ended', shift);
      return shift;
    });
  }

  /**
   * Adds or removes banked time by hand. The correction is its own zero-length shift
   * rather than an edit to somebody's real ones, so what actually happened stays on
   * the record and the change beside it is visible in `/shift history`.
   */
  async adjust(input) {
    return this.locks.run(input.discordId, async () => {
      const now = Date.now();
      const shift = {
        id: randomUUID(),
        discordId: input.discordId,
        guildId: input.guildId,
        robloxId: null,
        robloxUsername: null,
        type: input.type,
        status: 'ended',
        source: 'admin',
        startedAt: now,
        endedAt: now,
        breakStartedAt: null,
        breakMs: 0,
        adjustmentMs: Math.round(input.deltaMs),
        breakCount: 0,
        universeId: null,
        placeId: null,
        gameName: null,
        endReason: 'admin',
        logChannelId: null,
        logMessageId: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.createShift(shift);
      log.info(
        `${input.actorId} adjusted ${input.discordId} by ${Math.round(input.deltaMs / 60_000)}m ` +
          `of ${input.type} (${shift.id})`,
      );
      return shift;
    });
  }

  /** Persists the log message reference so later transitions can edit the same embed. */
  async attachLogMessage(shiftId, channelId, messageId) {
    const shift = await this.store.getShift(shiftId);
    if (!shift) return;
    await this.store.updateShift({ ...shift, logChannelId: channelId, logMessageId: messageId, updatedAt: Date.now() });
  }

  /**
   * Backfills the game a shift is being worked in. Used when someone starts a shift
   * from the panel before the watcher has seen them join.
   */
  async attachGameContext(
    shiftId,
    game,
  ) {
    const shift = await this.store.getShift(shiftId);
    if (!shift || shift.status === 'ended') return;
    if (shift.universeId === game.universeId && shift.placeId === game.placeId && shift.gameName === game.gameName) {
      return;
    }

    const updated = { ...shift, ...game, updatedAt: Date.now() };
    await this.store.updateShift(updated);
    await this.emit('updated', updated);
  }

  /** Safety net for shifts nobody ever closed - e.g. presence tracking was off. */
  async sweepStaleShifts() {
    const cutoffMs = config.tracking.maxShiftHours * 60 * 60 * 1000;
    const now = Date.now();
    const closed = [];

    for (const shift of await this.store.listOpenShifts()) {
      if (now - shift.startedAt < cutoffMs) continue;
      const ended = await this.endIfOpen(shift.discordId, 'max_duration', shift.startedAt + cutoffMs);
      if (ended) {
        closed.push(ended);
        log.warn(`Auto-closed ${shift.id}: ran past the ${config.tracking.maxShiftHours}h cap`);
      }
    }

    return closed;
  }

  async requireOpenShift(discordId) {
    const shift = await this.store.getOpenShift(discordId);
    if (!shift) throw new ShiftError('You do not have a shift running right now.');
    return shift;
  }
}

function emptyByType() {
  const byType = {};
  for (const type of SHIFT_TYPE_VALUES) byType[type] = { count: 0, workedMs: 0 };
  return byType;
}

/** Rolls a list of shifts into the numbers /checktime reports. */
function summarise(shifts, now = Date.now()) {
  const totals = {
    // A correction moves somebody's hours; it is not a shift they worked, so it is
    // counted in the time and nowhere else.
    shiftCount: shifts.filter((shift) => shift.source !== 'admin').length,
    workedMs: 0,
    breakMs: 0,
    byType: emptyByType(),
    longestMs: 0,
    firstStartedAt: null,
    lastEndedAt: null,
  };

  for (const shift of shifts) {
    const { workedMs, breakMs } = computeDurations(shift, now);
    const correction = shift.source === 'admin';

    totals.workedMs += workedMs;
    totals.breakMs += breakMs;

    // A type that has since been renamed or dropped still has to be counted.
    const bucket = (totals.byType[shift.type] ??= { count: 0, workedMs: 0 });
    bucket.workedMs += workedMs;

    // Everything below describes shifts somebody actually worked, and a correction
    // would otherwise claim to be the longest one or the most recent.
    if (correction) continue;

    bucket.count += 1;
    totals.longestMs = Math.max(totals.longestMs, workedMs);

    if (totals.firstStartedAt === null || shift.startedAt < totals.firstStartedAt) {
      totals.firstStartedAt = shift.startedAt;
    }
    const end = shift.endedAt ?? now;
    if (totals.lastEndedAt === null || end > totals.lastEndedAt) totals.lastEndedAt = end;
  }

  return totals;
}

module.exports = { ShiftError, computeDurations, ShiftManager, summarise };
