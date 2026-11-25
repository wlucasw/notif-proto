// In-memory message queue with asynchronous consumers.
// Stands in for a broker (SQS, RabbitMQ, Kafka): the HTTP API publishes and returns
// immediately (202), processing happens in the background.

export class Queue {
  constructor(name, handler, { concurrency = 4 } = {}) {
    this.name = name;
    this.handler = handler;
    this.concurrency = concurrency;
    this.items = [];
    this.running = 0;
    this.idleWaiters = [];
  }

  publish(message, { delayMs = 0 } = {}) {
    if (delayMs > 0) {
      this.running++; // a delayed message counts as "in progress" for drain()
      setTimeout(() => {
        this.running--;
        this.items.push(message);
        this.#pump();
      }, delayMs);
      return;
    }
    this.items.push(message);
    this.#pump();
  }

  #pump() {
    while (this.running < this.concurrency && this.items.length) {
      const msg = this.items.shift();
      this.running++;
      Promise.resolve()
        .then(() => this.handler(msg))
        .catch((err) => console.error(`[${this.name}] unhandled error`, err))
        .finally(() => {
          this.running--;
          this.#pump();
          this.#checkIdle();
        });
    }
    this.#checkIdle();
  }

  #checkIdle() {
    if (this.running === 0 && this.items.length === 0) {
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  get size() {
    return this.items.length + this.running;
  }

  // Waits until the queue is empty (useful for tests)
  drain() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
