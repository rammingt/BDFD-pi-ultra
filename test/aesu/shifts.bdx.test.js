'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { setup } = require('./harness');

describe('shift commands in BDX', () => {
  let h;
  before(async () => { h = await setup(); });

  it('shows the picker when nobody is on shift', async () => {
    const r = await h.run('shift manage', { options: {} });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /Pick the kind of shift/);
    const start = h.buttons(r).find((b) => b.custom_id?.startsWith('aesu:panel_start'));
    assert.equal(start.disabled, true);
    const menu = h.buttons(r).find((b) => b.type === 3);
    assert.equal(menu.options.length, 4);
  });

  it('arms Start once a type is picked', async () => {
    const r = await h.run('aesu:panel_type', { selectValues: ['shift_guard'] });
    assert.equal(r.update, true);
    assert.match(h.text(r), /Selected \*\*Shift Guard\*\*/);
    const start = h.buttons(r).find((b) => b.custom_id?.startsWith('aesu:panel_start'));
    assert.equal(start.custom_id, 'aesu:panel_start:shift_guard');
    assert.equal(start.disabled, false);
    assert.equal(h.buttons(r).find((b) => b.type === 3).options.find((o) => o.value === 'shift_guard').default, true);
  });

  it('starts, breaks, resumes and ends a shift, logging each step', async () => {
    let r = await h.run('aesu:panel_start', { args: ['shift_guard'] });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /Shift Guard\nOn shift/);
    assert.equal(h.client.sent.length, 1, 'one log entry posted');
    assert.match(h.text({ content: '', layout: h.client.sent[0].payload.components }), /<@100000000000000001> · On shift/);

    r = await h.run('aesu:panel_start', { args: ['shift_guard'] });
    assert.equal(r.stopped, true);
    assert.match(r.content, /already have a shift running/);

    r = await h.run('aesu:panel_break');
    assert.match(h.text(r), /On break/);
    assert.ok(h.buttons(r).some((b) => b.custom_id === 'aesu:panel_resume'));
    r = await h.run('aesu:panel_resume');
    assert.ok(h.buttons(r).some((b) => b.custom_id === 'aesu:panel_break'));

    r = await h.run('aesu:panel_end');
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /Shift ended\. \*\*\d+s\*\* banked on your Shift Guard and 0s on break\./);
    assert.equal(h.client.sent.length, 1, 'the log entry is edited, not posted again');
    assert.ok(h.client.edits.length >= 3);
    assert.match(h.text({ content: '', layout: h.client.edits.at(-1).payload.components }), /Closed by:\*\* Ended from the panel/);
  });

  it('refuses a break with nothing running', async () => {
    const r = await h.run('aesu:panel_break');
    assert.equal(r.stopped, true);
    assert.equal(r.content, 'You do not have a shift running right now.');
  });

  it('lists history and totals', async () => {
    let r = await h.run('shift history', { options: {} });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /\*\*\d+s\*\* · Shift Guard/);
    r = await h.run('checktime', { options: { range: 'week' } });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /\*\*Shifts:\*\* 1/);
    assert.match(h.text(r), /Range: \*\*Last 7 days\*\*/);
    assert.equal(r.ephemeral, true);
  });

  it('keeps other members totals to staff when a staff role is set', async () => {
    const { config } = require('../../src/aesu/config/index');
    config.discord.staffRoleId = '555';
    try {
      let r = await h.run('checktime', { options: { user: '100000000000000077' } });
      assert.equal(r.stopped, true);
      assert.match(r.content, /do not have permission/);
      r = await h.run('checktime', { options: { user: '100000000000000077' }, roles: ['555'] });
      assert.equal(r.stopped, false, r.content);
    } finally {
      config.discord.staffRoleId = '';
    }
  });

  it('answers join prompts only for their owner', async () => {
    let r = await h.run('aesu:prompt_accept', { args: ['100000000000000055'] });
    assert.equal(r.content, 'That prompt belongs to someone else.');
    r = await h.run('aesu:prompt_accept', { args: ['100000000000000001'], messageId: '42' });
    assert.equal(r.stopped, false, r.content);
    assert.match(h.text(r), /Pick what you are running/);
    assert.match(h.text({ content: '', layout: h.client.edits.at(-1).payload.components }), /Logging this session/);
    r = await h.run('aesu:prompt_decline', { args: ['100000000000000001'], messageId: '43' });
    assert.match(r.content, /Nothing was logged/);
  });

  it('explains that linking is not set up', async () => {
    const r = await h.run('connect', { options: {} });
    assert.equal(r.stopped, true);
    assert.match(r.content, /not configured/);
    const d = await h.run('disconnect', { options: {} });
    assert.equal(d.content, 'You do not have a Roblox account linked.');
  });
});
