'use strict';
const { computeDurations } = require('../shifts/manager');
const { SHIFT_TYPE_VALUES, shiftTypeLabel } = require('../shifts/types');

class RankError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RankError';
  }
}

/** Time on shift, of one type or of every type together. */

/** Events run to the end, from /event. */

/**
 * - `auto`: meeting the requirements promotes them there and then.
 * - `approval`: meeting them posts a request for a human to approve.
 * - `manual`: not available through /promote at all.
 */

const PROMOTION_MODES = ['auto', 'approval', 'manual'];

/** One rung of the Roblox group, as the sheet describes it. */

/** Each general requirement is one short line; the cell is a list of them. */
function parseGeneral(raw) {
  return raw
    .split(/[;\n]/)
    .map((entry) => entry.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 15);
}

function formatGeneral(general) {
  return general.join('; ');
}

/**
 * The mode a rank actually runs in. A rank with general requirements can never be
 * `auto`: nothing here can tell whether somebody passed their final exam, so letting
 * the bot promote them on banked time alone would walk straight past the exam.
 */
function effectiveMode(rank) {
  if (rank.mode === 'auto' && rank.general.length > 0) return 'approval';
  return rank.mode;
}

function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** Words that mean "do not care which shift type". */
const ANY_TYPE = new Set(['', 'any', 'all', 'total', 'overall', 'combined', 'anything', 'time']);

/**
 * `\b` cannot end this: in `1h30m` there is no word boundary between the `h` and the
 * `3`, so the hours would be dropped silently. A "not followed by a letter" lookahead
 * ends the unit without needing one.
 */
const DURATION = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/gi;

/** `90m`, `2h`, `1h30m`, `1.5h`, `90`, or any of those spelt out. */
function parseDuration(text) {
  let total = 0;
  let matched = false;

  for (const match of text.matchAll(DURATION)) {
    matched = true;
    const amount = Number(match[1]);
    total += match[2]?.toLowerCase().startsWith('h') ? amount * 60 : amount;
  }

  if (matched) return Math.round(total);

  // A bare number on its own is read as minutes, which is what people mean by "90".
  const bare = text.trim().match(/^(\d+(?:\.\d+)?)$/);
  return bare?.[1] ? Math.round(Number(bare[1])) : 0;
}

/** Words that carry no meaning of their own in `shift guard time` or `5h total`. */
const FILLER = /\b(time|total|on|of|for|the)\b/g;

/** `game_night`, `game night` and `gamenight` all name the same type. */
function looselyEqual(a, b) {
  return a === b || a.replace(/_/g, '') === b.replace(/_/g, '');
}

/**
 * Works out which shift type a handful of words names. Returns null for "any type"
 * and undefined for something that is not a type at all, which is a typo worth
 * reporting rather than quietly counting everything.
 */
function matchShiftType(words) {
  const raw = words.trim().toLowerCase();

  // Tried as written first: stripping filler from `shift guard time` must not be
  // allowed to turn `shift guard` into something that no longer matches.
  for (const candidate of [raw, raw.replace(FILLER, ' ')]) {
    const key = slugify(candidate);
    if (ANY_TYPE.has(key) || ANY_TYPE.has(candidate.trim())) return null;

    const found = SHIFT_TYPE_VALUES.find(
      (value) => looselyEqual(value, key) || looselyEqual(slugify(shiftTypeLabel(value)), key),
    );
    if (found) return found;
  }

  return undefined;
}

function timeRequirement(shiftType, minutes) {
  return {
    kind: 'time',
    label: shiftType === null ? 'Total time on shift' : `${shiftTypeLabel(shiftType)} time`,
    shiftType,
    minutes,
  };
}

/**
 * Reads one requirement. The order of the words does not matter, so `90m shift guard`
 * and `shift guard 90m` are the same thing, and a bare `5h` means five hours of
 * anything. `3 events` counts events hosted instead of time.
 */
function parseRequirement(raw) {
  const entry = raw.trim();
  if (!entry) throw new RankError('That requirement is empty.');

  // The older `Label | shift type | 90m` form still works, so nothing written
  // against the previous version has to be retyped.
  if (entry.includes('|')) {
    const [label, type, amount] = entry.split('|').map((part) => part.trim());
    if (!label || amount === undefined) throw new RankError(`\`${entry}\` needs \`Label | shift type | 90m\`.`);
    const shiftType = matchShiftType(type ?? '');
    if (shiftType === undefined) throw new RankError(`\`${type}\` is not a shift type.`);
    return { ...timeRequirement(shiftType, parseDuration(amount)), label: label.slice(0, 60) };
  }

  if (/\bevents?\b/i.test(entry)) {
    const count = Number(entry.match(/\d+/)?.[0] ?? 0);
    if (count <= 0) throw new RankError(`\`${entry}\` needs a number, such as \`3 events\`.`);
    return { kind: 'events', label: 'Events hosted', count };
  }

  const minutes = parseDuration(entry);
  if (minutes <= 0) {
    throw new RankError(`\`${entry}\` has no length of time in it. Try \`90m\`, \`2h\` or \`shift guard 3h\`.`);
  }

  // Whatever is left once the durations are removed names the shift type.
  const words = entry.replace(DURATION, ' ').replace(/^\d+(\.\d+)?$/, ' ');
  const shiftType = matchShiftType(words);
  if (shiftType === undefined) {
    throw new RankError(
      `\`${words.trim()}\` is not a shift type. Use one of ${SHIFT_TYPE_VALUES.join(', ')}, or leave it out for any.`,
    );
  }

  return timeRequirement(shiftType, minutes);
}

/**
 * A whole cell: `shift guard 90m, game night 2h, 5h, 3 events`. Semicolons and new
 * lines separate just as well as commas, because people use all three.
 */
function parseRequirements(raw) {
  const requirements = [];
  const problems = [];

  for (const entry of raw.split(/[,;\n]/)) {
    if (!entry.trim()) continue;
    try {
      requirements.push(parseRequirement(entry));
    } catch (error) {
      // One bad entry must not take the whole rank down with it.
      problems.push(error instanceof RankError ? error.message : String(error));
    }
  }

  return { requirements, problems };
}

/** `90m` or `2h 30m`, the wording used everywhere a length of time is shown. */
function formatMinutes(minutes) {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours > 0 && rest > 0) return `${hours}h ${rest}m`;
  return hours > 0 ? `${hours}h` : `${rest}m`;
}

/** Back to the comma form, for seeding a row nobody has filled in yet. */
function formatRequirements(requirements) {
  return requirements
    .map((requirement) =>
      requirement.kind === 'events'
        ? `${requirement.count} events`
        : `${requirement.shiftType ?? 'any'} ${formatMinutes(requirement.minutes).replace(/\s+/g, '')}`,
    )
    .join(', ');
}

function describeRequirement(requirement) {
  return requirement.kind === 'events'
    ? `${requirement.count} event${requirement.count === 1 ? '' : 's'} hosted`
    : `${formatMinutes(requirement.minutes)} of ${
        requirement.shiftType === null ? 'any shift type' : shiftTypeLabel(requirement.shiftType)
      }`;
}

/**
 * Worked minutes per shift type over somebody's whole history. Open shifts count
 * what they have run so far, so a card drawn mid-shift is current.
 *
 * Unlike the phase system this replaced, nothing resets on promotion: requirements
 * are cumulative, so `5h total` means five hours ever, not five hours since last time.
 */
function workedMinutesByType(shifts, now = Date.now()) {
  const totals = new Map();

  for (const shift of shifts) {
    const { workedMs } = computeDurations(shift, now);
    totals.set(shift.type, (totals.get(shift.type) ?? 0) + workedMs / 60_000);
  }

  return totals;
}

/** Measures somebody against one rank's requirements. Pure: no store, no network. */
function measureRank(
  rank,
  worked,
  eventsHosted,
) {
  const everything = [...worked.values()].reduce((sum, minutes) => sum + minutes, 0);

  const requirements = (rank?.requirements ?? []).map((requirement) => {
    const target = requirement.kind === 'events' ? requirement.count : requirement.minutes;
    const done =
      requirement.kind === 'events'
        ? eventsHosted
        : requirement.shiftType === null
          ? everything
          : (worked.get(requirement.shiftType) ?? 0);

    return {
      requirement,
      label: requirement.label,
      done,
      target,
      met: target <= 0 || done >= target,
      fraction: target <= 0 ? 1 : Math.min(1, done / target),
    };
  });

  return {
    // A rank with no requirements written against it is not "everybody qualifies":
    // it is a rank nobody has configured yet, so nobody is ready for it.
    ready: rank !== null && requirements.length > 0 && requirements.every((entry) => entry.met),
    requirements,
    overall:
      requirements.length === 0
        ? 0
        : requirements.reduce((sum, entry) => sum + entry.fraction, 0) / requirements.length,
  };
}

/** The next rung above a rank number, skipping anything that cannot be assigned. */
function nextRank(ranks, currentRank) {
  return (
    [...ranks]
      .filter((rank) => rank.rank > 0 && rank.rank < 255)
      .sort((a, b) => a.rank - b.rank)
      .find((rank) => rank.rank > currentRank) ?? null
  );
}

function findRank(ranks, query) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;

  return (
    ranks.find((rank) => rank.name.toLowerCase() === wanted) ??
    ranks.find((rank) => String(rank.rank) === wanted || String(rank.roleId) === wanted) ??
    ranks.find((rank) => rank.name.toLowerCase().startsWith(wanted)) ??
    null
  );
}

function parseMode(raw) {
  const value = raw.trim().toLowerCase();
  if (value.startsWith('auto')) return 'auto';
  if (value.startsWith('approv') || value.startsWith('request') || value === 'yes') return 'approval';
  // Anything unrecognised means manual, which is the mode that changes nothing.
  return 'manual';
}

module.exports = { RankError, PROMOTION_MODES, parseGeneral, formatGeneral, effectiveMode, parseDuration, parseRequirement, parseRequirements, formatMinutes, formatRequirements, describeRequirement, workedMinutesByType, measureRank, nextRank, findRank, parseMode };
