'use strict';

/** Reserved key for the built-in "cannot make it" option every event gets. */
const DECLINED_ROLE_KEY = 'declined';
const DECLINED_LABEL = 'Cant make it';

/** Two rows of buttons, five per row. */
const MAX_ROLES = 10;
const DEFAULT_ROLES = 'Attending, Tentative';

const MAX_LABEL_LENGTH = 40;
const MAX_LIMIT = 250;

/** Raised for anything a host can fix by re-running the command with different input. */
class EventInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventInputError';
  }
}

function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
}

/**
 * Parses the host's sign-up options, given as `Label` or `Label:limit` separated by
 * commas, e.g. `Guard:8, Medic:2, Spectator`.
 */
function parseRoles(input) {
  const roles = [];
  const seen = new Set();

  for (const part of input.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    let label = part;
    let limit = null;

    const colon = part.lastIndexOf(':');
    if (colon > 0) {
      const tail = part.slice(colon + 1).trim();
      if (/^\d+$/.test(tail)) {
        label = part.slice(0, colon).trim();
        limit = Number(tail);
      }
    }

    if (label.length === 0) throw new EventInputError(`\`${part}\` got no name`);
    if (label.length > MAX_LABEL_LENGTH) {
      throw new EventInputError(`\`${label}\` too long, keep it under ${MAX_LABEL_LENGTH} chars`);
    }
    if (limit !== null && (limit < 1 || limit > MAX_LIMIT)) {
      throw new EventInputError(`limit on \`${label}\` gotta be 1 to ${MAX_LIMIT}`);
    }

    const key = slugify(label);
    if (!key) throw new EventInputError(`\`${label}\` needs a letter or number in it`);
    if (key === DECLINED_ROLE_KEY) {
      throw new EventInputError(`\`${label}\` clashes with ${DECLINED_LABEL}, pick another name`);
    }
    if (seen.has(key)) throw new EventInputError(`\`${label}\` is in there twice`);

    seen.add(key);
    roles.push({ key, label, limit });
  }

  if (roles.length === 0) throw new EventInputError('need at least one signup option');
  if (roles.length > MAX_ROLES) throw new EventInputError(`thats ${roles.length} options, max is ${MAX_ROLES}`);

  return roles;
}

function findRole(roles, key) {
  return roles.find((role) => role.key === key) ?? null;
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function wallClockAt(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // Some ICU builds render midnight as hour 24 under hour12: false.
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

function offsetAt(instant, timezone) {
  const wall = wallClockAt(instant, timezone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instant;
}

/**
 * Turns a wall-clock reading in the given zone into a UTC instant. The second pass
 * settles the answer when the first guess lands on the other side of a DST change.
 */
function zonedToUtc(
  clock,
  timezone,
) {
  const asIfUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  const first = asIfUtc - offsetAt(asIfUtc, timezone);
  return asIfUtc - offsetAt(first, timezone);
}

const RELATIVE = /^(?:in\s+|\+)?((?:\d+\s*[dhm]\s*)+)$/i;
const RELATIVE_PART = /(\d+)\s*([dhm])/gi;
const ABSOLUTE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s]+(\d{1,2}):(\d{2}))?$/i;
const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;
const EPOCH = /^\d{10,13}$/;

const DAY_MS = 86_400_000;
const UNIT_MS = { d: DAY_MS, h: 3_600_000, m: 60_000 };

const START_TIME_HELP =
  'use `now`, `90m`, `21:00` or `YYYY-MM-DD HH:MM` (event timezone)';

/** Accepts the handful of shapes people actually type into a Discord option. */
function parseStartTime(input, timezone, now = Date.now()) {
  const text = input.trim();
  if (!text) throw new EventInputError(`no start time, ${START_TIME_HELP}`);

  if (/^now$/i.test(text)) return now;

  const spec = RELATIVE.exec(text)?.[1];
  if (spec) {
    let total = 0;
    for (const match of spec.matchAll(RELATIVE_PART)) {
      total += Number(match[1]) * (UNIT_MS[(match[2] ?? '').toLowerCase()] ?? 0);
    }
    if (total > 0) return now + total;
  }

  const absolute = ABSOLUTE.exec(text);
  if (absolute) {
    const [, year, month, day, hour, minute] = absolute;
    return zonedToUtc(
      {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour ?? 0),
        minute: Number(minute ?? 0),
      },
      timezone,
    );
  }

  const timeOnly = TIME_ONLY.exec(text);
  if (timeOnly) {
    const today = wallClockAt(now, timezone);
    const at = zonedToUtc(
      {
        year: today.year,
        month: today.month,
        day: today.day,
        hour: Number(timeOnly[1]),
        minute: Number(timeOnly[2]),
      },
      timezone,
    );
    // A time that has already gone past today means the next one.
    return at <= now ? at + DAY_MS : at;
  }

  if (EPOCH.test(text)) {
    return text.length <= 10 ? Number(text) * 1000 : Number(text);
  }

  throw new EventInputError(`\`${input}\` isnt a time, ${START_TIME_HELP}`);
}

/**
 * Attendance banked so far, including the stretch in progress. Time after the
 * member was last actually seen in game is never counted.
 */
function totalAttendance(signup, at) {
  if (signup.presentSince === null) return signup.attendedMs;
  const until = Math.min(signup.lastSeenAt ?? at, at);
  return signup.attendedMs + Math.max(0, until - signup.presentSince);
}

module.exports = { DECLINED_ROLE_KEY, DECLINED_LABEL, MAX_ROLES, DEFAULT_ROLES, EventInputError, parseRoles, findRole, isValidTimezone, zonedToUtc, START_TIME_HELP, parseStartTime, totalAttendance };
