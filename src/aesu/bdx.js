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

// Slash choices that follow the settings: "@option type:string:...:required:from shiftTypes"
const { registerChoices } = require('../choices');
registerChoices('shiftTypes', () => mod('shifts/types').SHIFT_TYPES.map((meta) => ({ name: meta.label, value: meta.value })));
registerChoices('squads', () => mod('squads/types').SQUADS.map((squad) => ({ name: squad.label, value: squad.key })));

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
    return `You are in ${playing ? `${playing}` : 'a game'}, which is not one of the tracked games, `
      + `so it cannot be logged as a ${label} shift.`
      + (alternatives.length > 0 ? ` Pick ${alternatives.join(' or ')} if that is what you are running.` : '');
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


  // Where an event may be run from: its host, or anybody with the staff role.
  const mayManageEvent = (ctx, event) => event.hostId === ctx.author.id || allowed(ctx, 'staff');

  async function eventFor(ctx, id) {
    const { events } = rt();
    const event = await events.getEvent(String(id).trim());
    return event;
  }

  async function loadEvent(ctx, event) {
    const { events } = rt();
    ctx.json = mod('views').eventView(event, await events.listSignups(event.id));
    return ctx.json;
  }

  // The gate for anything that needs presence: linked, and not hiding their game.
  async function trackable(ctx, store) {
    const link = await store.getLinkByDiscordId(ctx.author.id);
    if (!link) return { code: 'not_linked', error: 'Link your Roblox account with `/connect` first. Attendance is tracked against it.' };
    const { checkJoinVisibility, VISIBILITY_HINT } = mod('roblox/visibility');
    const { status } = await checkJoinVisibility(link.robloxId);
    if (status === 'hidden') return { code: 'hidden', error: VISIBILITY_HINT };
    return { link };
  }

  const isHttpUrl = (value) => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
  };

  const eventFns = {
    // $eventCreate[name;start;type;details?;image?;roles?;timezone?;channel?]
    // Posts the event with the "event post" hook. ok, with the event in the JSON
    // (and postUrl), or denied / invalid / no_channel.
    eventCreate: { async fn(ctx, a) {
      const [rawName, start, type] = need(a, 3, '$eventCreate[name;start;type;details?;image?;roles?;timezone?;channel?]');
      const { events, client } = rt();
      const { config } = mod('config/index');
      const { DEFAULT_ROLES, EventInputError, isValidTimezone, parseRoles, parseStartTime } = mod('events/types');
      const { isShiftType } = mod('shifts/types');
      if (!allowed(ctx, 'staff')) return refuse(ctx, 'denied', 'You do not have permission to schedule events.');

      const name = rawName.trim();
      const details = arg(a, 3).trim() || null;
      const imageUrl = arg(a, 4).trim() || null;
      const timezone = arg(a, 6).trim() || config.events.timezone;
      const invalid = (error) => refuse(ctx, 'invalid', error);
      if (name.length === 0 || name.length > 100) return invalid('The event name has to be 1 to 100 characters.');
      if (details && details.length > 1500) return invalid('Keep the details under 1500 characters.');
      if (imageUrl && !isHttpUrl(imageUrl)) return invalid('The image has to be an `http://` or `https://` link.');
      if (!isValidTimezone(timezone)) return invalid(`\`${timezone}\` is not a timezone I know. Use an IANA name like \`Asia/Seoul\`.`);
      if (!isShiftType(type.trim())) return invalid('That is not a shift type I know about.');

      let startsAt;
      let roles;
      try {
        startsAt = parseStartTime(start, timezone);
        roles = parseRoles(arg(a, 5).trim() || DEFAULT_ROLES);
      } catch (error) {
        if (!(error instanceof EventInputError)) throw error;
        return invalid(error.message);
      }

      const channelId = stripId(arg(a, 7)) || config.discord.eventChannelId;
      const { resolveSendableChannel } = mod('discord/channels');
      const channel = await resolveSendableChannel(client, channelId);
      if (!channel) {
        return refuse(ctx, 'no_channel', channelId
          ? `I cannot post in <#${channelId}>. Give me View Channel and Send Messages there.`
          : 'There is nowhere to post the event. Set `EVENT_CHANNEL_ID` or pass the `channel` option.');
      }

      const event = await events.create({
        guildId: ctx.guild?.id ?? null, hostId: ctx.author.id, name, details, imageUrl, shiftType: type.trim(), startsAt, roles,
      });
      const message = await mod('ui').post(channel.id, 'event post', mod('views').eventView(event, []), { about: ctx.author.id, guildId: event.guildId });
      if (message) await events.attachMessage(event.id, channel.id, message.id);
      await loadEvent(ctx, (await events.getEvent(event.id)) ?? event);
      ctx.json.channelId = channel.id;
      ctx.json.postUrl = message?.url ?? '';
      return 'ok';
    } },

    // $eventList → events (not finished yet, newest 25) and count
    eventList: { async fn(ctx) {
      const { events } = rt();
      const open = await events.listOpenEvents(ctx.guild?.id ?? null);
      const { eventView } = mod('views');
      ctx.json = { count: open.length, events: open.map((event) => eventView(event)) };
      return '';
    } },

    // $eventInfo[id] → ok with the event, or missing
    eventInfo: { async fn(ctx, a) {
      const id = need(a, 1, '$eventInfo[id]')[0].trim();
      const event = await eventFor(ctx, id);
      if (!event) return refuse(ctx, 'missing', `No event with id \`${id}\`. Run \`/event action:list\` to see the open ones.`);
      await loadEvent(ctx, event);
      return 'ok';
    } },

    // $eventEnd[id] → ok (name, banked = how many got time logged), or missing, denied, not_started, over
    eventEnd: { async fn(ctx, a) {
      const id = need(a, 1, '$eventEnd[id]')[0].trim();
      const { events } = rt();
      const event = await eventFor(ctx, id);
      if (!event) return refuse(ctx, 'missing', `No event with id \`${id}\`.`);
      if (!mayManageEvent(ctx, event)) return refuse(ctx, 'denied', 'Only the host or a staff member can end this event.');
      if (event.status === 'scheduled') return refuse(ctx, 'not_started', 'That event has not started yet. Use `/event action:cancel` to call it off.');
      const ended = await events.finish(event.id);
      if (!ended) return refuse(ctx, 'over', 'That event is already over.');
      await loadEvent(ctx, ended);
      return 'ok';
    } },

    // $eventCancel[id] → ok (name), or missing, denied, over
    eventCancel: { async fn(ctx, a) {
      const id = need(a, 1, '$eventCancel[id]')[0].trim();
      const { events } = rt();
      const event = await eventFor(ctx, id);
      if (!event) return refuse(ctx, 'missing', `No event with id \`${id}\`.`);
      if (!mayManageEvent(ctx, event)) return refuse(ctx, 'denied', 'Only the host or a staff member can cancel this event.');
      const cancelled = await events.cancel(event.id);
      if (!cancelled) return refuse(ctx, 'over', 'That event is already over.');
      await loadEvent(ctx, cancelled);
      return 'ok';
    } },

    // $eventSignup[event id;option key] → ok (label, declined = yes for "cannot make it"),
    // or not_linked, hidden, refused (full, over, already down as that...)
    eventSignup: { async fn(ctx, a) {
      const [eventId, roleKey] = need(a, 2, '$eventSignup[event id;option key]');
      const { store, events } = rt();
      const { DECLINED_ROLE_KEY, DECLINED_LABEL } = mod('events/types');
      // Turning the event down needs neither a linked account nor visible presence.
      const declining = roleKey.trim() === DECLINED_ROLE_KEY;
      let link = null;
      if (declining) link = await store.getLinkByDiscordId(ctx.author.id);
      else {
        const gate = await trackable(ctx, store);
        if (!gate.link) return refuse(ctx, gate.code, gate.error);
        link = gate.link;
      }
      return attempt(ctx, async () => {
        const { event, role } = await events.signUp(eventId.trim(), ctx.author.id, roleKey.trim(), link?.robloxId ?? null);
        ctx.json = { code: 'ok', eventId: event.id, name: event.name, label: declining ? DECLINED_LABEL : role?.label ?? roleKey, declined: declining ? 'yes' : 'no' };
        return 'ok';
      });
    } },
  };


  // ───────────── promotions ─────────────
  const REQUEST_KEY = (messageId) => `promotion.request.${messageId}`;

  /** The promotion card data, with the bits Discord and Roblox each hold. */
  async function promotionData(ctx, progress) {
    const { store, events, client } = rt();
    const { resolveSquad } = mod('discord/squadRoles');
    const [link, squad, hosted] = await Promise.all([
      store.getLinkByDiscordId(progress.discordId),
      resolveSquad(client, ctx.guild?.id ?? null, progress.discordId),
      events.hostedCount(progress.discordId),
    ]);
    return {
      ...mod('views').progressView(progress),
      robloxUsername: link?.robloxUsername ?? '',
      squad: squad?.label ?? '',
      hostedEvents: hosted.hosted,
    };
  }

  // Posts the request card for staff with the "promotion request" hook, and keeps what
  // it showed so the card can be redrawn with the decision later.
  async function postPromotionRequest(ctx, rank, progress) {
    const { config } = mod('config/index');
    const log = mod('util/logger').createLogger('discord:promotions');
    if (!config.ranks.channelId) {
      log.warn('A promotion needs approving but PROMOTION_CHANNEL_ID is not set');
      return false;
    }
    try {
      const data = {
        ...(await promotionData(ctx, progress)),
        rankName: rank.name,
        roleId: String(rank.roleId),
        staffRole: config.ranks.staffRoleId ? `<@&${config.ranks.staffRoleId}>` : '',
        decided: 'no',
      };
      const message = await mod('ui').post(config.ranks.channelId, 'promotion request', data, {
        about: progress.discordId, guildId: ctx.guild?.id ?? null, pingRoles: config.ranks.staffRoleId ? [config.ranks.staffRoleId] : [],
      });
      if (!message) return false;
      await rt().store.setSetting(REQUEST_KEY(message.id), data);
      return true;
    } catch (error) {
      log.error(`Could not post a promotion request: ${mod('util/logger').describeError(error)}`);
      return false;
    }
  }

  const BLOCKED = {
    off: () => 'Promotions are off: the bot has no Roblox group configured to read ranks from.',
    not_linked: (self) => (self ? 'Link your Roblox account with `/connect` first.' : 'Didnt link acc with `/connect`, Cant track stuff.'),
    not_in_group: (self) => (self ? 'You are not in group.' : 'Not in roblox group.'),
  };

  const promoFns = {
    // $promoCheck[user ID?] → ok with where they stand against the next rank up,
    // or off, not_linked, not_in_group.
    promoCheck: { async fn(ctx, a) {
      const { ranks } = rt();
      const id = stripId(arg(a, 0, ctx.author.id));
      const progress = await ranks.progress(id);
      if ('error' in progress) return refuse(ctx, progress.error, BLOCKED[progress.error](id === ctx.author.id));
      ctx.json = { code: 'ok', ...(await promotionData(ctx, progress)) };
      return 'ok';
    } },

    // $promoRequest → what happened when whoever ran it asked to move up:
    // promoted, needs_approval (posted = yes when the card went up), not_ready (with the
    // progress), manual, unconfigured, top, off, not_linked, not_in_group or failed.
    promoRequest: { async fn(ctx) {
      const { ranks } = rt();
      const verdict = await ranks.requestPromotion(ctx.author.id);
      const outcome = verdict.outcome;
      if (BLOCKED[outcome]) return refuse(ctx, outcome, BLOCKED[outcome](true));
      if (outcome === 'failed') return refuse(ctx, 'failed', `Roblox refused that. ${verdict.reason}`);
      ctx.json = { code: outcome, rankName: verdict.rank?.name ?? '' };
      if (verdict.progress) Object.assign(ctx.json, await promotionData(ctx, verdict.progress), { rankName: verdict.rank?.name ?? '' });
      if (outcome === 'needs_approval') ctx.json.posted = (await postPromotionRequest(ctx, verdict.rank, verdict.progress)) ? 'yes' : 'no';
      return outcome;
    } },

    // $promoRanks → ranks (highest first, Guest and owner left out), count,
    // group and sheets (yes/no)
    promoRanks: { async fn(ctx) {
      const { ranks } = rt();
      const { isGroupConfigured } = mod('roblox/group');
      const { isSheetsConfigured } = mod('sheets/client');
      const all = ranks.list();
      const list = [...all].sort((x, y) => y.rank - x.rank).filter((rank) => rank.rank > 0 && rank.rank < 255).map((rank) => {
        const view = mod('views').rankView(rank);
        return { ...view, number: String(rank.rank).padStart(3, ' '), memberText: rank.memberCount === null ? '' : ` · ${rank.memberCount} member(s)` };
      });
      ctx.json = { stored: all.length, count: list.length, ranks: list, group: isGroupConfigured() ? 'yes' : 'no', sheets: isSheetsConfigured() ? 'yes' : 'no' };
      return '';
    } },

    // $promoSync → ok (ranks, problems, sheets = yes when the sheet was used) or nogroup
    promoSync: { async fn(ctx) {
      const { ranks, sheets } = rt();
      const { isGroupConfigured } = mod('roblox/group');
      if (!sheets) {
        // Without a sheet the group is still worth re-reading, so the ladder stays current.
        if (!isGroupConfigured()) return refuse(ctx, 'nogroup', 'There is no Roblox group configured, so there are no ranks to read.');
        const ladder = await ranks.syncFromGroup();
        ctx.json = { code: 'ok', sheets: 'no', ranks: ladder.length, problems: [], problemCount: 0 };
        return 'ok';
      }
      const result = await sheets.syncNow({ reformat: true });
      ctx.json = { code: 'ok', sheets: 'yes', ranks: result.ranks, problems: result.problems.slice(0, 8), problemCount: result.problems.length };
      return 'ok';
    } },

    // $promoDecide[approve|deny;discord ID;role ID] → for the request card's buttons.
    // Measures again before approving, sets the rank in Roblox, and redraws the card.
    // ok (rankName, approved), or denied, decided, gone, failed.
    promoDecide: { async fn(ctx, a) {
      const [choice, discordId, roleId] = need(a, 3, '$promoDecide[approve|deny;discord ID;role ID]');
      const { ranks, store } = rt();
      const { config } = mod('config/index');
      const approving = choice.trim().toLowerCase().startsWith('approv');
      if (!allowed(ctx, 'promotion')) {
        return refuse(ctx, 'denied', config.ranks.staffRoleId ? `Only <@&${config.ranks.staffRoleId}> can decide promotions.` : 'You do not have permission to do that.');
      }
      const saved = ctx.messageId ? await store.getSetting(REQUEST_KEY(ctx.messageId)) : null;
      const legacy = saved ? null : await legacyCard(ctx);
      if (saved?.decided === 'yes' || legacy?.decided) return refuse(ctx, 'decided', 'That request has already been decided.');

      const rank = ranks.byRoleId(Number(roleId));
      if (approving && !rank) return refuse(ctx, 'gone', 'That rank is no longer in the group. Run `/promote action:sync`.');
      let note = '';
      if (approving && rank) {
        const applied = await ranks.apply(stripId(discordId), rank);
        if (!applied.ok) return refuse(ctx, 'failed', `Roblox refused that. ${applied.reason}`);
        note = `Set to ${rank.name} in the Roblox group.`;
      }

      const decision = { decided: 'yes', approved: approving ? 'yes' : 'no', decidedBy: ctx.author.id, note };
      if (saved) {
        await store.setSetting(REQUEST_KEY(ctx.messageId), { ...saved, ...decision });
        await mod('ui').edit(ctx.channel.id, ctx.messageId, 'promotion request', { ...saved, ...decision }, { about: stripId(discordId) });
      } else if (legacy) {
        await legacy.mark(approving ? 'Approved' : 'Denied', [`By <@${ctx.author.id}>`, note].filter(Boolean).join('\n'));
      }
      ctx.json = { code: 'ok', approved: approving ? 'yes' : 'no', rankName: rank?.name ?? '', discordId: stripId(discordId) };
      return 'ok';
    } },
  };

  /**
   * A card the old bot posted as an embed. Decisions were written into its fields,
   * so that is where to look, and where to write this one.
   */
  async function legacyCard(ctx, fields = ['Approved', 'Denied']) {
    if (!ctx.messageId || !ctx.channel?.id) return null;
    const { resolveSendableChannel } = mod('discord/channels');
    const channel = await resolveSendableChannel(rt().client, ctx.channel.id);
    const message = await channel?.messages.fetch(ctx.messageId).catch(() => null);
    const [card, ...rest] = message?.embeds ?? [];
    if (!card) return null;
    const { EmbedBuilder } = require('discord.js');
    return {
      decided: (card.data.fields ?? []).some((field) => fields.includes(field.name)),
      mark: async (name, value) => {
        const color = /Approved|Accepted/.test(name) ? 0x57f287 : 0xed4245;
        const marked = EmbedBuilder.from(card.data).setColor(color).addFields({ name, value: value.slice(0, 1024) });
        await message.edit({ embeds: [marked, ...rest], components: [] }).catch(() => {});
      },
    };
  }


  // ───────────── squads ─────────────
  function squadRoles(squad) {
    const { config } = mod('config/index');
    const shared = squad.shared && config.squads.sharedRoleId ? ` and <@&${config.squads.sharedRoleId}>` : '';
    return `<@&${squad.roleId}>${shared}`;
  }
  const squadView = (squad) => squad && { key: squad.key, label: squad.label, roleId: squad.roleId, role: `<@&${squad.roleId}>`, roles: squadRoles(squad) };

  const squadFns = {
    // $squadInfo[user ID?] → inSquad (yes/no), squad (label, role, roles), hosted, hostedLive
    squadInfo: { async fn(ctx, a) {
      const { client, events } = rt();
      const id = stripId(arg(a, 0, ctx.author.id));
      const { resolveSquad } = mod('discord/squadRoles');
      const [squad, hosted] = await Promise.all([resolveSquad(client, ctx.guild?.id ?? null, id), events.hostedCount(id)]);
      ctx.json = { discordId: id, inSquad: squad ? 'yes' : 'no', squad: squadView(squad), hosted: hosted.hosted, hostedLive: hosted.live };
      return squad ? 'yes' : 'no';
    } },

    // $squadSet[user ID;squad] → ok (squad), or unknown, failed. Needs the squad staff role (check with $aesuAllowed[squad]).
    squadSet: { async fn(ctx, a) {
      const [who, query] = need(a, 2, '$squadSet[user ID;squad]');
      const { client } = rt();
      const { findSquad, SQUADS } = mod('squads/types');
      const squad = findSquad(query);
      if (!squad) return refuse(ctx, 'unknown', `There is no squad called that. The squads are: ${SQUADS.map((x) => x.label).join(', ')}.`);
      const result = await mod('discord/squadRoles').applySquad(client, ctx.guild?.id ?? null, stripId(who), squad);
      if (!result.ok) return refuse(ctx, 'failed', result.reason);
      ctx.json = { code: 'ok', discordId: stripId(who), squad: squadView(squad) };
      return 'ok';
    } },

    // $squadClear[user ID] → ok (was = the squad they left, or empty), or failed
    squadClear: { async fn(ctx, a) {
      const [who] = need(a, 1, '$squadClear[user ID]');
      const { client } = rt();
      const { applySquad, resolveSquad } = mod('discord/squadRoles');
      const before = await resolveSquad(client, ctx.guild?.id ?? null, stripId(who));
      const result = await applySquad(client, ctx.guild?.id ?? null, stripId(who), null);
      if (!result.ok) return refuse(ctx, 'failed', result.reason);
      ctx.json = { code: 'ok', discordId: stripId(who), was: before?.label ?? '' };
      return 'ok';
    } },

    // $squadRoster → ok with squads (role, count) and unassigned, or noserver, nointent, timeout
    squadRoster: { async fn(ctx) {
      const { client } = rt();
      const { resolveGuild } = mod('discord/roles');
      const { SQUADS } = mod('squads/types');
      const guild = await resolveGuild(client, ctx.guild?.id ?? null);
      if (!guild) return refuse(ctx, 'noserver', 'I could not work out which server to count in. Set `DISCORD_GUILD_ID`.');
      // Reading the whole member list needs the Server Members intent, and without it
      // the fetch never answers, so check first.
      const { GatewayIntentBits } = require('discord.js');
      if (!client.options?.intents?.has?.(GatewayIntentBits.GuildMembers)) {
        return refuse(ctx, 'nointent', 'Counting squads needs the Server Members Intent. Turn it on for this bot at <https://discord.com/developers/applications> under Bot > Privileged Gateway Intents.');
      }
      const members = await guild.members.fetch({ time: 20_000 }).catch(() => null);
      if (!members) return refuse(ctx, 'timeout', 'Discord did not send the member list in time. Try again in a moment.');
      ctx.json = {
        code: 'ok',
        squads: SQUADS.map((squad) => ({ ...squadView(squad), count: members.filter((member) => member.roles.cache.has(squad.roleId)).size })),
        unassigned: members.filter((member) => !member.user.bot && !SQUADS.some((squad) => member.roles.cache.has(squad.roleId))).size,
      };
      return 'ok';
    } },
  };


  // ───────────── Roblox group ─────────────
  // Everything here talks to Roblox. Its refusals are worth showing as they are:
  // they say which permission is missing.
  async function groupAttempt(ctx, run) {
    const { GroupError, robloxErrorMessage } = mod('roblox/group');
    try {
      return await run();
    } catch (error) {
      if (error instanceof GroupError) return refuse(ctx, 'refused', error.message);
      return refuse(ctx, 'failed', `Roblox refused that. ${robloxErrorMessage(error)}`);
    }
  }
  const groupTarget = (player) => mod('discord/groupActions').resolveTarget(rt().store, player);
  const targetView = (found) => ({
    user: mod('discord/groupActions').describeUser(found), name: found.user.name, robloxId: String(found.user.id), discordId: found.discordId ?? '', linked: found.discordId ? 'yes' : 'no',
  });
  const roleView = (role) => role && { name: role.name, rank: role.rank, label: mod('discord/groupActions').describeRole(role) };
  const logAction = (ctx, found, action, detail) => mod('discord/groupActions').logGroupAction(rt().client, { action, actorId: ctx.author.id, target: found, detail });

  async function applyRank(ctx, found, role, current) {
    const group = mod('roblox/group');
    await group.setRank(found.user.id, role.id);
    await logAction(ctx, found, 'Ranked', current ? `${current.name} to ${role.name}` : `Set to ${role.name}`);
    ctx.json = { code: 'ok', ...targetView(found), role: roleView(role), was: roleView(current) };
    return 'ok';
  }

  const groupFns = {
    // yes when ROBLOX_GROUP_ID and a cookie are set
    groupOn: { fn: () => (mod('roblox/group').isGroupConfigured() ? 'yes' : 'no') },

    // $groupPending → requests (username, profile, when) and count
    groupPending: { async fn(ctx) {
      return groupAttempt(ctx, async () => {
        const { listJoinRequests } = mod('roblox/group');
        const { robloxProfileUrl } = mod('roblox/games');
        const { discordTimestamp } = mod('util/time');
        const requests = await listJoinRequests(25);
        ctx.json = {
          code: 'ok',
          count: requests.length,
          requests: requests.map((request) => ({
            username: request.username,
            profile: `[${request.username}](${robloxProfileUrl(request.userId)})`,
            when: request.requestedAt ? discordTimestamp(request.requestedAt, 'R') : '',
          })),
        };
        return 'ok';
      });
    } },

    // $groupDecide[accept|decline;player] → ok (user), or norequest, refused, failed
    groupDecide: { async fn(ctx, a) {
      const [choice, player] = need(a, 2, '$groupDecide[accept|decline;player]');
      const accepting = choice.trim().toLowerCase().startsWith('acc');
      return groupAttempt(ctx, async () => {
        const group = mod('roblox/group');
        const found = await groupTarget(player);
        const request = await group.getJoinRequest(found.user.id);
        if (!request) return refuse(ctx, 'norequest', `${found.user.name} has no request waiting. They may already be in the group.`);
        if (accepting) await group.acceptJoinRequest(found.user.id);
        else await group.declineJoinRequest(found.user.id);
        await logAction(ctx, found, accepting ? 'Accepted into the group' : 'Declined');
        ctx.json = { code: 'ok', ...targetView(found) };
        return 'ok';
      });
    } },

    // $groupRank[player;rank name or number] → ok (user, role, was), or nomatch, locked, notmember, already
    groupRank: { async fn(ctx, a) {
      const [player, wanted] = need(a, 2, '$groupRank[player;rank]');
      return groupAttempt(ctx, async () => {
        const group = mod('roblox/group');
        const found = await groupTarget(player);
        const roles = await group.listRoles();
        const role = group.matchRole(roles, wanted);
        if (!role) {
          const names = group.assignableRoles(roles).map((entry) => entry.name);
          return refuse(ctx, 'nomatch', `No rank matches \`${wanted}\`. The group has: ${names.join(', ') || 'no ranks I can set'}.`);
        }
        if (!group.assignableRoles(roles).some((entry) => entry.id === role.id)) {
          return refuse(ctx, 'locked', `${role.name} is not a rank I can hand out. Guest and the owner rank are off limits.`);
        }
        const current = await group.getMembership(found.user.id);
        if (!current) return refuse(ctx, 'notmember', `${found.user.name} is not in the group, so there is nothing to rank.`);
        if (current.id === role.id) {
          ctx.json = { code: 'already', ...targetView(found), role: roleView(role), error: `${mod('discord/groupActions').describeUser(found)} is already ${roleView(role).label}.` };
          return 'already';
        }
        return applyRank(ctx, found, role, current);
      });
    } },

    // $groupStep[up|down;player] → ok (user, role, was), or notmember, edge
    groupStep: { async fn(ctx, a) {
      const [way, player] = need(a, 2, '$groupStep[up|down;player]');
      const direction = way.trim().toLowerCase() === 'down' ? -1 : 1;
      return groupAttempt(ctx, async () => {
        const group = mod('roblox/group');
        const found = await groupTarget(player);
        const current = await group.getMembership(found.user.id);
        if (!current) return refuse(ctx, 'notmember', `${found.user.name} is not in the group, so there is nothing to change.`);
        const next = group.adjacentRole(await group.listRoles(), current.rank, direction);
        if (!next) {
          const { describeUser, describeRole } = mod('discord/groupActions');
          return refuse(ctx, 'edge', `${describeUser(found)} is already at the ${direction === 1 ? 'highest' : 'lowest'} rank I can set (${describeRole(current)}).`);
        }
        return applyRank(ctx, found, next, current);
      });
    } },

    // $groupExile[player] → ok (user, was), or notmember
    groupExile: { async fn(ctx, a) {
      const [player] = need(a, 1, '$groupExile[player]');
      return groupAttempt(ctx, async () => {
        const group = mod('roblox/group');
        const found = await groupTarget(player);
        const current = await group.getMembership(found.user.id);
        if (!current) return refuse(ctx, 'notmember', `${found.user.name} is not in the group.`);
        await group.exile(found.user.id);
        await logAction(ctx, found, 'Exiled', `Was ${current.name}`);
        ctx.json = { code: 'ok', ...targetView(found), was: roleView(current) };
        return 'ok';
      });
    } },

    // $groupInfo[player] → ok (user, robloxId, inGroup, role, waiting, linked)
    groupInfo: { async fn(ctx, a) {
      const [player] = need(a, 1, '$groupInfo[player]');
      return groupAttempt(ctx, async () => {
        const group = mod('roblox/group');
        const found = await groupTarget(player);
        const [current, request] = await Promise.all([group.getMembership(found.user.id), group.getJoinRequest(found.user.id).catch(() => null)]);
        ctx.json = { code: 'ok', ...targetView(found), inGroup: current ? 'yes' : 'no', role: roleView(current), waiting: request ? 'yes' : 'no' };
        return 'ok';
      });
    } },

    // $groupRoles → roles (number, name, members, settable) and count
    groupRoles: { async fn(ctx) {
      return groupAttempt(ctx, async () => {
        const group = mod('roblox/group');
        const roles = await group.listRoles(true);
        const assignable = new Set(group.assignableRoles(roles).map((role) => role.id));
        ctx.json = {
          code: 'ok',
          count: roles.length,
          roles: [...roles].sort((x, y) => y.rank - x.rank).map((role) => ({
            number: String(role.rank).padStart(3, ' '),
            name: role.name,
            members: role.memberCount === null ? '' : ` · ${role.memberCount} member(s)`,
            settable: assignable.has(role.id) ? 'yes' : 'no',
            note: assignable.has(role.id) ? '' : ' *(cannot be set)*',
          })),
        };
        return 'ok';
      });
    } },
  };


  // ───────────── applications ─────────────
  const PAGE_SIZE = 10;

  function applicationsOff(ctx) {
    return refuse(ctx, 'off', 'Applications are off. Set `APPLICATION_SHEET_ID` and `APPLICATION_CHANNEL_ID` to the form’s linked spreadsheet and the channel to post in, then restart.');
  }

  /** Only the answers are searched; the questions are the same on every row. */
  function filterApplications(applications, search) {
    const wanted = String(search ?? '').trim().toLowerCase();
    if (!wanted) return applications;
    return applications.filter((application) => application.answers.some((answer) => answer.answer.toLowerCase().includes(wanted)));
  }

  /**
   * One page of the list, newest first. Everything it needs is in the reply itself,
   * so the page buttons work without storing anything between clicks.
   */
  function listView(applications, page, search, posted) {
    const { applicationLine } = mod('sheets/applications');
    const { config } = mod('config/index');
    const total = applications.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const at = Math.min(Math.max(0, page), pages - 1);
    const shown = [...applications].sort((x, y) => y.rowIndex - x.rowIndex).slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE);
    return {
      total,
      search: search ?? '',
      page: at + 1,
      pages,
      previous: at - 1,
      next: at + 1,
      atStart: at === 0 ? 'yes' : 'no',
      atEnd: at >= pages - 1 ? 'yes' : 'no',
      from: total === 0 ? 0 : at * PAGE_SIZE + 1,
      to: at * PAGE_SIZE + shown.length,
      formUrl: config.applications.formUrl,
      // a row past the cursor has never been posted to the channel
      applications: shown.map((application) => ({
        row: application.rowIndex,
        line: applicationLine(application),
        posted: application.rowIndex > posted ? 'no' : 'yes',
        unseen: application.rowIndex > posted ? ' · *never posted*' : '',
      })),
    };
  }

  // One reputation provider's answer in a line. A provider with no key is reported as
  // not having run, never folded into the clean result.
  function describeProvider(provider) {
    if (provider.configured === false) return `⚪ ${provider.provider}: not configured, so it did not run`;
    if (provider.skipped) return `⚪ ${provider.provider}: skipped${provider.note ? ` (${provider.note})` : ''}`;
    if (provider.ok === false) return `⚠️ ${provider.provider}: lookup failed (${provider.error ?? 'unknown'})`;
    const head = provider.flagged ? `🔴 ${provider.provider}: flagged`
      : provider.appealed ? `🟢 ${provider.provider}: previously flagged, since appealed`
        : `🟢 ${provider.provider}: clean`;
    const lines = (provider.lines ?? []).map((line) => `  ${line}`);
    return [head, ...lines].join('\n') + (provider.partial ? '\n  *Part of this lookup failed.*' : '');
  }

  function checkView(check, discordId) {
    const section = (title, matches) => {
      if (!matches?.length) return null;
      const shown = matches.slice(0, 8).map((m) => `• ${m.name ?? m.assetId ?? 'unnamed item'}${typeof m.score === 'number' ? ` (${m.score})` : ''}${m.reason ? `: ${m.reason}` : ''}`);
      if (matches.length > 8) shown.push(`and ${matches.length - 8} more.`);
      return { title: `${title} (${matches.length})`, lines: shown.join('\n') };
    };
    const flagged = check.flagged === true;
    const providers = check.behavior?.providers ?? [];
    return {
      username: check.username,
      userId: String(check.userId),
      profile: `https://www.roblox.com/users/${check.userId}/profile`,
      flagged: flagged ? 'yes' : 'no',
      incomplete: check.incomplete === true ? 'yes' : 'no',
      private: check.private ? 'yes' : 'no',
      sections: [
        section('Flagged accessories', check.accessoryMatches),
        section('Flagged clothing', check.clothingMatches),
        section('Flagged badges', check.badgeMatches),
        section('Caught by name', check.autoMatches),
      ].filter(Boolean),
      reputation: providers.map(describeProvider).join('\n'),
      // showing this on a flagged user is a condition of Server Sweep's terms
      appeals: flagged ? check.behavior?.appealsUrl ?? '' : '',
      score: typeof check.totalScore === 'number' && check.totalScore > 0 ? check.totalScore : '',
      discordId: discordId ?? '',
    };
  }

  const describeDm = (outcome) => ({
    sent: 'They have been told by DM.',
    blocked: 'I could not DM them, their DMs are probably closed, so tell them yourself.',
  }[outcome] ?? 'No Discord account was on the application, so nobody was told.');

  const appFns = {
    // yes when the form's sheet and the applications channel are set
    appOn: { fn: () => (rt().applications ? 'yes' : 'no') },

    // $appList[search?;page?] → one page, newest first: applications (row, line, unseen),
    // total, page, pages, previous, next, atStart, atEnd, from, to, search
    appList: { async fn(ctx, a) {
      const { applications } = rt();
      if (!applications) return applicationsOff(ctx);
      const search = arg(a, 0).trim() || null;
      const page = Math.floor(Number(arg(a, 1, '1')) || 1) - 1;
      const [all, posted] = await Promise.all([applications.fetchAll(), applications.cursor()]);
      ctx.json = { code: 'ok', ...listView(filterApplications(all, search), page, search, posted) };
      return 'ok';
    } },

    // $appPost[number;to?] → posts them to the applications channel. ok (sent, title),
    // partial (sent, wanted), or order, toomany, empty, none
    appPost: { async fn(ctx, a) {
      const { applications, client } = rt();
      if (!applications) return applicationsOff(ctx);
      const from = Math.floor(num(need(a, 1, '$appPost[number;to?]')[0], 'number'));
      const to = arg(a, 1) ? Math.floor(num(a[1], 'to')) : from;
      if (to < from) return refuse(ctx, 'order', '`to` has to be the same as `number` or higher.');
      if (to - from + 1 > 20) return refuse(ctx, 'toomany', `That is ${to - from + 1} applications. Post at most 20 at a time.`);
      const all = await applications.fetchAll();
      const wanted = all.filter((application) => application.rowIndex >= from && application.rowIndex <= to);
      if (wanted.length === 0) {
        return refuse(ctx, all.length === 0 ? 'empty' : 'none', all.length === 0 ? 'There are no applications in the sheet yet.' : `No application in that range. They run from #1 to #${all.length}.`);
      }
      let sent = 0;
      for (const application of wanted) if (await applications.postOne(client, application)) sent += 1;
      // Anything posted by hand counts as posted, or the next poll sends it again.
      // The cursor is one watermark, so posting #23 also marks #19 to #22 seen.
      const highest = wanted[wanted.length - 1]?.rowIndex ?? 0;
      if (sent > 0 && highest > (await applications.cursor())) await applications.setCursor(highest);
      const { config } = mod('config/index');
      const { applicationTitle } = mod('sheets/applications');
      ctx.json = { code: sent === wanted.length ? 'ok' : 'partial', sent, wanted: wanted.length, channelId: config.applications.channelId, title: sent === 1 ? applicationTitle(wanted[0]) : '' };
      return ctx.json.code;
    } },

    // $appCard → for Accept and Deny: ok when the card this button is on is still open,
    // decided when somebody got there first.
    appCard: { async fn(ctx) {
      const { applications } = rt();
      const saved = applications && ctx.messageId ? await applications.card(ctx.messageId) : null;
      const legacy = saved ? null : await legacyCard(ctx, ['Accepted', 'Denied']);
      if (saved?.decided === 'yes' || legacy?.decided) return refuse(ctx, 'decided', 'That application has already been decided.');
      ctx.json = { code: 'ok', ...(saved ?? {}) };
      return 'ok';
    } },

    // $appCheck[Roblox username;Discord ID?] → the background check: ok with username,
    // flagged, incomplete, private, sections (title, lines), reputation, appeals, score.
    // Otherwise nouser, not_found, rate_limited, off or failed.
    appCheck: { async fn(ctx, a) {
      const username = arg(a, 0).trim();
      const discordId = arg(a, 1).trim();
      const applicant = discordId && discordId !== '-' ? discordId : null;
      if (!username || username === '-') return refuse(ctx, 'nouser', 'No Roblox username could be read from this application, so there is nobody to check.');
      const outcome = await mod('rovuew/client').fullCheck(username, applicant);
      if (outcome.status === 'ok') { ctx.json = { code: 'ok', ...checkView(outcome.result, applicant) }; return 'ok'; }
      if (outcome.status === 'not_found') return refuse(ctx, 'not_found', `Roblox has no account called \`${username}\`.`);
      if (outcome.status === 'rate_limited') return refuse(ctx, 'rate_limited', `RoVuew is cooling down. ${outcome.message}`);
      if (outcome.status === 'off') return refuse(ctx, 'off', 'Background checks are off.');
      mod('util/logger').createLogger('applications').warn(`Background check for ${username} failed: ${outcome.reason}`);
      return refuse(ctx, 'failed', `The check did not run. ${outcome.reason}`);
    } },

    // $appDecide[accept|deny;row;Roblox username;Discord ID;reason?] → from the reason
    // form. Acts on the group where it can, redraws the card with the decision and DMs
    // the applicant with the "application decision" hook. ok, with note (what happened
    // in the group) and dmNote (whether they were told), or decided.
    appDecide: { async fn(ctx, a) {
      const [choice, , username, discordId] = need(a, 4, '$appDecide[accept|deny;row;Roblox username;Discord ID;reason?]');
      const accepting = choice.trim().toLowerCase().startsWith('acc');
      const reason = arg(a, 4).trim() || null;
      const { applications, client, store } = rt();
      const log = mod('util/logger').createLogger('discord:applications');

      const saved = applications && ctx.messageId ? await applications.card(ctx.messageId) : null;
      const legacy = saved ? null : await legacyCard(ctx, ['Accepted', 'Denied']);
      if (saved?.decided === 'yes' || legacy?.decided) return refuse(ctx, 'decided', 'That application has already been decided.');
      if (!ctx.messageId) log.warn('A decision form came back with no message to update');

      const note = await applyGroupDecision(ctx, store, accepting, username.trim() || '-');
      const applicant = discordId.trim() && discordId.trim() !== '-' ? discordId.trim() : null;
      let dm = 'unknown_member';
      if (applicant) {
        const { config } = mod('config/index');
        dm = (await mod('ui').dm(applicant, 'application decision', {
          accepted: accepting ? 'yes' : 'no', reason: reason ?? '', guildName: ctx.guild?.name ?? '', formUrl: config.applications.formUrl,
        })) ? 'sent' : 'blocked';
      }

      const decision = { decided: 'yes', accepted: accepting ? 'yes' : 'no', decidedBy: ctx.author.id, reason: reason ?? '', note: note ?? '' };
      if (saved) {
        await applications.saveCard(ctx.messageId, { ...saved, ...decision });
        await mod('ui').edit(ctx.channel.id, ctx.messageId, 'application', { ...saved, ...decision });
      } else if (legacy) {
        await legacy.mark(accepting ? 'Accepted' : 'Denied', [`By <@${ctx.author.id}>`, reason, note].filter(Boolean).join('\n'));
      }
      ctx.json = { code: 'ok', accepted: accepting ? 'yes' : 'no', note: note ?? '', dm, dmNote: describeDm(dm) };
      return 'ok';
    } },
  };

  /**
   * Acts on the group where it can. A Roblox failure is reported rather than thrown:
   * the decision itself still stands, it just did not reach the group.
   */
  async function applyGroupDecision(ctx, store, accepting, username) {
    if (username === '-') {
      return 'No Roblox username could be read from the application, so the group was not changed. Use `/group action:accept` once you know it.';
    }
    const group = mod('roblox/group');
    if (!group.isGroupConfigured()) return 'Group management is off, so only the card was updated.';
    const { targetFromUsername, logGroupAction } = mod('discord/groupActions');
    try {
      const found = await targetFromUsername(store, username);
      const request = await group.getJoinRequest(found.user.id);
      if (!request) return `${found.user.name} has no join request waiting, so the group was left alone.`;
      if (accepting) await group.acceptJoinRequest(found.user.id);
      else await group.declineJoinRequest(found.user.id);
      await logGroupAction(rt().client, { action: accepting ? 'Accepted into the group' : 'Declined', actorId: ctx.author.id, target: found, detail: 'From an application card' });
      return accepting ? `${found.user.name} was accepted into the group.` : `${found.user.name}'s join request was declined.`;
    } catch (error) {
      const why = error instanceof group.GroupError ? error.message : group.robloxErrorMessage(error);
      mod('util/logger').createLogger('discord:applications').warn(`Group action from an application card failed: ${why}`);
      return `The group was not changed: ${why}`;
    }
  }


  // ───────────── admin ─────────────
  /** "+1h 30m" or "-45m", so the direction of a correction is never in doubt. */
  const formatSigned = (ms) => (ms === 0 ? '0m' : `${ms > 0 ? '+' : '-'}${mod('util/time').formatDuration(Math.abs(ms))}`);

  /** Writes what an admin did to ADMIN_LOG_CHANNEL_ID with the "admin log" hook. Never undoes the action. */
  async function logAdmin(ctx, what, extra = {}) {
    const { config } = mod('config/index');
    if (!config.discord.adminLogChannelId) return;
    try {
      await mod('ui').post(config.discord.adminLogChannelId, 'admin log', { what, actorId: ctx.author.id, ...extra });
    } catch (error) {
      mod('util/logger').createLogger('discord:admin').warn(`Could not write to the admin log channel: ${mod('util/logger').describeError(error)}`);
    }
  }

  const adminDenied = (ctx) => {
    const { config } = mod('config/index');
    return refuse(ctx, 'denied', config.discord.adminRoleId
      ? `Only <@&${config.discord.adminRoleId}> can use the admin panel.`
      : 'This needs the Administrator permission, or an `ADMIN_ROLE_ID` role.');
  };

  async function endShiftFor(ctx, discordId) {
    const { manager } = rt();
    const { summarise } = mod('shifts/manager');
    const { formatDuration } = mod('util/time');
    const shift = await manager.endIfOpen(discordId, 'admin');
    if (!shift) return refuse(ctx, 'notonshift', `<@${discordId}> was no longer on shift.`);
    const banked = formatDuration(summarise([shift]).workedMs);
    await logAdmin(ctx, `Ended <@${discordId}>'s shift, ${banked} banked.`);
    ctx.json = { code: 'ok', discordId, typeLabel: mod('shifts/types').shiftTypeLabel(shift.type), banked };
    return 'ok';
  }

  async function endEventFor(ctx, eventId) {
    const { events } = rt();
    const event = await events.getEvent(eventId);
    if (!event) return refuse(ctx, 'missing', 'There is no event with that id.');
    // Finishing something that never started would bank nothing and look like a bug.
    if (event.status === 'scheduled') return refuse(ctx, 'not_started', `${event.name} has not started yet. Cancel it with \`/event action:cancel\` instead.`);
    const result = await events.finish(eventId);
    if (!result) return refuse(ctx, 'over', `${event.name} is already over.`);
    const banked = (await events.listSignups(eventId)).filter((signup) => signup.shiftId !== null).length;
    await logAdmin(ctx, `Ended the event ${result.name}, ${banked} logged.`);
    ctx.json = { code: 'ok', name: result.name, banked };
    return 'ok';
  }

  const adminFns = {
    // $adminPanel → who is on shift and which events are open, for the admin panel:
    // shifts (mention, typeLabel, worked, onBreak, label, description), events (id, name, when, host, description)
    adminPanel: { async fn(ctx) {
      const { manager, events } = rt();
      if (!allowed(ctx, 'admin')) return adminDenied(ctx);
      const { computeDurations } = mod('shifts/manager');
      const { shiftTypeLabel } = mod('shifts/types');
      const { formatDuration, discordTimestamp } = mod('util/time');
      const now = Date.now();
      const [shifts, open] = await Promise.all([manager.listOpenShifts(), events.listOpenEvents(ctx.guild?.id ?? null)]);
      ctx.json = {
        code: 'ok',
        shiftCount: shifts.length,
        eventCount: open.length,
        shifts: shifts.slice(0, 25).map((shift) => {
          const worked = formatDuration(computeDurations(shift, now).workedMs);
          return {
            discordId: shift.discordId, mention: `<@${shift.discordId}>`, typeLabel: shiftTypeLabel(shift.type), worked,
            onBreak: shift.status === 'on_break' ? ' *(on break)*' : '',
            label: shift.robloxUsername ?? shift.discordId,
            description: `${shiftTypeLabel(shift.type)} · ${worked}`.slice(0, 100),
          };
        }),
        events: open.slice(0, 25).map((event) => ({
          id: event.id, name: event.name.slice(0, 100), host: `<@${event.hostId}>`,
          when: event.status === 'running' ? 'running' : `starts ${discordTimestamp(event.startsAt, 'R')}`,
          description: `${event.status} · hosted by ${event.hostId}`.slice(0, 100),
        })),
      };
      return 'ok';
    } },

    // $adminEndShift[user ID] → ok (typeLabel, banked), or notonshift, denied
    adminEndShift: { async fn(ctx, a) {
      rt();
      if (!allowed(ctx, 'admin')) return adminDenied(ctx);
      return endShiftFor(ctx, stripId(need(a, 1, '$adminEndShift[user ID]')[0]));
    } },

    // $adminEndEvent[event ID] → ok (name, banked), or missing, not_started, over, denied
    adminEndEvent: { async fn(ctx, a) {
      rt();
      if (!allowed(ctx, 'admin')) return adminDenied(ctx);
      return endEventFor(ctx, need(a, 1, '$adminEndEvent[event ID]')[0].trim());
    } },

    // $adminAdjust[add|remove;user ID;type;time like 90m or 1h30m] → ok (signed, typeLabel, after),
    // or unknown_type, bad_time, too_much, not_enough, denied. The correction is its own record.
    adminAdjust: { async fn(ctx, a) {
      const [way, who, type, raw] = need(a, 4, '$adminAdjust[add|remove;user ID;type;time]');
      const { manager } = rt();
      if (!allowed(ctx, 'admin')) return adminDenied(ctx);
      const { isShiftType, shiftTypeLabel } = mod('shifts/types');
      const { parseDuration } = mod('ranks/types');
      const { summarise } = mod('shifts/manager');
      const { formatDuration } = mod('util/time');
      const target = stripId(who);
      const sign = way.trim().toLowerCase().startsWith('rem') ? -1 : 1;
      if (!isShiftType(type.trim())) return refuse(ctx, 'unknown_type', 'That is not a shift type I know about.');
      const minutes = parseDuration(raw);
      if (minutes <= 0) return refuse(ctx, 'bad_time', `\`${raw}\` is not a length of time. Use \`90m\`, \`2h\` or \`1h30m\`.`);
      // Long enough to fix a mistake, short enough that a typo cannot invent a year.
      if (minutes > 100 * 60) return refuse(ctx, 'too_much', `That is ${Math.round(minutes / 60)} hours. Adjust at most 100 at a time.`);
      const deltaMs = sign * minutes * 60_000;
      // Taking away more than somebody has would leave a negative total.
      const banked = summarise(await manager.listShifts(target, { type: type.trim() })).workedMs;
      if (sign === -1 && banked + deltaMs < 0) {
        return refuse(ctx, 'not_enough', `<@${target}> only has ${formatDuration(banked)} of ${shiftTypeLabel(type.trim())}, so ${formatDuration(-deltaMs)} cannot come off.`);
      }
      await manager.adjust({ discordId: target, guildId: ctx.guild?.id ?? null, type: type.trim(), deltaMs, actorId: ctx.author.id });
      const after = formatDuration(banked + deltaMs);
      await logAdmin(ctx, `${formatSigned(deltaMs)} of ${shiftTypeLabel(type.trim())} for <@${target}>, now ${after}.`);
      ctx.json = { code: 'ok', discordId: target, signed: formatSigned(deltaMs), typeLabel: shiftTypeLabel(type.trim()), after };
      return 'ok';
    } },
  };

  const diagnoseFns = {
    // $aesuDiagnose → sections (title, mark, text) and verdict (mark, text): why the
    // bot is or is not seeing whoever ran it in game
    aesuDiagnose: { async fn(ctx) {
      const { store, client } = rt();
      const guild = ctx.guild?.id ? client.guilds.cache.get(ctx.guild.id) ?? null : null;
      const report = await mod('diagnose').diagnose({ store, client, userId: ctx.author.id, guild });
      const { MARK } = mod('diagnose');
      ctx.json = {
        sections: report.sections,
        verdict: report.verdict ? { ...report.verdict, mark: MARK[report.verdict.status] } : null,
      };
      return '';
    } },
  };

  return {
    ...diagnoseFns,
    ...adminFns,
    ...appFns,
    ...groupFns,
    ...eventFns,
    ...promoFns,
    ...squadFns,

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
        hostedText: hosted.hosted === 0 && hosted.live === 0 ? 'None' : `${hosted.hosted}${hosted.live > 0 ? ` (${hosted.live} on now)` : ''}`,
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

    // $linkStart[Roblox username?] → links without Roblox's sign in page.
    // confirm: Bloxlink knows them, show the account and ask them to confirm it
    // code: they typed a username Bloxlink does not vouch for, so they put $json[code] in their About
    // ask: nothing to go on, ask for their username. not_found: no such Roblox user.
    // The JSON has robloxId, username, displayName, profile and avatar.
    linkStart: { async fn(ctx, a) {
      rt();
      const result = await mod('link').start(ctx.author.id, ctx.guild?.id ?? null, arg(a, 0).trim());
      ctx.json = result;
      if (result.status === 'not_found') ctx.json.error = `There is no Roblox account called ${result.username}. Check the spelling.`;
      if (result.status === 'ask') ctx.json.error = 'Bloxlink does not know your Roblox account. Run /connect again with your Roblox username.';
      return result.status;
    } },

    // $linkConfirm → finishes it. ok, or expired (start again), missing (the code is not
    // in their About yet), failed (Roblox did not answer)
    linkConfirm: { async fn(ctx) {
      const { store, client, manager } = rt();
      const link = mod('link');
      const entry = link.current(ctx.author.id);
      if (!entry) return refuse(ctx, 'expired', 'That ran out. Run /connect again.');
      if (entry.via === 'code') {
        let found;
        try { found = await link.codeIsInProfile(entry); } catch { return refuse(ctx, 'failed', 'Roblox did not answer. Try again in a moment.'); }
        if (!found) return refuse(ctx, 'missing', `The code ${entry.code} is not in the About of ${entry.name} yet. Save it on Roblox, wait a few seconds, then press the button again.`, link.view(entry));
      }
      const now = Date.now();
      await store.upsertLink({
        discordId: ctx.author.id, robloxId: entry.robloxId, robloxUsername: entry.name, robloxDisplayName: entry.displayName,
        accessToken: null, refreshToken: null, tokenExpiresAt: null, linkedAt: now, updatedAt: now,
      });
      // Start presence fresh, so the next poll treats them as joining.
      await store.deleteWatchState(ctx.author.id);
      link.cancel(ctx.author.id);
      mod('util/logger').createLogger('link').info(`Linked Discord ${ctx.author.id} to Roblox ${entry.robloxId} (${entry.name}) through ${entry.via}`);
      void mod('ui').dm(ctx.author.id, 'connect linked', { discordId: ctx.author.id, displayName: entry.displayName, username: entry.name });
      void mod('discord/roles').syncDutyRoles(client, manager, ctx.guild?.id ?? null, ctx.author.id);
      ctx.json = { code: 'ok', ...link.view(entry) };
      return 'ok';
    } },

    // $linkCancel → forgets a link that was not finished
    linkCancel: { fn(ctx) { mod('link').cancel(ctx.author.id); return ''; } },

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
