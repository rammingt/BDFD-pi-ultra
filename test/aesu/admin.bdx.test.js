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
    const r = await h.run('admin panel', { options: {} });
    assert.equal(r.content, 'This needs the **Administrator** permission, or an `ADMIN_ROLE_ID` role.');
  });

  it('shows who is on shift and ends one from the menu, logging it', async () => {
    await h.manager.start({ discordId: WORKER, guildId: null, type: 'shift_guard', source: 'panel', robloxUsername: 'worker' });
    let r = await h.run('admin panel', { options: {}, admin: true });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /\*\*On shift \(1\)\*\*\n<@100000000000000002> · Shift Guard, \d+s/);
    const menu = h.buttons(r).find((b) => b.custom_id === 'aesu:admin_end_shift');
    assert.deepEqual(menu.options.map((o) => [o.label, o.value]), [['worker', WORKER]]);

    r = await h.run('aesu:admin_end_shift', { selectValues: [WORKER], admin: true });
    assert.equal(r.update, true);
    assert.match(h.text(r), /^Ended <@100000000000000002>'s shift, \*\*\d+s\*\* banked\.\n/);
    assert.match(h.text(r), /Nobody is on shift\./);
    const log = h.client.sent.find((m) => m.channelId === '700000000000000012');
    assert.match(h.text({ layout: log.payload.components }), /Ended <@100000000000000002>'s shift[\s\S]*By <@100000000000000001>/);
  });

  it('corrects banked time, and will not take more than there is', async () => {
    let r = await h.run('admin addtime', { options: { user: WORKER, type: 'deployment', time: '1h30m' }, admin: true });
    assert.equal(r.content, '**+1h 30m** of Deployment for <@100000000000000002>. They now have **1h 30m** of it.');
    r = await h.run('admin removetime', { options: { user: WORKER, type: 'deployment', time: '2h' }, admin: true });
    assert.match(r.content, /only has \*\*1h 30m\*\* of Deployment, so 2h 00m cannot come off/);
    r = await h.run('admin removetime', { options: { user: WORKER, type: 'deployment', time: '30m' }, admin: true });
    assert.match(r.content, /\*\*-30m 00s\*\* of Deployment/);
    r = await h.run('shift history', { options: { user: WORKER }, admin: true });
    assert.match(h.text(r), /\*\*-30m 00s\*\* · Deployment \*\(adjusted\)\*/);
  });

  it('keeps /group to its staff role, and says when no group is set', async () => {
    let r = await h.run('group roles', { options: {} });
    assert.equal(r.content, 'Only <@&333> can manage the group.');
    r = await h.run('group roles', { options: {}, roles: ['333'] });
    assert.match(r.content, /Group management is off/);
  });

  it('reads the squad off Discord roles', async () => {
    const r = await h.run('squad info', { options: {} });
    assert.equal(r.stopped, false, r.content);
    assert.match(r.content, /^<@100000000000000001> is not in a squad\.\nEvents hosted: \*\*0\*\*/);
  });

  it('diagnoses a setup with presence tracking off', async () => {
    const r = await h.run('diagnose', { options: {} });
    assert.equal(r.stopped, false, r.content);
    const text = h.text(r);
    assert.match(text, /\*\*Storage\*\* ⚠️\nJSON file/);
    assert.match(text, /\*\*Tracked games\*\* ❌/);
    assert.match(text, /❌ \*\*Presence tracking is off\.\*\*/);
  });
});
