'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

const HOST = '100000000000000001';
const GUEST = '100000000000000002';

describe('event commands in BDX', () => {
  let h;
  let id;
  before(async () => { h = await setup({ ALLOW_MANUAL_START_OUTSIDE_GAME: 'yes' }); });

  it('posts an event with a button per sign up option', async () => {
    const r = await h.run('event', { userId: HOST, options: { action: 'create', name: 'Patrol', start: '2h', type: 'shift_guard', roles: 'Guard:2, Medic' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(r.content, /Patrol posted in <#700000000000000009>/);
    id = /id `(\w+)`/.exec(r.content)[1];
    const post = h.client.sent.at(-1);
    assert.equal(post.channelId, '700000000000000009');
    const ids = h.buttons({ layout: post.payload.components }).map((b) => b.custom_id);
    assert.deepEqual(ids, [`aesu:event_join:${id}:guard`, `aesu:event_join:${id}:medic`, `aesu:event_join:${id}:declined`, `aesu:event_end:${id}`, `aesu:event_cancel:${id}`]);
    assert.match(h.text({ layout: post.payload.components }), /Guard \(0\/2\)\nnobody yet/);
  });

  it('turns away bad input', async () => {
    const r = await h.run('event', { userId: HOST, options: { action: 'create', name: 'X', start: 'whenever', type: 'shift_guard' } });
    assert.equal(r.stopped, true);
    assert.match(r.content, /isnt a time/);
  });

  it('needs a linked account to sign up, but not to decline', async () => {
    let r = await h.run('aesu:event_join', { userId: GUEST, args: [id, 'guard'] });
    assert.equal(r.stopped, true);
    assert.match(r.content, /\/connect/);
    r = await h.run('aesu:event_join', { userId: GUEST, args: [id, 'declined'] });
    assert.equal(r.stopped, false, r.content);
    assert.equal(r.content, 'ok put u down as Cant make it');
    const redraw = h.client.edits.at(-1);
    assert.match(h.text({ layout: redraw.payload.components }), /Cant make it \(1\)\n<@100000000000000002>/);
  });

  it('lets a linked member sign up and shows it on the post', async () => {
    const now = Date.now();
    await h.store.upsertLink({ discordId: GUEST, robloxId: '55', robloxUsername: 'guest', robloxDisplayName: 'Guest', accessToken: null, refreshToken: null, tokenExpiresAt: null, linkedAt: now, updatedAt: now });
    const r = await h.run('aesu:event_join', { userId: GUEST, args: [id, 'guard'] });
    assert.equal(r.stopped, false, r.content);
    assert.match(r.content, /signed up as Guard/);
    assert.match(h.text({ layout: h.client.edits.at(-1).payload.components }), /Guard \(1\/2\)\n<@100000000000000002>/);
  });

  it('lists and shows events', async () => {
    let r = await h.run('event', { userId: HOST, options: { action: 'list' } });
    assert.match(h.text(r), new RegExp(`\`${id}\` Patrol`));
    r = await h.run('event', { userId: HOST, options: { action: 'info', id } });
    assert.match(h.text(r), /## Patrol/);
    assert.equal(h.buttons(r).length, 0, 'no buttons on the private copy');
  });

  it('only lets the host or staff end it, and not before it starts', async () => {
    const { config } = require('../../src/aesu/config/index');
    config.discord.staffRoleId = '555';
    try {
      let r = await h.run('aesu:event_end', { userId: GUEST, args: [id] });
      assert.match(r.content, /only the host or staff/);
      r = await h.run('aesu:event_end', { userId: HOST, args: [id] });
      assert.match(r.content, /hasnt started yet/);
      await h.events.begin(id, Date.now());
      const ping = h.client.sent.at(-1);
      assert.match(h.text({ layout: ping.payload.components, content: '' }) || ping.payload.content, /Patrol starting now <@100000000000000002>/);
      assert.deepEqual(ping.payload.allowedMentions, { users: [GUEST], roles: [] });
      r = await h.run('aesu:event_end', { userId: HOST, args: [id] });
      assert.equal(r.stopped, false, r.content);
      assert.match(r.content, /Patrol ended, time logged for 0/);
      const final = h.client.edits.at(-1);
      assert.equal(h.buttons({ layout: final.payload.components }).length, 0, 'buttons go once it is over');
      assert.match(h.text({ layout: final.payload.components }), /nobody was in game long enough/);
    } finally {
      config.discord.staffRoleId = '';
    }
  });
});
