// Channel adapters. Common interface: resolveAddress(user) + send(address, message).
// In production: SendGrid/SES (email), Twilio/Vonage (SMS), FCM/APNs (push).
// Here they are simulations that log the send.

export class ChannelError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function makeAdapter(name, resolveAddress, { shouldFail = () => false, log = true } = {}) {
  return {
    name,
    resolveAddress,
    async send(address, message) {
      await new Promise((r) => setTimeout(r, 5)); // simulated latency
      if (shouldFail(address)) {
        throw new ChannelError(`${name}: provider unavailable for ${address}`);
      }
      if (log) console.log(`[${name.toUpperCase()}] -> ${address} | ${message.subject}`);
      return { providerMessageId: `${name}-${Math.random().toString(36).slice(2, 10)}` };
    },
  };
}

export function createChannels({ log = true } = {}) {
  return {
    email: makeAdapter('email', (u) => u.email, {
      log,
      shouldFail: (addr) => addr.startsWith('fail@'),
    }),
    sms: makeAdapter('sms', (u) => u.phone, { log }),
    push: makeAdapter('push', (u) => (u.pushTokens?.length ? u.pushTokens.join(',') : null), { log }),
  };
}
