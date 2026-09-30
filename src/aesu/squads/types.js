'use strict';
const { config, DEFAULT_SQUADS } = require('../config/index');

/** Slash command choices stop at 25. */
const MAX_SQUADS = 25;
const MAX_LABEL = 100;

function slugify(label) {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/**
 * Reads `Label=roleId` pairs. An entry without a usable role id is dropped rather
 * than kept as a squad that silently does nothing when assigned.
 */
function parseSquads(raw, sharedExcept = '') {
  const excluded = new Set(
    sharedExcept
      .split(',')
      .map((part) => slugify(part))
      .filter(Boolean),
  );

  const squads = [];
  const seen = new Set();

  for (const entry of raw.split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const label = trimmed.slice(0, separator).trim().slice(0, MAX_LABEL);
    const roleId = trimmed.slice(separator + 1).trim();
    const key = slugify(label);

    if (!key || !label || !/^\d{17,20}$/.test(roleId) || seen.has(key)) continue;

    seen.add(key);
    squads.push({ key, label, roleId, shared: !excluded.has(key) });

    if (squads.length >= MAX_SQUADS) break;
  }

  return squads;
}

function load() {
  const squads = parseSquads(config.squads.list, config.squads.sharedExcept);
  return squads.length > 0 ? squads : parseSquads(DEFAULT_SQUADS, config.squads.sharedExcept);
}

const SQUADS = load();

function squadByKey(key) {
  return SQUADS.find((squad) => squad.key === key) ?? null;
}

/** Matches a key, a label, or a role id, however it was capitalised. */
function findSquad(query) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;
  return (
    SQUADS.find(
      (squad) => squad.key === wanted || squad.label.toLowerCase() === wanted || squad.roleId === query.trim(),
    ) ?? squadByKey(slugify(query))
  );
}

/** Every role this bot treats as a squad marker, including the shared one. */
function squadRoleIds() {
  const ids = SQUADS.map((squad) => squad.roleId);
  if (config.squads.sharedRoleId) ids.push(config.squads.sharedRoleId);
  return [...new Set(ids)];
}

function isSquadsEnabled() {
  return SQUADS.length > 0;
}

/**
 * The roles somebody in this squad should hold, and the ones they should not.
 * Passing null clears them out of every squad.
 */
function squadRoleChange(squad) {
  const shared = config.squads.sharedRoleId;

  const wanted = squad ? [squad.roleId, ...(squad.shared && shared ? [shared] : [])] : [];
  const unwanted = squadRoleIds().filter((id) => !wanted.includes(id));

  return { wanted, unwanted };
}

/** The squad whose role the member holds, or null. */
function squadFromRoles(roleIds) {
  const held = new Set(roleIds);
  return SQUADS.find((squad) => held.has(squad.roleId)) ?? null;
}

module.exports = { parseSquads, SQUADS, squadByKey, findSquad, squadRoleIds, isSquadsEnabled, squadRoleChange, squadFromRoles };
