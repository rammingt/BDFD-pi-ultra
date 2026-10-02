'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

const STAFF = '100000000000000001';
const CADET = '100000000000000002';
const ROLES = { orientation: '901', academy: '902', final_exam: '903', waiting: '904' };

describe('/academy', () => {
  let h;
  let sheet;
  let held;
  before(async () => {
    h = await setup({
      ACADEMY_STAFF_ROLE_ID: '777', DISCORD_GUILD_ID: '200000000000000002',
      ACADEMY_ROLE_ORIENTATION: ROLES.orientation, ACADEMY_ROLE_ACADEMY: ROLES.academy,
      ACADEMY_ROLE_FINAL_EXAM: ROLES.final_exam, ACADEMY_ROLE_WAITING: ROLES.waiting,
    });
    // A member whose roles change, in a server the bot can find
    held = new Set();
    const member = { roles: { cache: { has: (id) => held.has(id) }, add: async (id) => { held.add(id); }, remove: async (ids) => { for (const id of [].concat(ids)) held.delete(id); } } };
    h.client.guilds.fetch = async () => ({ name: 'AESU', members: { fetch: async () => member } });
    // A sheet that remembers what was written to it
    sheet = { grid: [], ensureTabs: async () => [], read: async () => sheet.grid, replace: async (tab, values) => { sheet.grid = values.map((r) => r.map(String)); } };
    const { Academy } = require('../../src/aesu/academy');
    h.runtime.academy = new Academy(h.store, h.client);
    h.runtime.academy.sheet = sheet;
  });

  it('keeps moving people to its staff role', async () => {
    const r = await h.run('academy', { options: { action: 'set', user: CADET, phase: 'orientation' } });
    assert.equal(r.content, 'Only <@&777> can do that.');
  });

  it('adds somebody on a phase, gives the role and writes the sheet', async () => {
    const r = await h.run('academy', { options: { action: 'set', user: CADET, phase: 'orientation' }, roles: ['777'] });
    assert.equal(r.stopped, false, r.content);
    assert.equal(r.content, '<@100000000000000002> joined the academy on phase 1, Orientation.');
    assert.deepEqual([...held], [ROLES.orientation]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(sheet.grid[0], ['Discord ID', 'Name', 'Roblox', 'Phase', 'Phase since', 'Moved by', 'Notes']);
    assert.equal(sheet.grid[1][0], CADET);
    assert.equal(sheet.grid[1][3], 'Orientation');
  });

  it('moves them on, swapping the role', async () => {
    const r = await h.run('academy', { options: { action: 'set', user: CADET, phase: 'final_exam' }, roles: ['777'] });
    assert.equal(r.content, '<@100000000000000002> moved from Orientation to phase 3, Final exam.');
    assert.deepEqual([...held], [ROLES.final_exam]);
    const again = await h.run('academy', { options: { action: 'set', user: CADET, phase: 'final_exam' }, roles: ['777'] });
    assert.equal(again.content, '<@100000000000000002> is already on Final exam.');
  });

  it('shows a member and the list', async () => {
    let r = await h.run('academy', { userId: CADET, options: { action: 'info' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /Phase 3 · Final exam/);
    r = await h.run('academy', { options: { action: 'list' } });
    assert.match(h.text(r), /Academy · 1 people/);
    assert.match(h.text(r), /Phase 3 · Final exam \(1\)\n<@100000000000000002>/);
    assert.match(h.text(r), /Phase 1 · Orientation \(0\)\nNobody/);
  });

  it('follows a phase changed in the sheet, and notes typed there', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    sheet.grid[1][3] = 'Waiting for division';
    sheet.grid[1][6] = 'Passed with 9/10';
    sheet.grid.push(['100000000000000003', '', '', 'Phase 2', '', '', '']);
    const r = await h.run('academy', { options: { action: 'sync' }, roles: ['777'] });
    assert.equal(r.content, 'Synced with the Academy tab. 1 added, 1 moved and 0 removed from the sheet.');
    // There is only one pretend member, so it ends on the role of the last one moved: phase 2.
    assert.deepEqual([...held], [ROLES.academy]);
    const info = await h.run('academy', { userId: CADET, options: { action: 'info' } });
    assert.match(h.text(info), /Phase 4 · Waiting for division/);
    assert.match(h.text(info), /Notes: Passed with 9\/10/);
    assert.match(h.text(info), /Moved by the sheet/);
  });

  it('takes out somebody whose row was deleted from the sheet', async () => {
    sheet.grid = sheet.grid.filter((row) => row[0] !== '100000000000000003');
    const r = await h.run('academy', { options: { action: 'sync' }, roles: ['777'] });
    assert.match(r.content, /0 added, 0 moved and 1 removed/);
    const gone = await h.run('academy', { userId: '100000000000000003', options: { action: 'info' } });
    assert.equal(gone.content, '<@100000000000000003> is not in the academy.');
  });

  it('removes somebody and every phase role', async () => {
    const r = await h.run('academy', { options: { action: 'remove', user: CADET }, roles: ['777'] });
    assert.equal(r.content, '<@100000000000000002> is out of the academy. They were on Waiting for division.');
    assert.deepEqual([...held], []);
  });
});
