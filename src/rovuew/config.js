'use strict';
// Settings for the RoVuew part of BDX, read from .env. Read on every use (not
// once at startup) so a change saved from the web panel applies right away.
const path = require('path');

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  // Open Cloud key with Inventory read access, for badge scanning.
  get ROBLOX_API_KEY() { return process.env.ROBLOX_API_KEY || null; },
  get XTRACKER_API_KEY() { return process.env.XTRACKER_API_KEY || null; },
  get SERVERSWEEP_API_KEY() { return process.env.SERVERSWEEP_API_KEY || null; },
  // Keys allowed to call the RoVuew HTTP API (Verify uses one of these).
  get API_KEYS() { return list(process.env.ROVUEW_API_KEYS); },
  get PORT() { return Number(process.env.ROVUEW_API_PORT) || 3001; },
  get DATA_DIR() { return path.resolve(process.env.ROVUEW_DATA_DIR || 'data/rovuew'); },
  get ADMIN_ROLE_ID() { return process.env.ROVUEW_ADMIN_ROLE_ID || null; },
  get ACCEPTED_USERS() { return list(process.env.ROVUEW_ACCEPTED_USERS); },
  // Shared cooldown used by both the HTTP API and the check commands.
  RATE_LIMIT_MS: 20 * 1000,
};
