'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

const ADMIN = '100000000000000001';
const WORKER = '100000000000000002';

describe('admin, squad, group and diagnose commands in BDX', () => {
  let h;
  before(async () => {
    h = await setup({ ADMIN_LOG_CHANNEL_ID: '700000000000000012', GROUP_STAFF_ROLE_ID: '333' });
  });

  it('asks for Administrator when no admin role is set', async () => {
    const r = await h.run('admin', { options: { action: 'panel' } });
    assert.equal(r.content, 'need admin perms or the `ADMIN_ROLE_ID` role');
  });

  it('shows who is on shift and ends one from the menu, logging it', async () => {
    await h.manager.start({ discordId: WORKER, guildId: null, type: 'shift_guard', source: 'panel', robloxUsername: 'worker' });
    let r = await h.run('admin', { options: { action: 'panel' }, admin: true });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /on shift \(1\)\n<@100000000000000002> · Shift Guard, \d+s/);
    const menu = h.buttons(r).find((b) => b.custom_id === 'aesu:admin_end_shift');
    assert.deepEqual(menu.options.map((o) => [o.label, o.value]), [['worker', WORKER]]);

    r = await h.run('aesu:admin_end_shift', { selectValues: [WORKER], admin: true });
    assert.equal(r.update, true);
    assert.match(h.text(r), /^ended <@100000000000000002> shift, \d+s banked\n/);
    assert.match(h.text(r), /nobody rn/);
    const log = h.client.sent.find((m) => m.channelId === '700000000000000012');
    assert.match(h.text({ layout: log.payload.components }), /ended <@100000000000000002> shift[\s\S]*by <@100000000000000001>/);
  });

  it('corrects banked time, and will not take more than there is', async () => {
    let r = await h.run('admin', { options: { action: 'addtime', user: WORKER, type: 'deployment', time: '1h30m' }, admin: true });
    assert.equal(r.content, '+1h 30m Deployment for <@100000000000000002>, now at 1h 30m');
    r = await h.run('admin', { options: { action: 'removetime', user: WORKER, type: 'deployment', time: '2h' }, admin: true });
    assert.match(r.content, /only got 1h 30m of Deployment, cant take 2h 00m/);
    r = await h.run('admin', { options: { action: 'removetime', user: WORKER, type: 'deployment', time: '30m' }, admin: true });
    assert.match(r.content, /-30m 00s Deployment/);
    r = await h.run('shift', { options: { action: 'history', user: WORKER }, admin: true });
    assert.match(h.text(r), /-30m 00s · Deployment \*\(adjusted\)\*/);
  });

  it('keeps /group to its staff role, and says when no group is set', async () => {
    let r = await h.run('group', { options: { action: 'roles' } });
    assert.equal(r.content, 'only <@&333> can manage the group');
    r = await h.run('group', { options: { action: 'roles' }, roles: ['333'] });
    assert.match(r.content, /group stuff is off/);
  });

  it('asks for an option the picked action needs', async () => {
    const r = await h.run('group', { options: { action: 'accept' }, roles: ['333'] });
    assert.equal(r.content, 'fill in player for /group action:accept');
    assert.equal(r.stopped, true);
  });

  it('reads the squad off Discord roles', async () => {
    const r = await h.run('squad', { options: { action: 'info' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(r.content, /^<@100000000000000001> got no squad\nevents hosted: 0/);
  });

  it('diagnoses a setup with presence tracking off', async () => {
    const r = await h.run('diagnose', { options: {} });
    assert.equal(r.stopped, false, r.content);
    const text = h.text(r);
    assert.match(text, /storage ⚠️\njson file/);
    assert.match(text, /tracked games ❌/);
    assert.match(text, /❌ presence is off/);
  });
});
