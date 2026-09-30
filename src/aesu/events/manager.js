'use strict';
const { config } = require('../config/index');
const { randomId } = require('../util/ids');
const { createLogger, describeError } = require('../util/logger');
const { KeyedMutex } = require('../util/mutex');
const { isAnyGameType } = require('../shifts/types');
const { DECLINED_LABEL, DECLINED_ROLE_KEY, EventInputError, findRole, totalAttendance } = require('./types');

const log = createLogger('events');

/** What one presence poll saw for one member, as far as events are concerned. */

/** Moves a sign-up's attendance tally on, or returns null when nothing changed. */
function applyPresence(
  signup,
  present,
  now,
  game = null,
) {
  if (present) {
    return {
      ...signup,
      presentSince: signup.presentSince ?? now,
      firstSeenAt: signup.firstSeenAt ?? now,
      lastSeenAt: now,
      universeId: game?.universeId ?? signup.universeId,
      placeId: game?.placeId ?? signup.placeId,
      gameName: game?.gameName ?? signup.gameName,
    };
  }

  if (signup.presentSince === null) return null;
  // Bank up to the last confirmed sighting, so the poll gap is not counted.
  const until = Math.min(signup.lastSeenAt ?? now, now);
  return {
    ...signup,
    attendedMs: signup.attendedMs + Math.max(0, until - signup.presentSince),
    presentSince: null,
  };
}

/** How much of the window is already covered by shifts the member ran themselves. */
function overlapMs(shifts, from, to, now) {
  let total = 0;
  for (const shift of shifts) {
    const start = Math.max(shift.startedAt, from);
    const end = Math.min(shift.endedAt ?? now, to);
    if (end > start) total += end - start;
  }
  return total;
}

/**
 * Owns the lifecycle of scheduled events: sign-ups, the start and end transitions,
 * and turning the time attendees actually spent in a tracked game into shifts.
 */
class EventManager {
  listeners = [];
  locks = new KeyedMutex();

  constructor(
    store,
    shifts,
  ) {
    this.store = store;
    this.shifts = shifts;
  }

  onChange(listener) {
    this.listeners.push(listener);
  }

  async emit(change, event) {
    for (const listener of this.listeners) {
      try {
        await listener(change, event);
      } catch (error) {
        log.error(`Event listener failed for ${change} on ${event.id}: ${describeError(error)}`);
      }
    }
  }

  getEvent(id) {
    return this.store.getEvent(id);
  }

  listSignups(eventId) {
    return this.store.listSignups(eventId);
  }

  listOpenEvents(guildId) {
    return this.store.listEvents({ status: ['scheduled', 'running'], guildId, limit: 25 });
  }

  /**
   * How many events somebody has run to completion, plus whichever they have on right
   * now. Counted from the events themselves rather than a running total, so it can
   * never drift, and cancelled events do not count as hosting anything.
   */
  async hostedCount(discordId) {
    const events = await this.store.listEvents({ hostId: discordId });
    return {
      hosted: events.filter((event) => event.status === 'ended').length,
      live: events.filter((event) => event.status === 'running' || event.status === 'scheduled').length,
    };
  }

  async create(input, now = Date.now()) {
    const event = {
      id: await this.uniqueId(),
      guildId: input.guildId,
      hostId: input.hostId,
      name: input.name,
      details: input.details,
      imageUrl: input.imageUrl,
      shiftType: input.shiftType,
      // Starting "now" should not wait for the next scheduler tick.
      status: input.startsAt <= now ? 'running' : 'scheduled',
      startsAt: input.startsAt,
      // Open ended: it runs until the host closes it, or until the cap below.
      endsAt: null,
      roles: input.roles,
      channelId: null,
      messageId: null,
      hostAwaySince: null,
      hostRemindedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.createEvent(event);
    log.info(`${input.hostId} scheduled ${event.id} (${event.name}) for ${new Date(event.startsAt).toISOString()}`);
    return event;
  }

  /** Remembers where the announcement went so later changes edit the same message. */
  async attachMessage(eventId, channelId, messageId) {
    const event = await this.store.getEvent(eventId);
    if (!event) return;
    await this.store.updateEvent({ ...event, channelId, messageId, updatedAt: Date.now() });
  }

  async signUp(
    eventId,
    discordId,
    roleKey,
    robloxId,
  ) {
    return this.locks.run(eventId, async () => {
      const event = await this.store.getEvent(eventId);
      if (!event) throw new EventInputError('That event no longer exists.');
      if (event.status === 'ended') throw new EventInputError('That event is over.');
      if (event.status === 'cancelled') throw new EventInputError('That event was cancelled.');

      const role = findRole(event.roles, roleKey);
      if (!role && roleKey !== DECLINED_ROLE_KEY) {
        throw new EventInputError('That sign-up option is not on this event any more.');
      }

      const signups = await this.store.listSignups(eventId);
      const existing = signups.find((signup) => signup.discordId === discordId) ?? null;
      if (existing?.roleKey === roleKey) {
        throw new EventInputError(`You are already down as **${role?.label ?? DECLINED_LABEL}**.`);
      }

      if (role?.limit != null) {
        const taken = signups.filter((signup) => signup.roleKey === roleKey && signup.discordId !== discordId).length;
        if (taken >= role.limit) throw new EventInputError(`**${role.label}** is full (${role.limit} of ${role.limit}).`);
      }

      const now = Date.now();
      const signup = existing
        ? { ...existing, roleKey, robloxId }
        : {
            eventId,
            discordId,
            roleKey,
            robloxId,
            signedUpAt: now,
            attendedMs: 0,
            presentSince: null,
            firstSeenAt: null,
            lastSeenAt: null,
            universeId: null,
            placeId: null,
            gameName: null,
            shiftId: null,
          };

      await this.store.upsertSignup(signup);
      await this.emit('signup', event);
      return { event, role };
    });
  }

  /**
   * Called once per presence poll with what was seen for each member. Members
   * missing from the map have unknown presence and are left untouched.
   *
   * What counts as attending depends on the event: a game night is run in whatever
   * game the community picked, so any game counts for it, while every other kind of
   * event only counts time inside a tracked game.
   */
  async recordAttendance(seen, now = Date.now()) {
    if (seen.size === 0) return;

    for (const event of await this.store.listEvents({ status: ['running'] })) {
      const anyGame = isAnyGameType(event.shiftType);

      for (const signup of await this.store.listSignups(event.id)) {
        if (signup.roleKey === DECLINED_ROLE_KEY) continue;
        const snapshot = seen.get(signup.discordId);
        if (!snapshot) continue;

        const present = anyGame ? snapshot.inAnyGame : snapshot.inTrackedGame;
        const next = applyPresence(signup, present, now, present ? snapshot : null);
        if (next) await this.store.upsertSignup(next);
      }

      await this.trackHost(event, seen, now);
    }
  }

  /**
   * Nothing closes an event automatically, so a host who wanders off would leave it
   * counting. Once they have been out of the game for the usual leave grace, nudge
   * them once, and arm the nudge again if they come back and leave a second time.
   */
  async trackHost(
    event,
    seen,
    now,
  ) {
    const snapshot = seen.get(event.hostId);
    if (!snapshot) return;
    // Judged by the same rule as attendance, so a game night host is not nagged
    // for being outside the tracked game when that is the whole point.
    const present = isAnyGameType(event.shiftType) ? snapshot.inAnyGame : snapshot.inTrackedGame;

    if (present) {
      if (event.hostAwaySince === null && event.hostRemindedAt === null) return;
      await this.store.updateEvent({ ...event, hostAwaySince: null, hostRemindedAt: null, updatedAt: now });
      return;
    }

    if (event.hostAwaySince === null) {
      await this.store.updateEvent({ ...event, hostAwaySince: now, updatedAt: now });
      return;
    }

    if (event.hostRemindedAt !== null) return;
    if (now - event.hostAwaySince < config.tracking.leaveGraceSeconds * 1000) return;

    const reminded = { ...event, hostRemindedAt: now, updatedAt: now };
    await this.store.updateEvent(reminded);
    log.info(`Reminded ${event.hostId} that ${event.id} (${event.name}) is still running`);
    await this.emit('host_away', reminded);
  }

  /** Starts events that are due, and closes any the host has forgotten about. */
  async tick(now = Date.now()) {
    const capMs = config.events.maxHours * 60 * 60 * 1000;

    for (const event of await this.store.listEvents({ status: ['scheduled', 'running'] })) {
      try {
        if (event.status === 'scheduled' && now >= event.startsAt) await this.begin(event.id, now);
        // Nothing ends an event on its own any more, so a forgotten one is banked at
        // the cap rather than counting attendance indefinitely.
        if (now >= event.startsAt + capMs) {
          log.warn(`Event ${event.id} ran past the ${config.events.maxHours}h cap and was closed`);
          await this.finish(event.id, event.startsAt + capMs);
        }
      } catch (error) {
        log.error(`Could not advance event ${event.id}: ${describeError(error)}`);
      }
    }
  }

  async begin(eventId, now) {
    await this.locks.run(eventId, async () => {
      const event = await this.store.getEvent(eventId);
      if (!event || event.status !== 'scheduled') return;

      const started = { ...event, status: 'running', updatedAt: now };
      await this.store.updateEvent(started);
      log.info(`Event ${event.id} (${event.name}) is under way`);
      await this.emit('started', started);
    });
  }

  /** Closes a running event and banks everybody's attendance. */
  async finish(eventId, now = Date.now()) {
    return this.locks.run(eventId, async () => {
      const event = await this.store.getEvent(eventId);
      if (!event || event.status !== 'running') return null;

      const closedAt = Math.max(event.startsAt, now);
      const ended = { ...event, status: 'ended', endsAt: closedAt, updatedAt: now };
      await this.store.updateEvent(ended);

      for (const signup of await this.store.listSignups(event.id)) {
        if (signup.roleKey === DECLINED_ROLE_KEY) continue;
        try {
          await this.bank(ended, signup, closedAt);
        } catch (error) {
          log.error(`Could not bank ${signup.discordId}'s attendance on ${event.id}: ${describeError(error)}`);
        }
      }

      log.info(`Event ${event.id} (${event.name}) finished`);
      await this.emit('ended', ended);
      return ended;
    });
  }

  async cancel(eventId, now = Date.now()) {
    return this.locks.run(eventId, async () => {
      const event = await this.store.getEvent(eventId);
      if (!event || event.status === 'ended' || event.status === 'cancelled') return null;

      const cancelled = { ...event, status: 'cancelled', updatedAt: now };
      await this.store.updateEvent(cancelled);
      log.info(`Event ${event.id} (${event.name}) was cancelled`);
      await this.emit('cancelled', cancelled);
      return cancelled;
    });
  }

  /**
   * Turns one attendee's time into a shift. Time they were already on their own
   * shift for is subtracted first, so attending an event never double counts.
   */
  async bank(event, signup, closedAt) {
    const attendedMs = totalAttendance(signup, closedAt);
    const settled = { ...signup, attendedMs, presentSince: null };
    const minimumMs = config.events.minAttendanceMinutes * 60_000;

    if (attendedMs < minimumMs) {
      await this.store.upsertSignup(settled);
      return;
    }

    const lookback = event.startsAt - config.tracking.maxShiftHours * 60 * 60 * 1000;
    const own = await this.store.listShifts(signup.discordId, { since: lookback, includeOpen: true });
    const loggable = Math.max(0, attendedMs - overlapMs(own, event.startsAt, closedAt, closedAt));

    if (loggable < minimumMs) {
      log.info(`${signup.discordId}'s time on ${event.id} is already covered by their own shifts`);
      await this.store.upsertSignup(settled);
      return;
    }

    const link = await this.store.getLinkByDiscordId(signup.discordId);
    // What the polls saw for this event wins, since the watcher's own session only
    // ever follows the tracked games.
    const watch = await this.store.getWatchState(signup.discordId);

    const shift = await this.shifts.recordCompleted({
      discordId: signup.discordId,
      guildId: event.guildId,
      type: event.shiftType,
      robloxId: signup.robloxId ?? link?.robloxId ?? null,
      robloxUsername: link?.robloxUsername ?? null,
      universeId: signup.universeId ?? watch?.universeId ?? null,
      placeId: signup.placeId ?? watch?.placeId ?? null,
      gameName: signup.gameName ?? watch?.gameName ?? null,
      startedAt: closedAt - loggable,
      endedAt: closedAt,
    });

    await this.store.upsertSignup({ ...settled, shiftId: shift.id });
  }

  async uniqueId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomId(4);
      if (!(await this.store.getEvent(id))) return id;
    }
    return randomId(8);
  }
}

module.exports = { applyPresence, overlapMs, EventManager };
