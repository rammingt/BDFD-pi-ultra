'use strict';
// Keeps each event's post up to date, and sends the two messages that are meant
// to ping people: the event starting ("event start") and a host who left the game
// while their event is still counting ("event host away"). The post is "event post".
const { createLogger, describeError } = require('../util/logger');
const ui = require('../ui');
const { eventView } = require('../views');
const { DECLINED_ROLE_KEY } = require('../events/types');

const log = createLogger('discord:events');

/** Redraws the announcement so it always shows the current sign ups and status. */
async function refreshEventPost(events, event) {
  if (!event.channelId || !event.messageId) return;
  const signups = await events.listSignups(event.id);
  await ui.edit(event.channelId, event.messageId, 'event post', eventView(event, signups), { about: event.hostId, guildId: event.guildId });
}

function registerEventPosts(events) {
  events.onChange(async (change, event) => {
    // A host who has wandered off changes nothing on the post itself.
    if (change !== 'host_away') {
      try {
        await refreshEventPost(events, event);
      } catch (error) {
        log.error(`Could not refresh the post for event ${event.id}: ${describeError(error)}`);
      }
    }

    if (!event.channelId || (change !== 'started' && change !== 'host_away')) return;

    try {
      if (change === 'host_away') {
        await ui.post(event.channelId, 'event host away', eventView(event), { about: event.hostId, guildId: event.guildId, ping: [event.hostId] });
        return;
      }

      const signups = await events.listSignups(event.id);
      // Discord mentions at most 100 people in one message.
      const ping = signups.filter((signup) => signup.roleKey !== DECLINED_ROLE_KEY).slice(0, 100).map((signup) => signup.discordId);
      if (ping.length === 0) return;
      await ui.post(event.channelId, 'event start', eventView(event, signups), { about: event.hostId, guildId: event.guildId, ping });
    } catch (error) {
      log.error(`Could not post the ${change} notice for event ${event.id}: ${describeError(error)}`);
    }
  });
}

module.exports = { registerEventPosts, refreshEventPost };
