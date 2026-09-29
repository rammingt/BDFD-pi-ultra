'use strict';
const { condition } = require('./expr');

class StopExecution extends Error {
  constructor(message = '') { super(message); this.userMessage = message; }
}
class BdxError extends Error {}

/**
 * Walks the AST. Non-lazy functions get their args pre-evaluated to strings;
 * lazy ones ($if, $onlyIf, $repeat...) get thunks and decide what to run.
 */
class Interpreter {
  constructor(functions) { this.functions = functions; }

  async evalNodes(nodes, ctx) {
    let out = '';
    for (const n of nodes) out += await this.evalNode(n, ctx);
    return out;
  }

  async evalNode(n, ctx) {
    if (n.t === 'text') return n.v;
    if (n.t === 'if') {
      for (const b of n.branches) {
        if (condition(await this.evalNodes(b.cond, ctx))) return this.evalNodes(b.body, ctx);
      }
      return n.else ? this.evalNodes(n.else, ctx) : '';
    }
    const def = this.functions.get(n.name);
    ctx.steps++;
    if (ctx.steps > ctx.maxSteps) throw new BdxError('step limit reached (infinite loop?)');
    try {
      if (def.lazy) {
        const thunks = n.args ? n.args.map((a) => () => this.evalNodes(a, ctx)) : null;
        return str(await def.fn(ctx, thunks, n));
      }
      let args = null;
      if (n.args) {
        args = [];
        for (const a of n.args) args.push(await this.evalNodes(a, ctx));
      }
      return str(await def.fn(ctx, args, n));
    } catch (e) {
      if (e instanceof StopExecution) throw e;
      const where = e instanceof BdxError ? e.message : `internal error: ${e.message}`;
      throw new StopExecution(ctx.errorMessage ?? `❌ \`$${def.display || n.name}\`: ${where}`);
    }
  }
}

function str(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : String(v);
}

module.exports = { Interpreter, StopExecution, BdxError };
