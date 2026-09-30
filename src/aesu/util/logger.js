'use strict';
const { config } = require('../config/index');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const threshold = LEVELS[(config.logLevel)] ?? LEVELS.info;

function emit(level, scope, message, extra) {
  if (LEVELS[level] > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra.length > 0) sink(line, ...extra);
  else sink(line);
}

function createLogger(scope) {
  return {
    error: (message, ...extra) => emit('error', scope, message, extra),
    warn: (message, ...extra) => emit('warn', scope, message, extra),
    info: (message, ...extra) => emit('info', scope, message, extra),
    debug: (message, ...extra) => emit('debug', scope, message, extra),
  };
}

/** Errors are logged by message only; stacks are noisy in Railway's log view unless debugging. */
function describeError(error) {
  if (error instanceof Error) return threshold >= LEVELS.debug ? (error.stack ?? error.message) : error.message;
  return String(error);
}

module.exports = { createLogger, describeError };
