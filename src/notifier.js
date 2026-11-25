// Core of the system: ingestion -> planning (fan-out + filters) -> delivery (retry + DLQ).

import { Queue } from './bus.js';
import { RULES, TEMPLATES, CATEGORY, REQUIRED_FIELDS } from './rules.js';

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return ['body must be a JSON object'];
  const errors = [];
  if (typeof e.eventId !== 'string' || !e.eventId) errors.push('eventId (string) required');
  const required = REQUIRED_FIELDS[e.type];
  if (!required) errors.push(`unknown type: ${e.type}`);

  const p = e.payload;
  if (!p || typeof p !== 'object') return [...errors, 'payload (object) required'];

  for (const [field, type] of Object.entries(required ?? {})) {
    if (type === 'number' && typeof p[field] !== 'number') errors.push(`payload.${field} (number) required`);
    else if (type !== 'number' && !p[field]) errors.push(`payload.${field} required`);
  }
  return errors;
}

export function createNotificationSystem({
  store,
  channels,
  now = () => Date.now(),
  maxAttempts = 3,
  retryBaseMs = 200,
} = {}) {
  const deadLetters = [];

  // Marketing frequency limiting: the only place that touches store.sentPromos
  const throttle = {
    isThrottled(userId, { maxPerUser, windowMs }) {
      const since = now() - windowMs;
      const recent = (store.sentPromos.get(userId) ?? []).filter((t) => t >= since);
      store.sentPromos.set(userId, recent);
      return recent.length >= maxPerUser;
    },
    recordSent(userId) {
      const list = store.sentPromos.get(userId) ?? [];
      list.push(now());
      store.sentPromos.set(userId, list);
    },
  };

  // ---------- 1. Ingestion ----------
  function ingest(event) {
    const errors = validateEvent(event);
    if (errors.length) return { status: 'invalid', errors };
    // Idempotency: a producer replaying the same event triggers nothing more
    if (store.processedEvents.has(event.eventId)) return { status: 'duplicate' };
    store.processedEvents.add(event.eventId);
    eventsQueue.publish({ ...event, receivedAt: now() });
    return { status: 'accepted' };
  }

  // ---------- 2. Planning ----------
  // Events with a dedicated handler; every other type produces notifications.
  const handlers = {
    'product.viewed': trackView,
  };

  async function handleEvent(event) {
    const handler = handlers[event.type] ?? planNotifications;
    return handler(event);
  }

  // A view is only recorded: it feeds the promotion fan-out later
  function trackView(event) {
    const { userId, productId } = event.payload;
    if (!store.productViews.has(productId)) store.productViews.set(productId, new Map());
    store.productViews.get(productId).set(userId, now());
  }

  function planNotifications(event) {
    const rule = RULES[event.type];
    for (const userId of resolveRecipients(event, rule)) {
      planForUser(event, rule, userId);
    }
  }

  function resolveRecipients(event, rule) {
    if (event.type === 'promotion.started') {
      // Fan-out: all users who viewed the product within the window
      const views = store.productViews.get(event.payload.productId) ?? new Map();
      const since = now() - rule.recentViewWindowMs;
      return [...views].filter(([, at]) => at >= since).map(([userId]) => userId);
    }
    return [event.payload.userId];
  }

  // Why this user gets nothing at all for this event (null = eligible)
  function userSkipReason(user, rule, userId) {
    if (!user) return 'unknown user';
    if (rule.category !== CATEGORY.MARKETING) return null;
    if (!user.preferences.marketingOptIn) return 'no marketing consent';
    if (throttle.isThrottled(userId, rule.throttle)) return 'marketing frequency limit reached';
    return null;
  }

  // Why this specific channel is skipped for this user (null = can send)
  function channelSkipReason(adapter, user, channel, address) {
    if (!adapter) return 'channel unavailable';
    if (!user.preferences.channels[channel]) return 'channel disabled by user';
    if (!address) return 'no contact details for this channel';
    return null;
  }

  function planForUser(event, rule, userId) {
    const user = store.users.get(userId);
    const message = TEMPLATES[event.type](event.payload);
    const base = { eventId: event.eventId, eventType: event.type, userId, message, createdAt: now() };

    const userReason = userSkipReason(user, rule, userId);
    if (userReason) {
      record({ ...base, id: `${event.eventId}:${userId}:*`, channel: null, status: 'skipped', reason: userReason });
      return;
    }

    let scheduled = 0;
    for (const channel of rule.channels) {
      const id = `${event.eventId}:${userId}:${channel}`; // per-send idempotency key
      if (store.notifications.has(id)) continue;
      const adapter = channels[channel];
      const address = adapter?.resolveAddress(user);

      const reason = channelSkipReason(adapter, user, channel, address);
      if (reason) {
        record({ ...base, id, channel, status: 'skipped', reason });
        continue;
      }
      record({ ...base, id, channel, address, status: 'pending', attempts: 0, priority: rule.priority });
      deliveriesQueue.publish(id);
      scheduled++;
    }

    if (rule.category === CATEGORY.MARKETING && scheduled > 0) throttle.recordSent(userId);
  }

  // ---------- 3. Delivery ----------
  async function deliver(notificationId) {
    const n = store.notifications.get(notificationId);
    if (!n || n.status === 'sent' || n.status === 'dead') return;
    n.attempts++;
    try {
      const res = await channels[n.channel].send(n.address, n.message);
      Object.assign(n, { status: 'sent', sentAt: now(), providerMessageId: res.providerMessageId, lastError: null });
    } catch (err) {
      n.lastError = err.message;
      if (err.retryable !== false && n.attempts < maxAttempts) {
        n.status = 'retrying';
        const delayMs = retryBaseMs * 2 ** (n.attempts - 1); // exponential backoff
        deliveriesQueue.publish(notificationId, { delayMs });
      } else {
        n.status = 'dead';
        deadLetters.push(notificationId); // DLQ: to be replayed or analyzed manually
      }
    }
  }

  function record(notification) {
    store.notifications.set(notification.id, notification);
  }

  const eventsQueue = new Queue('events', handleEvent);
  const deliveriesQueue = new Queue('deliveries', deliver, { concurrency: 8 });

  return {
    ingest,
    deadLetters,
    listForUser: (userId) => [...store.notifications.values()].filter((n) => n.userId === userId),
    stats: () => ({ eventsQueued: eventsQueue.size, deliveriesQueued: deliveriesQueue.size, deadLetters: deadLetters.length }),
    // Waits for all in-flight processing to finish (tests / demo)
    async drain() {
      do {
        await eventsQueue.drain();
        await deliveriesQueue.drain();
      } while (eventsQueue.size || deliveriesQueue.size);
    },
  };
}
