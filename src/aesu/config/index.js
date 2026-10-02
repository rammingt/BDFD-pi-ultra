'use strict';

// The shift tracker's settings, read from BDX's .env. Any setting can be given an
// AESU_ prefix to keep it apart from something else of the same name. PORT and
// DATA_FILE already mean something to BDX, so for those only AESU_PORT and
// AESU_DATA_FILE count.
const PREFIX_ONLY = new Set(['PORT', 'DATA_FILE']);

function raw(name) {
  const value = process.env[`AESU_${name}`] ?? (PREFIX_ONLY.has(name) ? undefined : process.env[name]);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function str(name, fallback = '') {
  return raw(name) ?? fallback;
}

function int(name, fallback, { min, max } = {}) {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function bool(name, fallback) {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value);
}

/** Parses a comma / space / semicolon separated list of ids into a de-duplicated array. */
function idList(name) {
  const value = raw(name);
  if (!value) return [];
  const ids = value
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part));
  return [...new Set(ids)];
}

const publicBaseUrl = str('PUBLIC_BASE_URL').replace(/\/+$/, '');

/** Also the fallback if SHIFT_TYPES is set to something unusable. */
const DEFAULT_SHIFT_TYPES = 'Shift Guard, Solo Shift, Deployment, Game Night';

/** The AESU squads and the Discord role each one carries. */
const DEFAULT_SQUADS = [
  'Alpha=1545916753387851916',
  'Beta=1545916854659317860',
  'Charlie=1545916910149967933',
  'Delta=1545916974822068274',
  'Epsilon=1545917020464226447',
  'AETRU=1546472653077086278',
  '1SAL=1491712259695706163',
].join(', ');

const config = {
  discord: {
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    /** Optional. When set, slash commands register instantly to this guild instead of globally. */
    guildId: str('DISCORD_GUILD_ID'),
    /** The Pi's owner. Gets the panel link in /diagnose and the agent's DMs. */
    ownerId: str('OWNER_DISCORD_ID'),
    /** Channel the bot pings people in when it notices them join a tracked game. */
    promptChannelId: str('SHIFT_PROMPT_CHANNEL_ID'),
    /** Channel shift start/break/end records are written to. */
    logChannelId: str('SHIFT_LOG_CHANNEL_ID'),
    /** Optional role allowed to look up other members' tracked time and run events. */
    staffRoleId: str('SHIFT_STAFF_ROLE_ID'),
    /** Where event posts go. Falls back to the prompt channel. */
    eventChannelId: str('EVENT_CHANNEL_ID', str('SHIFT_PROMPT_CHANNEL_ID')),
    /**
     * Adds the privileged Server Members intent, which `/squad action:roster` needs to count
     * anybody. Turn it on in the developer portal FIRST: asking for an intent the app
     * has not been granted makes the login fail outright.
     */
    memberIntent: bool('ENABLE_MEMBER_INTENT', false),
    /**
     * Role allowed to run /admin. Unlike the other gates this does NOT fall back to
     * everybody when unset: it falls back to Discord's own Administrator permission,
     * because /admin can rewrite anybody's banked hours.
     */
    adminRoleId: str('ADMIN_ROLE_ID'),
    /** Where /admin records what it did. Falls back to the shift log. */
    adminLogChannelId: str('ADMIN_LOG_CHANNEL_ID', str('SHIFT_LOG_CHANNEL_ID')),
    /** Kept in sync with whether somebody is on shift. Set any to '' to turn one off. */
    onDutyRoleId: str('SHIFT_ROLE_ON_DUTY', '1520787971148615761'),
    onBreakRoleId: str('SHIFT_ROLE_ON_BREAK', '1520788095232901150'),
    offDutyRoleId: str('SHIFT_ROLE_OFF_DUTY', '1520788165273849866'),
  },
  roblox: {
    clientId: str('ROBLOX_CLIENT_ID'),
    clientSecret: str('ROBLOX_CLIENT_SECRET'),
    /** Defaults to PUBLIC_BASE_URL + /oauth/callback, which is what you register on the Roblox app. */
    redirectUri: str('ROBLOX_REDIRECT_URI', publicBaseUrl ? `${publicBaseUrl}/oauth/callback` : ''),
    scopes: str('ROBLOX_SCOPES', 'openid profile'),
    /** .ROBLOSECURITY cookie of a throwaway account, used to read presence (see README). */
    cookie: str('ROBLOX_COOKIE'),
    /** The group /group manages. Find it in the group's URL. */
    groupId: str('ROBLOX_GROUP_ID'),
    /**
     * Cookie used for group actions. Roblox only lets an account rank people below
     * itself, so this has to be an account with a ranking permission - which the
     * throwaway presence account will not have. Falls back to ROBLOX_COOKIE.
     */
    groupCookie: str('ROBLOX_GROUP_COOKIE'),
  },
  tracking: {
    universeIds: idList('TRACKED_UNIVERSE_IDS'),
    placeIds: idList('TRACKED_PLACE_IDS'),
    pollIntervalSeconds: int('PRESENCE_POLL_INTERVAL_SECONDS', 30, { min: 10, max: 900 }),
    /** How long a member may look "gone" before the shift is auto-ended (covers server hops). */
    leaveGraceSeconds: int('LEAVE_GRACE_SECONDS', 90, { min: 0, max: 3600 }),
    /** How long the "want to log this?" prompt stays actionable. */
    promptTimeoutSeconds: int('PROMPT_TIMEOUT_SECONDS', 600, { min: 60, max: 86_400 }),
    /** Safety net so a stuck shift cannot run forever. */
    maxShiftHours: int('MAX_SHIFT_HOURS', 12, { min: 1, max: 168 }),
    /** Set true to drop the in-game requirement and let anyone start a shift at any time. */
    allowManualStartOutsideGame: bool('ALLOW_MANUAL_START_OUTSIDE_GAME', false),
  },
  shifts: {
    /** Comma separated `Label`, or `key=Label` to keep the stored key while renaming. */
    types: str('SHIFT_TYPES', DEFAULT_SHIFT_TYPES),
    /** Optional `key = text` entries separated by semicolons. Empty means no descriptions. */
    descriptions: str('SHIFT_TYPE_DESCRIPTIONS'),
    /** Types that may be run in any Roblox game rather than only the tracked ones. */
    anyGameTypes: str('SHIFT_TYPES_ANY_GAME', 'game_night'),
  },
  events: {
    /** IANA zone absolute start times are read in, e.g. Asia/Seoul. */
    timezone: str('EVENT_TIMEZONE', 'UTC'),
    /** An event nobody closes is banked at this point rather than running forever. */
    maxHours: int('EVENT_MAX_HOURS', 12, { min: 1, max: 168 }),
    /** Attendance shorter than this is not worth a shift record. */
    minAttendanceMinutes: int('EVENT_MIN_ATTENDANCE_MINUTES', 1, { min: 0, max: 600 }),
  },
  sheets: {
    /** The id in the sheet's URL, between /d/ and /edit. */
    spreadsheetId: str('GOOGLE_SHEET_ID'),
    /** The whole service account key file, pasted in. */
    credentials: str('GOOGLE_SERVICE_ACCOUNT_JSON'),
    /** Or the two fields on their own, if pasting the JSON is awkward. */
    clientEmail: str('GOOGLE_CLIENT_EMAIL'),
    privateKey: str('GOOGLE_PRIVATE_KEY'),
    syncIntervalMinutes: int('SHEET_SYNC_INTERVAL_MINUTES', 5, { min: 1, max: 1440 }),
  },
  applications: {
    /** The Form's linked response spreadsheet. Often separate from the academy one. */
    spreadsheetId: str('APPLICATION_SHEET_ID', str('GOOGLE_SHEET_ID')),
    /** Google names the responses tab this by default. */
    tab: str('APPLICATION_TAB', 'Form Responses 1'),
    /** Where each new application is posted. */
    channelId: str('APPLICATION_CHANNEL_ID'),
    /** Optional link back to the form or its sheet, shown on the post. */
    formUrl: str('APPLICATION_FORM_URL'),
  },
  rovuew: {
    /** Where the RoVuew inventory checker lives. Override only for a local instance. */
    // RoVuew runs inside BDX now and is asked directly. Set this only to use one
    // running somewhere else.
    baseUrl: str('ROVUEW_BASE_URL'),
    /** One of the keys in RoVuew's own API_KEYS list. */
    apiKey: str('ROVUEW_API_KEY'),
  },
  legal: {
    /** Shown on the privacy and terms pages so people can get in touch. */
    contact: str('LEGAL_CONTACT'),
    /** The name people know this bot by, used on those pages. */
    operator: str('LEGAL_OPERATOR', 'AESU'),
  },
  ranks: {
    /** Role allowed to approve promotions and edit the ladder. Falls back to the group staff role. */
    staffRoleId: str('PROMOTION_STAFF_ROLE_ID', str('GROUP_STAFF_ROLE_ID', str('SHIFT_STAFF_ROLE_ID'))),
    /** Where promotion requests and approvals are posted. Falls back to the group log. */
    channelId: str('PROMOTION_CHANNEL_ID', str('GROUP_LOG_CHANNEL_ID')),
  },
  academy: {
    /** Role allowed to move people between phases. Falls back to the shift staff role. */
    staffRoleId: str('ACADEMY_STAFF_ROLE_ID', str('SHIFT_STAFF_ROLE_ID')),
    /** The role each phase carries. Moving phase swaps them. Leave one empty to skip it. */
    roles: {
      orientation: str('ACADEMY_ROLE_ORIENTATION'),
      academy: str('ACADEMY_ROLE_ACADEMY'),
      final_exam: str('ACADEMY_ROLE_FINAL_EXAM'),
      waiting: str('ACADEMY_ROLE_WAITING'),
    },
  },
  squads: {
    /** Comma separated `Label=roleId`. The label is what people see and type. */
    list: str('SQUADS', DEFAULT_SQUADS),
    /** Role handed out alongside the squad role. 2ICU by default. Set to '' to turn off. */
    sharedRoleId: str('SQUAD_SHARED_ROLE_ID', '1491712329723936828'),
    /** Squads that do not get that shared role, by label. */
    sharedExcept: str('SQUAD_SHARED_EXCEPT', '1SAL'),
    /** Role allowed to assign squads. Falls back to the shift staff role. */
    staffRoleId: str('SQUAD_STAFF_ROLE_ID', str('SHIFT_STAFF_ROLE_ID')),
  },
  group: {
    /** Role allowed to run /group and decide applications. Falls back to the shift staff role. */
    staffRoleId: str('GROUP_STAFF_ROLE_ID', str('SHIFT_STAFF_ROLE_ID')),
    /** Optional channel every group action is recorded in. Off when unset. */
    logChannelId: str('GROUP_LOG_CHANNEL_ID'),
  },
  storage: {
    databaseUrl: str('DATABASE_URL'),
    dataFile: str('DATA_FILE', 'data/shift-tracker.json'),
    /** 'auto' | 'disable' | 'require' | 'no-verify'. Managed Postgres usually needs 'no-verify'. */
    databaseSsl: str('DATABASE_SSL', 'auto').toLowerCase(),
  },
  web: {
    port: int('PORT', 3000, { min: 1, max: 65_535 }),
    publicBaseUrl,
    /** Where the Pi agent's panel is reachable, e.g. over Tailscale. */
    panelUrl: str('PANEL_URL'),
  },
  logLevel: str('LOG_LEVEL', 'info').toLowerCase(),
};

/** Returns everything that is missing or inconsistent; fatal issues stop the process. */
function inspectConfig() {
  const issues = [];
  const warn = (variable, condition, message) => {
    if (condition) issues.push({ variable, message, fatal: false });
  };

  // BDX logs in and registers the slash commands, so DISCORD_TOKEN and
  // DISCORD_CLIENT_ID are its business and nothing here is fatal any more.
  warn(
    'SHIFT_PROMPT_CHANNEL_ID',
    !config.discord.promptChannelId,
    'Not set - the bot cannot ping anyone when it notices them join a tracked game.',
  );
  warn(
    'SHIFT_LOG_CHANNEL_ID',
    !config.discord.logChannelId,
    'Not set - shifts are still recorded to the database but nothing is posted to a channel.',
  );
  warn(
    'ROBLOX_CLIENT_ID / ROBLOX_CLIENT_SECRET',
    !config.roblox.clientId || !config.roblox.clientSecret,
    'Not set - /connect is disabled, so nobody can link a Roblox account.',
  );
  warn(
    'PUBLIC_BASE_URL',
    Boolean(config.roblox.clientId) && !config.roblox.redirectUri,
    'Not set - there is no OAuth redirect URI to send people back to.',
  );
  warn(
    'ROBLOX_COOKIE',
    !config.roblox.cookie,
    'Not set - presence tracking is off, so shifts must be started and ended from /shift action:manage.',
  );
  warn(
    'ROBLOX_GROUP_COOKIE',
    Boolean(config.roblox.groupId) && !config.roblox.groupCookie && Boolean(config.roblox.cookie),
    'Not set - group actions will use ROBLOX_COOKIE, which is meant to be a throwaway account and ' +
      'almost certainly cannot rank anyone. Set a cookie for an account with a ranking permission.',
  );
  warn(
    'PROMOTION_CHANNEL_ID',
    Boolean(config.roblox.groupId) && !config.ranks.channelId,
    'Not set - a rank set to "approval" has nowhere to post its request, so those promotions cannot be approved.',
  );
  warn(
    'SQUAD_STAFF_ROLE_ID',
    !config.squads.staffRoleId,
    'Not set and neither is SHIFT_STAFF_ROLE_ID, so anybody in the server can move people between squads.',
  );
  warn(
    'GROUP_STAFF_ROLE_ID',
    Boolean(config.roblox.groupId) && !config.group.staffRoleId,
    'Not set and neither is SHIFT_STAFF_ROLE_ID, so anybody in the server can rank and exile group members ' +
      'with /group. Set one of them to a staff role.',
  );
  warn(
    'TRACKED_UNIVERSE_IDS / TRACKED_PLACE_IDS',
    config.tracking.universeIds.length === 0 && config.tracking.placeIds.length === 0,
    'No games are tracked - the bot will never prompt anyone automatically.',
  );

  return issues;
}

function isPresenceTrackingEnabled() {
  return Boolean(config.roblox.cookie) && (config.tracking.universeIds.length > 0 || config.tracking.placeIds.length > 0);
}

function isOAuthConfigured() {
  return Boolean(config.roblox.clientId && config.roblox.clientSecret && config.roblox.redirectUri);
}

/** True when the given presence location counts as one of the tracked games. */
function isTrackedGame(universeId, placeId) {
  if (universeId && config.tracking.universeIds.includes(String(universeId))) return true;
  if (placeId && config.tracking.placeIds.includes(String(placeId))) return true;
  return false;
}

module.exports = { DEFAULT_SHIFT_TYPES, DEFAULT_SQUADS, config, inspectConfig, isPresenceTrackingEnabled, isOAuthConfigured, isTrackedGame };
