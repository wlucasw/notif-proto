// In-memory storage. Each Map stands in for a table/collection in production
// (PostgreSQL for preferences and the log, Redis for dedup and throttling).

export function createStore() {
  return {
    users: new Map(),            // userId -> { email, phone, pushTokens[], preferences }
    productViews: new Map(),     // productId -> Map<userId, lastViewedAt>
    processedEvents: new Set(),  // already processed eventIds (ingestion idempotency)
    notifications: new Map(),    // notificationId -> notification (log / status)
    sentPromos: new Map(),       // userId -> [timestamps] (marketing throttling)
  };
}

export const DEFAULT_PREFERENCES = {
  channels: { email: true, sms: true, push: true },
  marketingOptIn: false, // opt-in disabled by default (GDPR)
};

export function upsertUser(store, userId, data = {}) {
  const existing = store.users.get(userId) ?? {
    email: null,
    phone: null,
    pushTokens: [],
    preferences: structuredClone(DEFAULT_PREFERENCES),
  };
  const merged = {
    ...existing,
    ...data,
    preferences: {
      ...existing.preferences,
      ...(data.preferences ?? {}),
      channels: { ...existing.preferences.channels, ...(data.preferences?.channels ?? {}) },
    },
  };
  store.users.set(userId, merged);
  return merged;
}

export function seed(store) {
  upsertUser(store, 'u1', {
    email: 'alice@example.com',
    phone: '+33600000001',
    pushTokens: ['device-alice'],
    preferences: { marketingOptIn: true },
  });
  upsertUser(store, 'u2', {
    email: 'bob@example.com',
    phone: null, // no phone: the SMS channel will be skipped
    pushTokens: [],
    preferences: { channels: { email: true, sms: false, push: true } },
  });
  // Address that makes the email adapter fail: used to demonstrate retry + DLQ
  upsertUser(store, 'u3', {
    email: 'fail@example.com',
    phone: '+33600000003',
    pushTokens: ['device-carol'],
    preferences: { marketingOptIn: true },
  });
}
