'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.LOG_LEVEL = 'error';

const { describeNetworkError } = require('../../../src/aesu/util/http');

/** How Node's fetch actually shapes a transport failure: a bland outer error
 *  whose `cause` carries the errno that says what went wrong. */
function fetchFailed(code) {
  const inner = new Error(`${code} something`);
  inner.code = code;
  return new TypeError('fetch failed', { cause: inner });
}

describe('describeNetworkError', () => {
  it('digs the real reason out of a "fetch failed"', () => {
    assert.match(describeNetworkError(fetchFailed('ENOTFOUND')), /does not resolve/);
    assert.match(describeNetworkError(fetchFailed('ECONNREFUSED')), /nothing is listening/);
    assert.match(describeNetworkError(fetchFailed('CERT_HAS_EXPIRED')), /certificate has expired/);
  });

  it('never leaves the caller with the useless outer message', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']) {
      assert.notEqual(describeNetworkError(fetchFailed(code)), 'fetch failed');
    }
  });

  it('calls our own timeout a timeout, not a fault at the other end', () => {
    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    assert.equal(describeNetworkError(aborted), 'the request timed out');
    assert.equal(describeNetworkError(new TypeError('fetch failed', { cause: aborted })), 'the request timed out');
  });

  it('passes an unrecognised code through rather than hiding it', () => {
    assert.equal(describeNetworkError(fetchFailed('EWEIRD')), 'EWEIRD');
  });

  it('falls back to the message when there is no code anywhere', () => {
    assert.equal(describeNetworkError(new Error('plain failure')), 'plain failure');
    assert.equal(describeNetworkError('not even an error'), 'not even an error');
  });

  it('reads the errno out of a dual-stack AggregateError', () => {
    const v4 = new Error('connect ECONNREFUSED 127.0.0.1:443');
    v4.code = 'ECONNREFUSED';
    const v6 = new Error('connect ECONNREFUSED ::1:443');
    v6.code = 'ECONNREFUSED';
    const wrapped = new TypeError('fetch failed', { cause: new AggregateError([v4, v6], 'all failed') });
    assert.match(describeNetworkError(wrapped), /nothing is listening/);
  });

  it('does not hang on a cause that points back at itself', () => {
    const loop = new Error('round and round');
    loop.cause = loop;
    assert.equal(describeNetworkError(loop), 'round and round');
  });
});
