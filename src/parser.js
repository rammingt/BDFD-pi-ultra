'use strict';
// Parses BDX/BDFD source into an AST.
//   Text node:  { t: 'text', v: 'hello' }
//   Call node:  { t: 'call', name: 'if', args: [nodes[], ...] | null }
//   If block:   { t: 'if', branches: [{ cond: nodes, body: nodes }], else: nodes|null }
// Parsing happens once per command (cached), so runtime is just a tree walk.

const NAME_CHAR = /[a-zA-Z0-9]/;

function parse(src, registry) {
  const pos = { i: 0 };
  const nodes = parseSeq(src, pos, registry, false);
  return buildBlocks(nodes);
}

// Parse until end (or until ']' / ';' at depth 0 when inArgs).
function parseSeq(src, pos, registry, inArgs) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  while (pos.i < src.length) {
    const ch = src[pos.i];
    if (ch === '\\' && pos.i + 1 < src.length && '$;[]\\'.includes(src[pos.i + 1])) {
      buf += src[pos.i + 1]; pos.i += 2; continue;
    }
    if (inArgs && (ch === ';' || ch === ']')) break;
    if (ch === '$') {
      const call = tryParseCall(src, pos, registry);
      if (call) { flush(); out.push(call); continue; }
    }
    if (inArgs && ch === '[') {
      // literal bracket pair inside an argument: keep it balanced
      buf += ch; pos.i++;
      const inner = parseSeq(src, pos, registry, true);
      flush(); out.push(...inner);
      while (src[pos.i] === ';') { buf += ';'; pos.i++; flush(); out.push(...parseSeq(src, pos, registry, true)); }
      if (src[pos.i] === ']') { buf += ']'; pos.i++; }
      continue;
    }
    buf += ch; pos.i++;
  }
  flush();
  return mergeText(out);
}

function tryParseCall(src, pos, registry) {
  let j = pos.i + 1;
  while (j < src.length && NAME_CHAR.test(src[j])) j++;
  const word = src.slice(pos.i + 1, j);
  // Longest known prefix wins, like BDFD ($authorIDxyz -> $authorID + "xyz").
  let name = null;
  for (let k = word.length; k > 0; k--) {
    const cand = word.slice(0, k).toLowerCase();
    if (registry.has(cand)) { name = cand; j = pos.i + 1 + k; break; }
  }
  if (!name) return null;
  // functions like $c must have brackets, so "$cheap" stays plain text
  if (src[j] !== '[' && registry.get(name)?.requiresArgs) return null;
  pos.i = j;
  if (src[pos.i] !== '[') return { t: 'call', name, args: null };
  pos.i++; // skip '['
  const args = [];
  for (;;) {
    args.push(parseSeq(src, pos, registry, true));
    if (src[pos.i] === ';') { pos.i++; continue; }
    if (src[pos.i] === ']') { pos.i++; break; }
    break; // unterminated: be forgiving
  }
  return { t: 'call', name, args };
}

function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.t === 'text' && last && last.t === 'text') last.v += n.v;
    else out.push(n);
  }
  return out;
}

// Turn $if[cond] ... $elseif[cond] ... $else ... $endif into structured blocks.
function buildBlocks(nodes) {
  const pos = { i: 0 };
  const res = blockSeq(nodes, pos, false);
  return res.body;
}

const isCall = (n, name) => n && n.t === 'call' && n.name === name;
const isBlockIf = (n) => isCall(n, 'if') && n.args && n.args.length === 1;

function blockSeq(nodes, pos, inIf) {
  const body = [];
  while (pos.i < nodes.length) {
    const n = nodes[pos.i];
    if (inIf && (isCall(n, 'elseif') || isCall(n, 'else') || isCall(n, 'endif'))) return { body, stop: n };
    pos.i++;
    if (isBlockIf(n)) {
      const block = { t: 'if', branches: [], else: null };
      let cond = n.args[0];
      for (;;) {
        const r = blockSeq(nodes, pos, true);
        if (cond !== undefined) block.branches.push({ cond, body: r.body }); else block.else = r.body;
        if (!r.stop) break; // missing $endif: close at end
        pos.i++;
        if (r.stop.name === 'endif') break;
        if (r.stop.name === 'elseif') cond = r.stop.args ? r.stop.args[0] : [];
        else cond = undefined; // $else
      }
      body.push(block);
      continue;
    }
    body.push(recurseArgs(n));
  }
  return { body, stop: null };
}

function recurseArgs(n) {
  if (n.t === 'call' && n.args) return { ...n, args: n.args.map(buildBlocks) };
  return n;
}

module.exports = { parse };
