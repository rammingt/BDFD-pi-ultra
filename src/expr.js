'use strict';
// Safe math + condition evaluation (no eval()).

function math(input) {
  const s = String(input).replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  function num() {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error(`invalid math near "${s.slice(i) || 'end'}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function atom() {
    if (peek() === '(') { i++; const v = add(); if (s[i++] !== ')') throw new Error('missing )'); return v; }
    if (peek() === '-') { i++; return -atom(); }
    if (peek() === '+') { i++; return atom(); }
    return num();
  }
  function pow() { const b = atom(); if (peek() === '^') { i++; return Math.pow(b, unary()); } return b; }
  function unary() { return pow(); }
  function mul() {
    let v = unary();
    while ('*/%'.includes(peek()) && peek()) {
      const op = s[i++]; const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function add() {
    let v = mul();
    while ((peek() === '+' || peek() === '-')) { const op = s[i++]; const r = mul(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  if (!s) throw new Error('empty math expression');
  const v = add();
  if (i < s.length) throw new Error(`invalid math near "${s.slice(i)}"`);
  return Number.isInteger(v) ? v : Math.round(v * 1e10) / 1e10;
}

function compare(a, op, b) {
  a = a.trim(); b = b.trim();
  const na = Number(a), nb = Number(b);
  const numeric = a !== '' && b !== '' && !isNaN(na) && !isNaN(nb);
  switch (op) {
    case '==': return numeric ? na === nb : a === b;
    case '!=': return numeric ? na !== nb : a !== b;
    case '>=': return numeric ? na >= nb : a >= b;
    case '<=': return numeric ? na <= nb : a <= b;
    case '>': return numeric ? na > nb : a > b;
    case '<': return numeric ? na < nb : a < b;
  }
}

// == and != are looked for first, so a value with < or > in it, like a mention
// (<@123>==) or an arrow, is compared as a whole instead of split in the middle.
const OP_ORDER = [['==', '!='], ['>=', '<='], ['>', '<']];

function single(c) {
  for (const group of OP_ORDER) {
    for (let i = 0; i < c.length; i++) {
      const op = group.find((o) => c.startsWith(o, i));
      if (op) return compare(c.slice(0, i), op, c.slice(i + op.length));
    }
  }
  const v = c.trim().toLowerCase();
  return !(v === '' || v === 'false' || v === '0' || v === 'no');
}

/** "a==b&&c!=d||e>1" -> boolean. && binds tighter than ||. */
function condition(input) {
  return String(input).split('||').some((part) => part.split('&&').every(single));
}

module.exports = { math, condition };
