'use strict';
const { config } = require('../config/index');
const { HttpError, requestJson } = require('../util/http');
const { createLogger } = require('../util/logger');
const { robloxAuthed, robloxErrorMessage } = require('./authed');

const log = createLogger('roblox:group');

const GROUPS_API = 'https://groups.roblox.com';
const USERS_API = 'https://users.roblox.com';

/** Rank 0 is the Guest pseudo-role and 255 is the owner; neither can be handed out. */
const GUEST_RANK = 0;
const OWNER_RANK = 255;

/** Discord snowflakes are 17-20 digits; Roblox ids are far shorter, so length tells them apart. */
const SNOWFLAKE = /^\d{17,20}$/;

class GroupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GroupError';
  }
}

function isGroupConfigured() {
  return Boolean(config.roblox.groupId && (config.roblox.groupCookie || config.roblox.cookie));
}

/**
 * Group writes need an account that actually outranks the people it is changing, so
 * this prefers its own cookie and only falls back to the presence one.
 */
function cookie() {
  const value = config.roblox.groupCookie || config.roblox.cookie;
  if (!value) throw new GroupError('No Roblox account is configured for group actions. Set `ROBLOX_GROUP_COOKIE`.');
  return value;
}

function groupId() {
  if (!config.roblox.groupId) throw new GroupError('`ROBLOX_GROUP_ID` is not set, so group actions are turned off.');
  return config.roblox.groupId;
}

async function call(path, init = {}) {
  const response = await robloxAuthed(`${GROUPS_API}${path}`, {
    cookie: cookie(),
    method: init.method ?? 'GET',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  // Accepting, declining and exiling all answer with an empty body.
  const text = await response.text();
  return (text ? JSON.parse(text) : {});
}

// ---------------------------------------------------------------------------
// Working out who somebody is
// ---------------------------------------------------------------------------

/**
 * Reads what somebody typed into `/group ... player:`. A mention or a snowflake means
 * a Discord member whose linked account we look up; a shorter number is a Roblox id;
 * anything else is a Roblox username.
 */
function classifyTarget(input) {
  const trimmed = input.trim();

  const mention = trimmed.match(/^<@!?(\d{17,20})>$/);
  if (mention?.[1]) return { kind: 'discord', value: mention[1] };

  if (SNOWFLAKE.test(trimmed)) return { kind: 'discord', value: trimmed };
  if (/^\d+$/.test(trimmed)) return { kind: 'robloxId', value: trimmed };

  return { kind: 'username', value: trimmed.replace(/^@/, '') };
}

/** Usernames are not ids, so every command that takes one has to resolve it first. */
async function findUserByUsername(username) {
  const body = await requestJson(
    `${USERS_API}/v1/usernames/users`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      retries: 1,
    },
  );

  const found = body.data?.[0];
  return found ? { id: String(found.id), name: found.name, displayName: found.displayName } : null;
}

async function findUserById(userId) {
  try {
    const body = await requestJson(
      `${USERS_API}/v1/users/${userId}`,
      { retries: 1 },
    );
    return { id: String(body.id), name: body.name, displayName: body.displayName };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

let roleCache = null;
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;

async function listRoles(force = false) {
  const now = Date.now();
  if (!force && roleCache && roleCache.expiresAt > now) return roleCache.roles;

  const body = await call(
    `/v1/groups/${groupId()}/roles`,
  );

  const roles = (body.roles ?? [])
    .map((role) => ({ id: role.id, name: role.name, rank: role.rank, memberCount: role.memberCount ?? null }))
    .sort((a, b) => a.rank - b.rank);

  roleCache = { roles, expiresAt: now + ROLE_CACHE_TTL_MS };
  return roles;
}

function clearRoleCache() {
  roleCache = null;
}

/** The ranks a bot may actually hand out: everything between Guest and the owner. */
function assignableRoles(roles) {
  return roles.filter((role) => role.rank > GUEST_RANK && role.rank < OWNER_RANK).sort((a, b) => a.rank - b.rank);
}

/** Matches an exact rank number, an exact role id, a name, or an unambiguous prefix. */
function matchRole(roles, query) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;

  const exactName = roles.find((role) => role.name.toLowerCase() === wanted);
  if (exactName) return exactName;

  if (/^\d+$/.test(wanted)) {
    const rank = Number(wanted);
    const byRank = roles.find((role) => role.rank === rank);
    if (byRank) return byRank;
    const byId = roles.find((role) => role.id === rank);
    if (byId) return byId;
  }

  const partial = roles.filter((role) => role.name.toLowerCase().startsWith(wanted));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/**
 * The next rank up or down the ladder from where somebody is now. Guest and the
 * owner rank are skipped, so a promotion can never hand over the group.
 */
function adjacentRole(roles, currentRank, direction) {
  const ladder = assignableRoles(roles);
  if (direction === 1) return ladder.find((role) => role.rank > currentRank) ?? null;
  return [...ladder].reverse().find((role) => role.rank < currentRank) ?? null;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** The member's role in our group, or null when they are not in it. */
async function getMembership(userId) {
  const body = await requestJson

(`${GROUPS_API}/v2/users/${userId}/groups/roles`, { retries: 1 });

  const wanted = groupId();
  for (const entry of body.data ?? []) {
    if (entry.group && String(entry.group.id) === wanted && entry.role) {
      return { id: entry.role.id, name: entry.role.name, rank: entry.role.rank, memberCount: null };
    }
  }
  return null;
}

async function setRank(userId, roleId) {
  await call(`/v1/groups/${groupId()}/users/${userId}`, { method: 'PATCH', body: { roleId } });
  log.info(`Set ${userId} to role ${roleId} in group ${groupId()}`);
}

async function exile(userId) {
  await call(`/v1/groups/${groupId()}/users/${userId}`, { method: 'DELETE' });
  log.info(`Exiled ${userId} from group ${groupId()}`);
}

// ---------------------------------------------------------------------------
// Join requests
// ---------------------------------------------------------------------------

function toJoinRequest(entry) {
  if (!entry.requester) return null;
  const created = entry.created ? Date.parse(entry.created) : Number.NaN;
  return {
    userId: String(entry.requester.userId),
    username: entry.requester.username,
    displayName: entry.requester.displayName ?? entry.requester.username,
    requestedAt: Number.isNaN(created) ? null : created,
  };
}

async function listJoinRequests(limit = 25) {
  const size = [10, 25, 50, 100].find((allowed) => allowed >= limit) ?? 100;
  const body = await call(
    `/v1/groups/${groupId()}/join-requests?limit=${size}&sortOrder=Asc`,
  );
  return (body.data ?? []).map(toJoinRequest).filter((entry) => entry !== null).slice(0, limit);
}

/** Null when that member has no request waiting, which is not an error worth throwing over. */
async function getJoinRequest(userId) {
  try {
    const body = await call(`/v1/groups/${groupId()}/join-requests/users/${userId}`);
    return toJoinRequest(body);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

async function acceptJoinRequest(userId) {
  await call(`/v1/groups/${groupId()}/join-requests/users/${userId}`, { method: 'POST', body: {} });
  log.info(`Accepted ${userId} into group ${groupId()}`);
}

async function declineJoinRequest(userId) {
  await call(`/v1/groups/${groupId()}/join-requests/users/${userId}`, { method: 'DELETE' });
  log.info(`Declined ${userId}'s request to join group ${groupId()}`);
}

/**
 * Asks Roblox what the group account may actually do here. The group itself is public,
 * so reading its name proves nothing about the cookie - the membership endpoint answers
 * as the signed-in account, which is the part worth checking.
 */
async function verifyGroupAccess() {
  if (!isGroupConfigured()) return { ok: false, reason: 'ROBLOX_GROUP_ID or ROBLOX_GROUP_COOKIE is not set' };

  let name;
  try {
    const group = await call(`/v1/groups/${groupId()}`);
    name = group.name ?? `Group ${groupId()}`;
  } catch (error) {
    return { ok: false, reason: robloxErrorMessage(error) };
  }

  try {
    const membership = await call

(`/v1/groups/${groupId()}/membership`);

    const granted = membership.permissions?.groupMembershipPermissions ?? {};
    return {
      ok: true,
      name,
      role: membership.userRole?.role?.name ?? 'unknown rank',
      can: {
        accept: granted.inviteMembers === true,
        rank: granted.changeRank === true,
        remove: granted.removeMembers === true,
      },
    };
  } catch (error) {
    // The group is real but the account cannot speak for it, which is the usual mistake.
    return { ok: false, name, reason: robloxErrorMessage(error) };
  }
}

module.exports = { robloxErrorMessage, GroupError, isGroupConfigured, classifyTarget, findUserByUsername, findUserById, listRoles, clearRoleCache, assignableRoles, matchRole, adjacentRole, getMembership, setRank, exile, listJoinRequests, getJoinRequest, acceptJoinRequest, declineJoinRequest, verifyGroupAccess };
