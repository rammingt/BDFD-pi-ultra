'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Engine } = require('../src/engine');
const { parse } = require('../src/parser');
const { math, condition } = require('../src/expr');

const engine = new Engine({ dataFile: null });
const author = { id: '1', username: 'alice', displayName: 'Alice', avatar: 'a.png' };
async function run(code, env = {}) {
  return engine.execute({ name: 't', ast: parse(code, engine.registry) }, { author, args: [], ...env });
}

test('plain text and nested functions', async () => {
  assert.equal((await run('Hi $username!')).content, 'Hi alice!');
  assert.equal((await run('$toUppercase[$replaceText[a-b-c;-;+]]')).content, 'A+B+C');
});

test('longest-prefix name matching and escapes', async () => {
  assert.equal((await run('$authorIDx')).content, '1x');
  assert.equal((await run('costs $5 \\$username \; \\]')).content, 'costs $5 $username ; ]');
  assert.equal((await run('cheap $cheap')).content, 'cheap $cheap');
});

test('math and conditions', () => {
  assert.equal(math('2+3*4'), 14);
  assert.equal(math('(2+3)*-4'), -20);
  assert.equal(math('2^3^2'), 512);
  assert.throws(() => math('process.exit()'));
  assert.equal(condition('10>9'), true); // numeric, not string compare
  assert.equal(condition('a==a&&1!=2'), true);
  assert.equal(condition('a==b||c==c'), true);
  assert.equal(condition('a==b&&c==c'), false);
});

test('inline and block $if, lazily evaluated', async () => {
  assert.equal((await run('$if[1==1;yes;no]')).content, 'yes');
  assert.equal((await run('$if[1==2;$stop[bad];ok]')).content, 'ok');
  const code = '$if[$message[1]==a]A$elseif[$message[1]==b]B$else C$endif';
  assert.equal((await run(code, { args: ['a'] })).content, 'A');
  assert.equal((await run(code, { args: ['b'] })).content, 'B');
  assert.equal((await run(code, { args: ['z'] })).content, 'C');
  assert.equal((await run('$if[1==1]$if[2==3]x$else y$endif$endif')).content, 'y');
});

test('$onlyIf stops and discards embeds', async () => {
  const r = await run('$title[hi]$onlyIf[1==2;nope]after');
  assert.equal(r.content, 'nope');
  assert.equal(r.embeds.length, 0);
  assert.equal(r.stopped, true);
});

test('variables', async () => {
  await run('$setUserVar[coins;5]');
  assert.equal((await run('$getUserVar[coins]')).content, '5');
  assert.equal((await run('$getUserVar[coins;2]')).content, '');
  assert.equal((await run('$var[x;3]$math[$var[x]*2]')).content, '6');
  await run('$setUserVar[coins;9;2]');
  assert.equal((await run('$userLeaderboard[coins;2;%user%=%value%]')).content, '2=9\n1=5');
});

test('embeds and buttons', async () => {
  const r = await run('$title[T]$description[D]$color[ff0000]$addField[a;b;yes]$addButton[no;id1;Click]');
  assert.deepEqual(r.embeds[0], { title: 'T', description: 'D', color: 0xff0000, fields: [{ name: 'a', value: 'b', inline: true }] });
  assert.equal(r.components[0].components[0].custom_id, 'id1');
});

test('cooldown', async () => {
  assert.equal((await run('$cooldown[1m;wait %time%]ok')).content, 'ok');
  assert.match((await run('$cooldown[1m;wait %time%]ok')).content, /^wait 1m$/);
});

test('errors are reported, not thrown', async () => {
  assert.match((await run('$math[abc]')).content, /\$math/);
  assert.equal((await run('$suppressErrors[oops]$math[abc]')).content, 'oops');
  assert.match((await run('$repeat[1000;$repeat[1000;$index]]')).content, /step limit/);
});

test('$repeat, $c, text split', async () => {
  assert.equal((await run('$repeat[3;$index;,]')).content, '1,2,3');
  assert.equal((await run('a$c[ignored $stop[x]]b')).content, 'ab');
  assert.equal((await run('$textSplit[a,b,c;,]$splitText[2]/$getTextSplitLength')).content, 'b/3');
});

test('example commands load and run', async () => {
  const e = new Engine({ commandsDir: path.join(__dirname, '../commands'), dataFile: null });
  const { errors } = e.reload();
  assert.deepEqual(errors, []);
  const hit = e.match('!bal');
  assert.equal(hit.cmd.name, 'balance');
  const r = await e.execute(hit.cmd, { author, args: [] });
  assert.match(r.embeds[0].description, /\*\*0\*\* coins/);
  const d = await e.execute(e.match('!daily').cmd, { author, args: [] });
  assert.match(d.content, /You got \*\*\d+\*\* coins/);
});
