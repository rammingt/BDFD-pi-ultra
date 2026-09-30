'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.SHIFT_ROLE_ON_DUTY = 'role-on-duty';
process.env.SHIFT_ROLE_ON_BREAK = 'role-on-break';
process.env.SHIFT_ROLE_OFF_DUTY = 'role-off-duty';
process.env.DISCORD_GUILD_ID = 'guild-1';
process.env.LOG_LEVEL = 'error';

const { dutyState, roleChange, syncDutyRoles } = require('../../../src/aesu/discord/roles');
const { ShiftManager } = require('../../../src/aesu/shifts/manager');
const { makeShift } = require('./helpers');

/** A member who already holds `held`, recording what the sync does to them. */
function stubClient(held) {
  const calls = { added: [], removed: [] };
  const roles = new Set(held);

  const guild = {
    name: 'Aesu',
    members: {
      fetch: async () => ({
        roles: {
          cache: { has: (id) => roles.has(id) },
          add: async (id) => void calls.added.push(id),
          remove: async (ids) => void calls.removed.push(...ids),
        },
      }),
    },
  };

  return { client: { guilds: { fetch: async () => guild, cache: new Map() } }, calls };
}

/** A manager whose open shift is whatever the test says it is. */
function stubManager(open) {
  return { getOpenShift: async () => open };
}

describe('dutyState', () => {
  it('reads the state off the open shift', () => {
    assert.equal(dutyState(null), 'off_duty');
    assert.equal(dutyState(makeShift({ status: 'active', endedAt: null })), 'on_duty');
    assert.equal(dutyState(makeShift({ status: 'on_break', endedAt: null })), 'on_break');
    assert.equal(dutyState(makeShift({ status: 'ended' })), 'off_duty');
  });
});

describe('roleChange', () => {
  it('names one role to hold and the rest to drop', () => {
    assert.deepEqual(roleChange('on_duty'), { wanted: 'role-on-duty', unwanted: ['role-on-break', 'role-off-duty'] });
    assert.deepEqual(roleChange('on_break'), { wanted: 'role-on-break', unwanted: ['role-on-duty', 'role-off-duty'] });
    assert.deepEqual(roleChange('off_duty'), { wanted: 'role-off-duty', unwanted: ['role-on-duty', 'role-on-break'] });
  });
});

describe('syncDutyRoles', () => {
  it('swaps the off-duty role for the on-duty one when a shift starts', async () => {
    const { client, calls } = stubClient(['role-off-duty']);
    await syncDutyRoles(client, stubManager(makeShift({ status: 'active', endedAt: null })), 'guild-1', 'discord-1');

    assert.deepEqual(calls.added, ['role-on-duty']);
    assert.deepEqual(calls.removed, ['role-off-duty']);
  });

  it('moves them to the break role, and back again', async () => {
    const onBreak = stubClient(['role-on-duty']);
    await syncDutyRoles(onBreak.client, stubManager(makeShift({ status: 'on_break', endedAt: null })), 'guild-1', 'd1');
    assert.deepEqual(onBreak.calls.added, ['role-on-break']);
    assert.deepEqual(onBreak.calls.removed, ['role-on-duty']);

    const resumed = stubClient(['role-on-break']);
    await syncDutyRoles(resumed.client, stubManager(makeShift({ status: 'active', endedAt: null })), 'guild-1', 'd1');
    assert.deepEqual(resumed.calls.added, ['role-on-duty']);
    assert.deepEqual(resumed.calls.removed, ['role-on-break']);
  });

  it('puts them back off duty once no shift is open', async () => {
    const { client, calls } = stubClient(['role-on-duty', 'role-on-break']);
    await syncDutyRoles(client, stubManager(null), 'guild-1', 'discord-1');

    assert.deepEqual(calls.added, ['role-off-duty']);
    assert.deepEqual(calls.removed, ['role-on-duty', 'role-on-break']);
  });

  it('touches nothing when the member already has the right role', async () => {
    const { client, calls } = stubClient(['role-on-duty']);
    await syncDutyRoles(client, stubManager(makeShift({ status: 'active', endedAt: null })), 'guild-1', 'discord-1');

    assert.deepEqual(calls.added, []);
    assert.deepEqual(calls.removed, []);
  });

  it('reads the state from the open shift, not from whatever triggered it', async () => {
    // An event banking a finished shift must not mark somebody off duty mid-shift.
    const { client, calls } = stubClient(['role-off-duty']);
    await syncDutyRoles(client, stubManager(makeShift({ status: 'on_break', endedAt: null })), 'guild-1', 'discord-1');

    assert.deepEqual(calls.added, ['role-on-break']);
  });
});
