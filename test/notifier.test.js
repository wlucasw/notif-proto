import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createStore, seed } from '../src/store.js';
import { createChannels } from '../src/channels.js';

let app, base;

beforeEach(async () => {
  const store = createStore();
  seed(store);
  app = createApp({ store, channels: createChannels({ log: false }), retryBaseMs: 5 });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});

afterEach(() => new Promise((r) => app.server.close(r)));

const post = (body) =>
  fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const notifs = async (userId) => {
  await app.system.drain();
  return (await (await fetch(`${base}/users/${userId}/notifications`)).json()).notifications;
};

test('order placed: 202 then send via email + push', async () => {
  const res = await post({ eventId: 'e1', type: 'order.placed', payload: { orderId: 'C1', userId: 'u1', total: 42 } });
  assert.equal(res.status, 202);
  const list = await notifs('u1');
  assert.deepEqual(list.map((n) => `${n.channel}:${n.status}`).sort(), ['email:sent', 'push:sent']);
});

test('invalid event: 400 with details', async () => {
  const res = await post({ eventId: 'e2', type: 'order.placed', payload: {} });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).details.length >= 2);
});

test('idempotency: a replayed event sends nothing', async () => {
  const evt = { eventId: 'e3', type: 'order.shipped', payload: { orderId: 'C1', userId: 'u1' } };
  assert.equal((await post(evt)).status, 202);
  assert.equal((await post(evt)).status, 200);
  assert.equal((await notifs('u1')).length, 3);
});

test('preferences: disabled channel and missing contact details are skipped', async () => {
  await post({ eventId: 'e4', type: 'order.shipped', payload: { orderId: 'C2', userId: 'u2' } });
  const byChannel = Object.fromEntries((await notifs('u2')).map((n) => [n.channel, n]));
  assert.equal(byChannel.email.status, 'sent');
  assert.equal(byChannel.sms.status, 'skipped');
  assert.equal(byChannel.push.status, 'skipped'); // u2 has no push token
});

test('promotion: fan-out to consenting viewers, throttled to 1/day', async () => {
  await post({ eventId: 'v1', type: 'product.viewed', payload: { userId: 'u1', productId: 'P1' } });
  await post({ eventId: 'v2', type: 'product.viewed', payload: { userId: 'u2', productId: 'P1' } });
  await app.system.drain();
  await post({ eventId: 'p1', type: 'promotion.started', payload: { productId: 'P1', productName: 'Headphones', discountPercent: 20 } });
  await post({ eventId: 'p2', type: 'promotion.started', payload: { productId: 'P1', productName: 'Headphones', discountPercent: 30 } });

  const u1 = await notifs('u1');
  assert.equal(u1.filter((n) => n.eventId === 'p1' && n.status === 'sent').length, 2);
  assert.equal(u1.find((n) => n.eventId === 'p2').reason, 'marketing frequency limit reached');

  const u2 = await notifs('u2');
  assert.equal(u2[0].reason, 'no marketing consent');
});

test('PUT preferences: marketing opt-in can be changed over HTTP', async () => {
  const res = await fetch(`${base}/users/u2/preferences`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ marketingOptIn: true }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).preferences.marketingOptIn, true);
});
