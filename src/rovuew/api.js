const express = require('express');
const config = require('./config');
const { checkAccessories, checkClothing, checkBadges, fullCheck } = require('./checkService');
const { resolveShareLinkToItem } = require('./shareLink');

// In-memory per-key rate limiting. This works well for a single Railway
// instance (the normal setup for a bot like this). If you ever scale to
// multiple replicas, swap this Map for a shared store like Redis.
const lastRequestByKey = new Map();

function apiKeyMiddleware(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || !config.API_KEYS.includes(key)) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }

  const now = Date.now();
  const last = lastRequestByKey.get(key) || 0;
  const elapsed = now - last;
  if (elapsed < config.RATE_LIMIT_MS) {
    const wait = Math.ceil((config.RATE_LIMIT_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Rate limited. Try again in ${wait}s.` });
  }

  lastRequestByKey.set(key, now);
  next();
}

function respondWithResult(res, result) {
  if (result.error === 'user_not_found') {
    return res.status(404).json({ error: 'Roblox user not found.' });
  }
  if (result.private) {
    return res.json({
      username: result.username,
      userId: result.userId,
      private: true,
      message: 'inventory is private',
    });
  }
  return res.json(result);
}

function createApiServer() {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Accessories, clothing and badges are separate endpoints, mirroring the
  // separate Discord commands - they use different Roblox APIs and can
  // fail independently.
  app.get('/check/:user', apiKeyMiddleware, async (req, res) => {
    try {
      const result = await checkAccessories(req.params.user);
      return respondWithResult(res, result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal error while checking accessories.' });
    }
  });

  app.get('/checkclothes/:user', apiKeyMiddleware, async (req, res) => {
    try {
      const result = await checkClothing(req.params.user);
      return respondWithResult(res, result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal error while checking clothing.' });
    }
  });

  app.get('/checkbadges/:user', apiKeyMiddleware, async (req, res) => {
    try {
      const result = await checkBadges(req.params.user);
      return respondWithResult(res, result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal error while checking badges.' });
    }
  });

  // Deliberately doesn't reuse respondWithResult: a private inventory
  // isn't a dead end here, since the behaviour APIs still return a useful
  // answer, so the full payload goes back with `private` set on it.
  app.get('/fullcheck/:user', apiKeyMiddleware, async (req, res) => {
    try {
      const discord = typeof req.query.discord === 'string' ? req.query.discord.trim() : null;
      if (discord && !/^\d{15,25}$/.test(discord)) {
        return res.status(400).json({ error: 'discord must be a numeric Discord user ID.' });
      }

      const result = await fullCheck(req.params.user, { discordUserId: discord || null });
      if (result.error === 'user_not_found') {
        return res.status(404).json({ error: 'Roblox user not found.' });
      }
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal error while running the full check.' });
    }
  });

  app.get('/resolvelink', apiKeyMiddleware, async (req, res) => {
    try {
      const link = typeof req.query.link === 'string' ? req.query.link.trim() : '';
      const result = await resolveShareLinkToItem(link);
      if (result.status === 'invalid_link') {
        return res.status(400).json({ error: 'link must be a Roblox share link or its code.' });
      }
      if (result.status === 'not_found') {
        return res
          .status(404)
          .json({ error: 'Roblox did not resolve that link to an item.', detail: result.detail || null });
      }
      return res.json({
        assetId: result.assetId,
        name: result.name,
        url: result.url,
        type: result.type,
        assetTypeName: result.assetTypeName,
        itemKind: result.itemKind,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Internal error while resolving the share link.' });
    }
  });

  return app;
}

module.exports = { createApiServer };
