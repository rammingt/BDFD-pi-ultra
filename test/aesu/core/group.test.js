'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.ROBLOX_GROUP_ID = '123456';
process.env.ROBLOX_GROUP_COOKIE = 'group-cookie';
process.env.LOG_LEVEL = 'error';

const { adjacentRole, assignableRoles, classifyTarget, isGroupConfigured, matchRole } = require('../../../src/aesu/roblox/group');
const { robloxErrorMessage } = require('../../../src/aesu/roblox/authed');
const { HttpError } = require('../../../src/aesu/util/http');

/** A ladder shaped like a real group: a Guest at 0 and an owner at 255. */
const ROLES = [
  { id: 1, name: 'Guest', rank: 0, memberCount: null },
  { id: 2, name: 'Trainee', rank: 10, memberCount: 40 },
  { id: 3, name: 'Guard', rank: 50, memberCount: 120 },
  { id: 4, name: 'Guard Captain', rank: 100, memberCount: 8 },
  { id: 5, name: 'Owner', rank: 255, memberCount: 1 },
];

describe('classifyTarget', () => {
  it('reads a Discord mention as a Discord member', () => {
    assert.deepEqual(classifyTarget('<@123456789012345678>'), { kind: 'discord', value: '123456789012345678' });
    assert.deepEqual(classifyTarget('<@!123456789012345678>'), { kind: 'discord', value: '123456789012345678' });
  });

  it('treats a long number as a snowflake and a short one as a Roblox id', () => {
    assert.deepEqual(classifyTarget('123456789012345678'), { kind: 'discord', value: '123456789012345678' });
    assert.deepEqual(classifyTarget('261'), { kind: 'robloxId', value: '261' });
  });

  it('treats anything else as a username, with the @ stripped', () => {
    assert.deepEqual(classifyTarget('  aesu_tester '), { kind: 'username', value: 'aesu_tester' });
    assert.deepEqual(classifyTarget('@aesu_tester'), { kind: 'username', value: 'aesu_tester' });
  });
});

describe('assignableRoles', () => {
  it('leaves out Guest and the owner rank', () => {
    assert.deepEqual(
      assignableRoles(ROLES).map((role) => role.name),
      ['Trainee', 'Guard', 'Guard Captain'],
    );
  });
});

describe('adjacentRole', () => {
  it('steps one rank up and one rank down', () => {
    assert.equal(adjacentRole(ROLES, 10, 1)?.name, 'Guard');
    assert.equal(adjacentRole(ROLES, 50, -1)?.name, 'Trainee');
  });

  it('never promotes into the owner rank', () => {
    assert.equal(adjacentRole(ROLES, 100, 1), null);
  });

  it('never demotes into Guest', () => {
    assert.equal(adjacentRole(ROLES, 10, -1), null);
  });

  it('finds the next rank up even from a rank nobody holds exactly', () => {
    assert.equal(adjacentRole(ROLES, 25, 1)?.name, 'Guard');
    assert.equal(adjacentRole(ROLES, 25, -1)?.name, 'Trainee');
  });
});

describe('matchRole', () => {
  it('matches a name however it is capitalised', () => {
    assert.equal(matchRole(ROLES, 'guard')?.id, 3);
    assert.equal(matchRole(ROLES, 'GUARD CAPTAIN')?.id, 4);
  });

  it('prefers an exact name over a prefix', () => {
    assert.equal(matchRole(ROLES, 'Guard')?.name, 'Guard', 'not Guard Captain');
  });

  it('refuses an ambiguous prefix rather than guessing', () => {
    assert.equal(matchRole(ROLES, 'Guar'), null);
  });

  it('matches a rank number', () => {
    assert.equal(matchRole(ROLES, '50')?.name, 'Guard');
  });

  it('is null for a rank that does not exist', () => {
    assert.equal(matchRole(ROLES, 'Warden'), null);
    assert.equal(matchRole(ROLES, ''), null);
  });
});

describe('isGroupConfigured', () => {
  it('is on once a group id and a cookie are set', () => {
    assert.equal(isGroupConfigured(), true);
  });
});

describe('robloxErrorMessage', () => {
  it('pulls the message out of the errors array Roblox sends back', () => {
    const error = new HttpError(
      403,
      JSON.stringify({ errors: [{ code: 23, message: 'You do not have permission to manage this member.' }] }),
      new Headers(),
      'https://groups.roblox.com/v1/groups/1/users/2',
    );
    assert.equal(robloxErrorMessage(error), 'You do not have permission to manage this member.');
  });

  it('falls back to something readable when the body is not JSON', () => {
    const error = new HttpError(401, '<html>nope</html>', new Headers(), 'https://groups.roblox.com/');
    assert.match(robloxErrorMessage(error), /cookie is invalid or expired/);
  });

  it('describes a plain error too', () => {
    assert.equal(robloxErrorMessage(new Error('socket hang up')), 'socket hang up');
  });
});
