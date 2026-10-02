'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

const ME = '100000000000000001';

describe('promotion commands in BDX', () => {
  let h;
  let progress;
  let applied = [];
  before(async () => {
    h = await setup({ PROMOTION_CHANNEL_ID: '700000000000000010', PROMOTION_STAFF_ROLE_ID: '444' });
    const { measureRank, parseRequirements } = require('../../src/aesu/ranks/types');
    const guard = { roleId: 10, rank: 10, name: 'Recruit', requirements: [], general: [], mode: 'manual', notes: null, memberCount: 4 };
    const next = { roleId: 20, rank: 20, name: 'Guard', requirements: parseRequirements('shift guard 2h, 1 event').requirements, general: ['Pass the exam'], mode: 'approval', notes: null, memberCount: 2 };
    await h.ranks.replace([guard, next]);
    progress = { discordId: ME, current: guard, next, ...measureRank(next, new Map([['shift_guard', 150]]), 1) };
    h.ranks.progress = async (id) => ({ ...progress, discordId: id });
    h.ranks.requestPromotion = async () => ({ outcome: 'needs_approval', rank: next, progress });
    h.ranks.apply = async (id, rank) => { applied.push([id, rank.name]); return { ok: true }; };
  });

  it('shows progress with a bar per requirement', async () => {
    const r = await h.run('promote', { options: { action: 'check' } });
    assert.equal(r.stopped, false, r.content);
    const text = h.text(r);
    assert.match(text, /### Promotion to Guard/);
    assert.match(text, /Currently Recruit/);
    assert.match(text, /Run `\/promote action:request` to promote\./);
    assert.match(text, /✅ .+\n`████████████` 2h 30m \/ 2h/);
    assert.match(text, /General requirements\n• Pass the exam/);
  });

  it('posts a request card for staff, pinging their role', async () => {
    const r = await h.run('promote', { options: { action: 'request' } });
    assert.match(r.content, /your request is sent/);
    const card = h.client.sent.at(-1);
    assert.equal(card.channelId, '700000000000000010');
    assert.deepEqual(card.payload.allowedMentions, { users: [], roles: ['444'] });
    assert.match(h.text({ layout: card.payload.components }), /<@&444>/);
    const ids = h.buttons({ layout: card.payload.components }).map((b) => b.custom_id);
    assert.deepEqual(ids, [`aesu:promote_ok:${ME}:20`, `aesu:promote_no:${ME}:20`]);
    h.card = card;
  });

  it('only lets promotion staff decide, once', async () => {
    let r = await h.run('aesu:promote_ok', { args: [ME, '20'], messageId: h.card.id, channelId: h.card.channelId });
    assert.equal(r.content, 'Only <@&444> can decide promotions.');
    r = await h.run('aesu:promote_ok', { args: [ME, '20'], messageId: h.card.id, channelId: h.card.channelId, roles: ['444'] });
    assert.equal(r.stopped, false, r.content);
    assert.match(r.content, /is now Guard/);
    assert.deepEqual(applied, [[ME, 'Guard']]);
    const redrawn = h.client.edits.at(-1);
    assert.match(h.text({ layout: redrawn.payload.components }), /Approved by <@100000000000000001>\nSet to Guard/);
    assert.equal(h.buttons({ layout: redrawn.payload.components }).length, 0);
    r = await h.run('aesu:promote_no', { args: [ME, '20'], messageId: h.card.id, channelId: h.card.channelId, roles: ['444'] });
    assert.equal(r.content, 'That request has already been decided.');
  });

  it('lists the ranks', async () => {
    const r = await h.run('promote', { options: { action: 'ranks' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /` 20` Guard \(needs approval · 2 member\(s\)\)\n2h of Shift Guard, 1 event hosted/);
  });
});
