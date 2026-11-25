// HTTP API (native http module, no dependencies).
//
//   POST /events                         publishes a business event          -> 202
//   GET  /users/:id/notifications        send history and status             -> 200
//   PUT  /users/:id/preferences          channels + marketing consent        -> 200
//   GET  /health                                                             -> 200

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStore, seed, upsertUser } from './store.js';
import { createChannels } from './channels.js';
import { createNotificationSystem } from './notifier.js';

export function createApp({ store = createStore(), channels = createChannels(), ...opts } = {}) {
  const system = createNotificationSystem({ store, channels, ...opts });

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 1e6) reject(new Error('payload too large'));
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', ...system.stats() });
      }

      if (req.method === 'POST' && url.pathname === '/events') {
        const result = system.ingest(await readJson(req));
        if (result.status === 'invalid') return send(res, 400, { error: 'invalid event', details: result.errors });
        if (result.status === 'duplicate') return send(res, 200, { status: 'duplicate', message: 'event already received, ignored' });
        return send(res, 202, { status: 'accepted' });
      }

      if (parts[0] === 'users' && parts[1]) {
        const userId = decodeURIComponent(parts[1]);
        if (req.method === 'GET' && parts[2] === 'notifications' && parts.length === 3) {
          return send(res, 200, { userId, notifications: system.listForUser(userId) });
        }
        if (req.method === 'PUT' && parts[2] === 'preferences' && parts.length === 3) {
          const body = await readJson(req);
          const { channels: ch, marketingOptIn } = body;
          if (ch !== undefined && (typeof ch !== 'object' || Object.values(ch).some((v) => typeof v !== 'boolean'))) {
            return send(res, 400, { error: 'channels must be an object { email|sms|push: boolean }' });
          }
          if (marketingOptIn !== undefined && typeof marketingOptIn !== 'boolean') {
            return send(res, 400, { error: 'marketingOptIn must be a boolean' });
          }
          const prefs = {};
          if (ch) prefs.channels = ch;
          if (marketingOptIn !== undefined) prefs.marketingOptIn = marketingOptIn;
          const user = upsertUser(store, userId, { preferences: prefs });
          return send(res, 200, { userId, preferences: user.preferences });
        }
      }

      send(res, 404, { error: 'unknown route' });
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });

  return { server, system, store };
}

// Direct launch: `node src/server.js`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = createStore();
  seed(store);
  const { server } = createApp({ store });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Notification service on http://localhost:${port}`));
}
