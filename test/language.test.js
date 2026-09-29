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

test('$httpAddHeader, $httpStatus and $env', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer k';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { a: { b: 'hi' } } : { detail: 'no' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  process.env.BDX_TEST_KEY = 'k';
  try {
    const r = await run(`$httpAddHeader[Authorization;Bearer $env[BDX_TEST_KEY]]$httpGet[${url}]$httpStatus $httpResult[a;b]`);
    assert.equal(r.content, '200 hi');
    // headers only apply to the next request
    assert.equal((await run(`$httpGet[${url}]$httpStatus`)).content, '401');
    assert.match((await run('$env[DISCORD_TOKEN]')).content, /BDX_/);
  } finally {
    server.close();
  }
});

test('$attachFile, $jsonPretty and $include', async () => {
  const r = await run('$jsonParse[{"a":{"b":1}}]$attachFile[a.json;$jsonPretty[a]]done');
  assert.equal(r.content, 'done');
  assert.deepEqual(r.files, [{ name: 'a.json', content: '{\n  "b": 1\n}', encoding: 'utf8' }]);
  const img = await run('$attachFile[x.png;aGk=;base64]$attachFile[empty.png;;base64]');
  assert.deepEqual(img.files, [{ name: 'x.png', content: 'aGk=', encoding: 'base64' }]); // empty pictures are skipped
  assert.equal((await run('$jsonParse[{"a":1}]$jsonPretty[missing]')).content, '');

  const { loadDir } = require('../src/loader');
  const e = new Engine({ dataFile: null });
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdx-'));
  fs.writeFileSync(path.join(dir, 'x.bdx'), '@name card\n@type snippet\n$title[Hi $var[who]]\n---\n@name show\n$var[who;bob]$include[card]ok');
  e.setCommands(loadDir(dir, e.registry).commands);
  const out = await e.execute(e.match('!show').cmd, { author, args: [] });
  assert.equal(out.content, 'ok');
  assert.equal(out.embeds[0].title, 'Hi bob');
  assert.equal(e.match('!card'), null); // snippets can't be run as commands
  assert.match((await e.execute(e.match('!show').cmd, { author, args: [] })).content, /ok/);
  fs.rmSync(dir, { recursive: true });
});

test('lines with only functions leave no blank lines', async () => {
  assert.equal((await run('$title[a]\n$color[ff0000]\nHello\n$var[x;1]\nBye')).content, 'Hello\nBye');
  assert.equal((await run('$username\nnext')).content, 'alice\nnext'); // printed something, so the break stays
  assert.equal((await run('Top\n\nBottom')).content, 'Top\n\nBottom'); // blank lines you write yourself stay
  assert.equal((await run('$if[1==1]\nYes\n$else\nNo\n$endif\nDone')).content, 'Yes\nDone');
});

test('containers', async () => {
  const r = await run([
    '$addContainer[card;ff0000]',
    '$addSection[## Hi;https://x/a.png]',
    '$addSeparator[no;large]',
    '$addTextDisplay[Body]',
    '$addButton[no;b:1;Press;primary]',
    '$addMediaGallery[https://x/1.png;https://x/2.png]',
    '$closeContainer',
    '$addTextDisplay[Outside]',
    '$addButton[no;b:2;Below;secondary]',
    '$addContainer[empty]$closeContainer',
  ].join('\n'));
  assert.equal(r.content, '');
  assert.equal(r.layout.length, 2); // the empty container is dropped
  const [box, outside] = r.layout;
  assert.equal(box.accent_color, 0xff0000);
  assert.deepEqual(box.components.map((c) => c.type), [9, 14, 10, 1, 12]);
  assert.equal(box.components[0].accessory.media.url, 'https://x/a.png');
  assert.deepEqual(box.components[1], { type: 14, divider: false, spacing: 2 });
  assert.equal(box.components[3].components[0].custom_id, 'b:1');
  assert.equal(box.components[4].items.length, 2);
  assert.deepEqual(outside, { type: 10, content: 'Outside' });
  assert.equal(r.components[0].components[0].custom_id, 'b:2');
  assert.match((await run('$addTextDisplay[x;nope]')).content, /no container called "nope"/);
  assert.equal((await run('$addSection[Just text]')).layout[0].type, 10); // no picture: plain text block
});

test('$jsonList, $jsonCount, $jsonStash and menus', async () => {
  const json = '{"items":[{"n":"a","s":1,"u":{"x":"X"}},{"n":"b","s":2}],"o":{"k":1}}';
  const list = (t) => run(`$jsonParse[${json}]${t}`);
  assert.equal((await list('$jsonList[items;{#}. {n} {s} {u.x|none}]')).content, '1. a 1 X\n2. b 2 none');
  assert.equal((await list('$jsonList[items;{n};1;;and {n} more]')).content, 'a\nand 1 more');
  assert.equal((await list('$jsonList[items;{n};;, ]')).content, 'a, b');
  assert.equal((await list('$jsonCount[items] $jsonCount[o] $jsonCount[nope]')).content, '2 1 0');

  const token = (await list('$jsonStash')).content;
  assert.match(token, /^[a-f0-9]{20}$/);
  assert.equal((await run(`$jsonUnstash[${token};yes] $json[items;1;n]`)).content, 'ok b');
  const other = await engine.execute({ name: 't', ast: parse(`$jsonUnstash[${token};yes]`, engine.registry) }, { author: { id: '2' }, args: [] });
  assert.equal(other.content, 'notyours');
  assert.equal((await run('$jsonUnstash[nope]')).content, 'expired');

  const m = await list('$addSelectMenu[pick:1;Pick;1;10]$addSelectOptions[items;{n};{s};score {s}]$addSelectOption[c;3]');
  const menu = m.components[0].components[0];
  assert.deepEqual(menu.options.map((o) => o.value), ['1', '2', '3']);
  assert.equal(menu.max_values, 3); // never more than there are options
  assert.equal(menu.options[0].description, 'score 1');
  const picked = await engine.execute({ name: 't', ast: parse('$selectedValues[+]', engine.registry) }, { author, args: [], selectValues: ['1', '3'] });
  assert.equal(picked.content, '1+3');
});

test('slash subcommands and option choices load', () => {
  const { parseCommandFile } = require('../src/loader');
  const [c] = parseCommandFile('@name flag add\n@type slash\n@parent Manage flags\n@option type:string:Kind::badge=Badge|asset\nhi', 'x.bdx', engine.registry);
  assert.equal(c.name, 'flag add');
  assert.equal(c.parent, 'Manage flags');
  assert.deepEqual(c.options[0].choices, [{ value: 'badge', name: 'Badge' }, { value: 'asset', name: 'asset' }]);
  assert.equal(c.options[0].required, false);
});
