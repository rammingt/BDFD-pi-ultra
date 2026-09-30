'use strict';
// BDX functions for the AESU shift tracker. The same idea as RoVuew's: each one does
// the work in JavaScript and leaves what it found in the JSON slot, so the .bdx
// commands print it with $json[...] and loop over lists with $jsonList.
//
// Actions return a word: "ok", or a short reason it did not happen. The reason in
// plain words is in $json[error], ready to show as it is or to replace per reason.

const { runtime, isEnabled } = require('./index');

// Loaded on first use, after .env has been read
const mod = (name) => require(`./${name}`);

module.exports = ({ need, fail, arg, num }) => {
  const bool = (v, def = false) => (v === '' || v === undefined ? def : ['yes', 'true', '1'].includes(String(v).toLowerCase()));
  const stripId = (v) => String(v ?? '').replace(/[<@!#&>]/g, '').trim();

  function rt() {
    if (!runtime.started) {
      fail(isEnabled()
        ? 'the shift tracker did not start. The BDX log says why.'
        : 'the shift tracker is off. Set AESU_ENABLED=yes in Settings and restart.');
    }
    return runtime;
  }

  // An action that did not happen: the reason word, with the plain words beside it.
  function refuse(ctx, code, error, extra = {}) {
    ctx.json = { code, error, ...extra };
    return code;
  }

  // Shift and event rules throw these with a message meant for the member.
  async function attempt(ctx, run) {
    const { ShiftError } = mod('shifts/manager');
    const { EventInputError } = mod('events/types');
    try {
      return await run();
    } catch (error) {
      if (error instanceof ShiftError || error instanceof EventInputError) return refuse(ctx, 'refused', error.message);
      throw error;
    }
  }

  const member = (ctx) => ctx.discord?.member ?? null;
  function holds(ctx, roleId) {
    const roles = member(ctx)?.roles;
    if (!roles) return false;
    return Array.isArray(roles) ? roles.includes(roleId) : roles.cache.has(roleId);
  }

  // The permission gates from the old guard.ts. An unset role means everybody,
  // except admin, which falls back to Discord's Administrator permission.
  const GATES = {
    staff: (ctx, cfg) => !cfg.discord.staffRoleId || holds(ctx, cfg.discord.staffRoleId),
    admin: (ctx, cfg) => (cfg.discord.adminRoleId ? holds(ctx, cfg.discord.adminRoleId) : Boolean(member(ctx)?.permissions?.has?.('Administrator'))),
    promotion: (ctx, cfg) => !cfg.ranks.staffRoleId || holds(ctx, cfg.ranks.staffRoleId),
    group: (ctx, cfg) => !cfg.group.staffRoleId || holds(ctx, cfg.group.staffRoleId),
    squad: (ctx, cfg) => !cfg.squads.staffRoleId || holds(ctx, cfg.squads.staffRoleId),
  };
  const GATE_ROLE = { staff: 'discord.staffRoleId', admin: 'discord.adminRoleId', promotion: 'ranks.staffRoleId', group: 'group.staffRoleId', squad: 'squads.staffRoleId' };

  function allowed(ctx, gate) {
    const check = GATES[gate];
    if (!check) fail(`unknown permission "${gate}" (use ${Object.keys(GATES).join(', ')})`);
    return check(ctx, mod('config/index').config);
  }

  // What the presence watcher last saw, used when the in game requirement is off.
  async function lastSeenGame(store, discordId) {
    const watch = await store.getWatchState(discordId);
    if (!watch?.sessionKey) return { universeId: null, placeId: null, gameName: null };
    return { universeId: watch.universeId, placeId: watch.placeId, gameName: watch.gameName };
  }

  function refusalMessage(refusal, type, playing) {
    const { VISIBILITY_HINT } = mod('roblox/visibility');
    const { anyGameTypeLabels, isAnyGameType, shiftTypeLabel } = mod('shifts/types');
    const label = shiftTypeLabel(type);
    if (refusal === 'hidden') return VISIBILITY_HINT;
    if (refusal === 'not_in_game') {
      return isAnyGameType(type)
        ? `Join a Roblox game first. A ${label} shift logs whichever game you are playing.`
        : `You have to be in one of the tracked games before you can start a ${label} shift.`;
    }
    const alternatives = anyGameTypeLabels();
    return `You are in ${playing ? `**${playing}**` : 'a game'}, which is not one of the tracked games, `
      + `so it cannot be logged as a ${label} shift.`
      + (alternatives.length > 0 ? ` Pick **${alternatives.join('** or **')}** if that is what you are running.` : '');
  }

  /**
   * Checks the member really is in a game before a shift is opened, and works out
   * which one to stamp on it. Any game types accept whatever they are playing;
   * everything else has to be one of the tracked games.
   */
  async function requireInGame(ctx, store, type) {
    const { config, isPresenceTrackingEnabled } = mod('config/index');
    // With no cookie or no tracked games there is nothing to check against, and
    // refusing everybody would leave the bot unusable.
    if (config.tracking.allowManualStartOutsideGame || !isPresenceTrackingEnabled()) {
      return { game: await lastSeenGame(store, ctx.author.id) };
    }
    const link = await store.getLinkByDiscordId(ctx.author.id);
    if (!link) return { code: 'not_linked', error: 'Link your Roblox account with `/connect` first. The bot has to see you in game to start a shift.' };

    // Somebody who joined seconds ago must not be turned away by a cached answer.
    const { checkJoinVisibility } = mod('roblox/visibility');
    const { evaluateStart } = mod('shifts/startGate');
    const { status, presence } = await checkJoinVisibility(link.robloxId, { fresh: true });
    const verdict = evaluateStart(type, status, presence);
    if (!verdict.allowed) {
      return { code: verdict.refusal, error: refusalMessage(verdict.refusal, type, presence?.lastLocation ?? null), playing: presence?.lastLocation ?? '' };
    }
    const { resolveUniverseName } = mod('roblox/games');
    const gameName = (await resolveUniverseName(verdict.universeId)) ?? presence?.lastLocation ?? null;
    return { game: { universeId: verdict.universeId, placeId: verdict.placeId, gameName } };
  }

  async function panel(ctx, selected = null) {
    const { manager } = rt();
    const shift = await manager.getOpenShift(ctx.author.id);
    ctx.json = mod('views').panelView(shift, selected);
    return ctx.json;
  }

  async function shiftAction(ctx, run) {
    return attempt(ctx, async () => {
      await run();
      await panel(ctx);
      return 'ok';
    });
  }

  const RANGES = {
    today: 'Today (UTC)', week: 'Last 7 days', month: 'Last 30 days', all: 'All time',
  };

  return {
    // ───────────── general ─────────────
    // yes when the tracker is running
    aesuOn: { fn: () => (runtime.started ? 'yes' : 'no') },

    // $aesuAllowed[staff|admin|promotion|group|squad] → yes or no for whoever ran the command
    aesuAllowed: { fn(ctx, a) {
      rt();
      return allowed(ctx, need(a, 1, '$aesuAllowed[staff|admin|promotion|group|squad]')[0].trim().toLowerCase()) ? 'yes' : 'no';
    } },

    // The role a gate uses, as a mention, or nothing when it is not set
    aesuRole: { fn(ctx, a) {
      rt();
      const gate = need(a, 1, '$aesuRole[staff|admin|promotion|group|squad]')[0].trim().toLowerCase();
      if (!GATE_ROLE[gate]) fail(`unknown permission "${gate}"`);
      const [section, key] = GATE_ROLE[gate].split('.');
      const id = mod('config/index').config[section][key];
      return id ? `<@&${id}>` : '';
    } },

    // The note about Roblox hiding which game somebody is in, or nothing when it can see.
    // The old bot added it after every command; put it wherever it reads best.
    aesuJoinWarning: { async fn(ctx, a) {
      const { store } = rt();
      const { config } = mod('config/index');
      if (!config.roblox.cookie) return '';
      try {
        const link = await store.getLinkByDiscordId(stripId(arg(a, 0, ctx.author.id)));
        if (!link) return '';
        const { checkJoinVisibility, VISIBILITY_HINT } = mod('roblox/visibility');
        const { status } = await checkJoinVisibility(link.robloxId);
        return status === 'hidden' ? VISIBILITY_HINT : '';
      } catch {
        return '';
      }
    } },

    // ───────────── shifts ─────────────
    // $shiftPanel[selected type?] → the panel for whoever ran it.
    // state is none, active or on_break. shift holds the running shift, types the menu.
    shiftPanel: { async fn(ctx, a) {
      const type = arg(a, 0).trim();
      const { isShiftType } = mod('shifts/types');
      await panel(ctx, type && isShiftType(type) ? type : null);
      return '';
    } },

    // $shiftStart[type;panel|prompt] → ok, with the panel in the JSON.
    // Otherwise not_linked, hidden, not_in_game, untracked_game, unknown_type or refused.
    shiftStart: { async fn(ctx, a) {
      const [type] = need(a, 1, '$shiftStart[type;panel|prompt]');
      const source = arg(a, 1, 'panel').toLowerCase() === 'prompt' ? 'prompt' : 'panel';
      const { store, manager } = rt();
      const { isShiftType } = mod('shifts/types');
      if (!isShiftType(type.trim())) return refuse(ctx, 'unknown_type', 'Pick a shift type from the menu first.');
      const check = await requireInGame(ctx, store, type.trim());
      if (!check.game) return refuse(ctx, check.code, check.error, { playing: check.playing ?? '' });
      const link = await store.getLinkByDiscordId(ctx.author.id);
      return shiftAction(ctx, () => manager.start({
        discordId: ctx.author.id,
        guildId: ctx.guild?.id ?? null,
        type: type.trim(),
        source,
        robloxId: link?.robloxId ?? null,
        robloxUsername: link?.robloxUsername ?? null,
        ...check.game,
      }));
    } },

    shiftBreak: { async fn(ctx) { const { manager } = rt(); return shiftAction(ctx, () => manager.startBreak(ctx.author.id)); } },
    shiftResume: { async fn(ctx) { const { manager } = rt(); return shiftAction(ctx, () => manager.endBreak(ctx.author.id)); } },

    // $shiftEnd → ok, with the finished shift in the JSON (worked, breakTime, typeLabel...)
    shiftEnd: { async fn(ctx) {
      const { manager } = rt();
      return attempt(ctx, async () => {
        const shift = await manager.end(ctx.author.id, 'manual');
        ctx.json = mod('views').shiftView(shift);
        return 'ok';
      });
    } },

    // $shiftHistory[user ID?;how many?] → shifts, newest first, with count
    shiftHistory: { async fn(ctx, a) {
      const { manager } = rt();
      const id = stripId(arg(a, 0, ctx.author.id));
      const limit = Math.min(25, Math.max(1, Math.floor(num(arg(a, 1, '10'), 'how many'))));
      const shifts = await manager.listShifts(id, { limit, includeOpen: true });
      const { shiftView } = mod('views');
      ctx.json = { discordId: id, count: shifts.length, shifts: shifts.map((shift) => shiftView(shift)) };
      return '';
    } },

    // $shiftTime[user ID?;today|week|month|all] → what /checktime shows.
    // Returns ok, or denied when SHIFT_STAFF_ROLE_ID is set and they look up somebody else.
    shiftTime: { async fn(ctx, a) {
      const { store, manager, events, client } = rt();
      const id = stripId(arg(a, 0, ctx.author.id));
      const range = RANGES[arg(a, 1, 'all').toLowerCase()] ? arg(a, 1, 'all').toLowerCase() : 'all';
      if (id !== ctx.author.id && !allowed(ctx, 'staff')) {
        return refuse(ctx, 'denied', 'You do not have permission to look up the tracked time of other members.');
      }
      const { summarise } = mod('shifts/manager');
      const { daysAgo, startOfUtcDay, formatDuration, formatHours, discordTimestamp } = mod('util/time');
      const { shiftTypeMeta } = mod('shifts/types');
      const { resolveSquad } = mod('discord/squadRoles');
      const { robloxLine, shiftView } = mod('views');
      const now = Date.now();
      const since = { today: startOfUtcDay(now), week: daysAgo(7, now), month: daysAgo(30, now) }[range];

      const [shifts, open, link, squad, hosted] = await Promise.all([
        manager.listShifts(id, since === undefined ? {} : { since }),
        manager.getOpenShift(id),
        store.getLinkByDiscordId(id),
        resolveSquad(client, ctx.guild?.id ?? null, id),
        events.hostedCount(id),
      ]);
      const totals = summarise(shifts, now);
      const byType = Object.entries(totals.byType)
        .filter(([, value]) => value.count > 0)
        .sort((x, y) => y[1].workedMs - x[1].workedMs)
        .map(([type, value]) => ({
          type, label: shiftTypeMeta(type)?.label ?? type, worked: formatDuration(value.workedMs),
          count: value.count, shifts: `${value.count} shift${value.count === 1 ? '' : 's'}`,
        }));
      ctx.json = {
        code: 'ok',
        discordId: id,
        range,
        rangeLabel: RANGES[range],
        linked: link ? 'yes' : 'no',
        roblox: link ? robloxLine(link.robloxId, link.robloxUsername) : 'Not linked',
        robloxUsername: link?.robloxUsername ?? '',
        worked: formatDuration(totals.workedMs),
        workedHours: formatHours(totals.workedMs),
        shiftCount: totals.shiftCount,
        average: totals.shiftCount > 0 ? formatDuration(totals.workedMs / totals.shiftCount) : 'None',
        longest: totals.longestMs > 0 ? formatDuration(totals.longestMs) : 'None',
        onBreak: formatDuration(totals.breakMs),
        lastShift: totals.lastEndedAt ? discordTimestamp(totals.lastEndedAt, 'R') : 'None',
        squad: squad ? `<@&${squad.roleId}>` : 'None',
        squadName: squad?.label ?? '',
        hosted: hosted.hosted,
        hostedLive: hosted.live,
        hostedText: hosted.hosted === 0 && hosted.live === 0 ? 'None' : `**${hosted.hosted}**${hosted.live > 0 ? ` (${hosted.live} on now)` : ''}`,
        byType,
        byTypeCount: byType.length,
        open: shiftView(open, now),
      };
      return 'ok';
    } },

    // $shiftPromptAnswer[yes|no] → for the join prompt's buttons. Records the answer and
    // redraws the prompt with the "shift prompt closed" hook. Returns declined,
    // running (already on shift, panel in the JSON) or pick (show the type menu).
    shiftPromptAnswer: { async fn(ctx, a) {
      const { store, manager } = rt();
      const accepted = bool(need(a, 1, '$shiftPromptAnswer[yes|no]')[0]);
      const watch = await store.getWatchState(ctx.author.id);
      const gameName = watch?.gameName ?? '';
      if (watch) await store.upsertWatchState({ ...watch, promptStatus: accepted ? 'accepted' : 'declined', updatedAt: Date.now() });

      // Collapse the public prompt so the channel does not fill up with live buttons.
      if (ctx.messageId && ctx.channel?.id) {
        await mod('ui').edit(ctx.channel.id, ctx.messageId, 'shift prompt closed', { discordId: ctx.author.id, gameName, accepted: accepted ? 'yes' : 'no' }, { about: ctx.author.id });
      }
      if (!accepted) { ctx.json = { gameName }; return 'declined'; }

      const open = await manager.getOpenShift(ctx.author.id);
      if (open) { await panel(ctx); ctx.json.gameName = gameName; return 'running'; }
      await panel(ctx);
      ctx.json.gameName = gameName;
      return 'pick';
    } },

    // ───────────── linking ─────────────
    // $connectLink → ok with url (personal, 10 minutes), linked, displayName and username.
    // off when Roblox OAuth is not set up.
    connectLink: { async fn(ctx) {
      const { store } = rt();
      const { config, isOAuthConfigured } = mod('config/index');
      if (!isOAuthConfigured()) {
        return refuse(ctx, 'off', 'Roblox linking is not configured on this bot yet. An admin needs to set `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET` and `PUBLIC_BASE_URL`.');
      }
      const { buildAuthorizationRequest } = mod('roblox/oauth');
      const existing = await store.getLinkByDiscordId(ctx.author.id);
      const now = Date.now();
      const authorization = buildAuthorizationRequest();
      await store.createOAuthState({
        state: authorization.state,
        discordId: ctx.author.id,
        guildId: ctx.guild?.id ?? null,
        codeVerifier: authorization.codeVerifier,
        createdAt: now,
        expiresAt: now + 10 * 60 * 1000,
      });
      await store.purgeExpiredOAuthStates(now);
      if (!config.web.publicBaseUrl) mod('util/logger').createLogger('command:connect').warn('PUBLIC_BASE_URL is empty, so the Roblox redirect will not reach this bot');
      ctx.json = {
        code: 'ok',
        url: authorization.url,
        linked: existing ? 'yes' : 'no',
        displayName: existing?.robloxDisplayName ?? '',
        username: existing?.robloxUsername ?? '',
      };
      return 'ok';
    } },

    // $disconnect → ok (displayName, username, closed = yes when a running shift was ended) or none
    disconnect: { async fn(ctx) {
      const { store, manager } = rt();
      const link = await store.getLinkByDiscordId(ctx.author.id);
      if (!link) return refuse(ctx, 'none', 'You do not have a Roblox account linked.');
      // Close anything still running so nothing is left open that presence can no longer end.
      const closed = await manager.endIfOpen(ctx.author.id, 'manual');
      if (link.refreshToken) await mod('roblox/oauth').revokeToken(link.refreshToken);
      await store.deleteLink(ctx.author.id);
      await store.deleteWatchState(ctx.author.id);
      ctx.json = { code: 'ok', displayName: link.robloxDisplayName, username: link.robloxUsername, closed: closed ? 'yes' : 'no' };
      return 'ok';
    } },

    // $robloxLink[user ID?] → linked (yes/no), robloxId, username, displayName, profile
    robloxLink: { async fn(ctx, a) {
      const { store } = rt();
      const link = await store.getLinkByDiscordId(stripId(arg(a, 0, ctx.author.id)));
      const { robloxLine } = mod('views');
      ctx.json = link
        ? { linked: 'yes', robloxId: link.robloxId, username: link.robloxUsername, displayName: link.robloxDisplayName, profile: robloxLine(link.robloxId, link.robloxUsername) }
        : { linked: 'no' };
      return link ? 'yes' : 'no';
    } },
  };
};
