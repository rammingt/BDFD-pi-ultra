'use strict';
const { createLogger, describeError } = require('../util/logger');

const log = createLogger('discord:channels');

/** Fetches a channel and narrows it to something the bot can actually post in. */
async function resolveSendableChannel(client, channelId) {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      log.warn(`Channel ${channelId} was not found`);
      return null;
    }
    if (!channel.isSendable()) {
      log.warn(`Channel ${channelId} is not a channel the bot can send messages to`);
      return null;
    }
    return channel;
  } catch (error) {
    log.warn(`Could not fetch channel ${channelId}: ${describeError(error)}`);
    return null;
  }
}

module.exports = { resolveSendableChannel };
