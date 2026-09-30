'use strict';
const { config } = require('../config/index');
const { createLogger } = require('../util/logger');
const { JsonStore } = require('./jsonStore');
const { PostgresStore } = require('./postgresStore');

const log = createLogger('store');

/**
 * Managed providers terminate TLS with a certificate the container does not trust,
 * so 'no-verify' is the working default for anything that is not a local socket.
 */
function resolveSsl(connectionString) {
  const mode = config.storage.databaseSsl;
  if (mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: true };
  if (mode === 'no-verify') return { rejectUnauthorized: false };

  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return { rejectUnauthorized: false };
  }
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.railway.internal');
  return isLocal ? undefined : { rejectUnauthorized: false };
}

async function createStore() {
  const url = config.storage.databaseUrl;
  const store = url
    ? new PostgresStore(url, resolveSsl(url))
    : new JsonStore(config.storage.dataFile);

  if (!url) {
    log.warn(
      `DATABASE_URL is not set - falling back to the JSON file at ${config.storage.dataFile}. ` +
        'On Railway this only survives a redeploy if a volume is mounted there.',
    );
  }

  await store.init();
  return store;
}

module.exports = { createStore };
