'use strict';
const { config, DEFAULT_SHIFT_TYPES } = require('../config/index');

/** Discord select menus and command choices both stop at 25 options. */
const MAX_TYPES = 25;
/** Labels and descriptions are both capped at 100 characters by Discord. */
const MAX_TEXT = 100;

const PALETTE = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0x3498db, 0xe67e22, 0x1abc9c];

/**
 * `Shift Guard` becomes `shift_guard`, which is what older records already store.
 * Letters and digits from any script are kept, so a label written in Korean or any
 * other non-Latin alphabet still produces a usable key instead of an empty one.
 */
function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** `key = text` entries separated by semicolons, so a description may contain commas. */
function parseDescriptions(raw) {
  const descriptions = new Map();

  for (const entry of raw.split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = slugify(entry.slice(0, separator));
    const text = entry.slice(separator + 1).trim().slice(0, MAX_TEXT);
    if (key && text) descriptions.set(key, text);
  }

  return descriptions;
}

/**
 * Reads the configured types: comma separated `Label`, or `key=Label` when the
 * stored key has to stay put while the label changes.
 */
function parseShiftTypes(rawTypes, rawDescriptions) {
  const descriptions = parseDescriptions(rawDescriptions);
  const types = [];
  const seen = new Set();

  for (const entry of rawTypes.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf('=');
    const label = (separator > 0 ? trimmed.slice(separator + 1) : trimmed).trim().slice(0, MAX_TEXT);
    const key = separator > 0 ? slugify(trimmed.slice(0, separator)) : slugify(label);
    if (!key || !label || seen.has(key)) continue;

    seen.add(key);
    types.push({
      value: key,
      label,
      description: descriptions.get(key) ?? null,
      color: PALETTE[types.length % PALETTE.length] ?? PALETTE[0],
    });

    if (types.length >= MAX_TYPES) break;
  }

  return types;
}

function load() {
  const types = parseShiftTypes(config.shifts.types, config.shifts.descriptions);
  // A select menu with no options is rejected outright, so never end up with none.
  return types.length > 0 ? types : parseShiftTypes(DEFAULT_SHIFT_TYPES, '');
}

const SHIFT_TYPES = load();

const byKey = new Map(SHIFT_TYPES.map((meta) => [meta.value, meta]));

const SHIFT_TYPE_VALUES = SHIFT_TYPES.map((meta) => meta.value);

/** What an event banks attendance as when the host picks nothing. */

const anyGameKeys = new Set(
  config.shifts.anyGameTypes
    .split(',')
    .map((entry) => slugify(entry.trim()))
    .filter(Boolean),
);

function isShiftType(value) {
  return byKey.has(value);
}

/**
 * True for a type that is run in whatever game the member happens to be in, rather
 * than only the tracked ones - a community game night, say.
 */
function isAnyGameType(type) {
  return anyGameKeys.has(type);
}

/**
 * Keys named by SHIFT_TYPES_ANY_GAME that no configured type uses. Almost always a
 * typo or a renamed label, which would quietly leave the exemption switched off.
 */
function unmatchedAnyGameKeys() {
  return [...anyGameKeys].filter((key) => !byKey.has(key));
}

/** The labels of the any-game types, for pointing people at the right option. */
function anyGameTypeLabels() {
  return SHIFT_TYPES.filter((meta) => anyGameKeys.has(meta.value)).map((meta) => meta.label);
}

/** Null for a type that is no longer configured but still appears on old shifts. */
function shiftTypeMeta(type) {
  return byKey.get(type) ?? null;
}

function shiftTypeLabel(type) {
  return byKey.get(type)?.label ?? type;
}

module.exports = { parseShiftTypes, SHIFT_TYPES, SHIFT_TYPE_VALUES, isShiftType, isAnyGameType, unmatchedAnyGameKeys, anyGameTypeLabels, shiftTypeMeta, shiftTypeLabel };
