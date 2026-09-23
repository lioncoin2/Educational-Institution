/**
 * An in-process async mutex per key — admission, not correctness (§4, §9).
 *
 * A storm of joins into one community queues on its community row in
 * Postgres; without admission control every waiter would hold one of the
 * pool's ten connections while it waits, starving unrelated routes. Taken
 * before a connection is checked out and before any database lock, so the
 * storm queues here, in memory, holding at most one connection per community
 * per process. It closes no cycle with the database's lock order: a waiter
 * holds nothing while it waits, and each transaction takes one key. The
 * database still decides every invariant.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.tails.set(key, tail);
    try {
      await previous;
      return await work();
    } finally {
      release();
      // The last in line cleans up, so idle keys hold no memory.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with someone holding or waiting — for tests and metrics. */
  get size(): number {
    return this.tails.size;
  }
}
