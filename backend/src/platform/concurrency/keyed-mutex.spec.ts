import { KeyedMutex } from './keyed-mutex';

/** A promise the test resolves when it chooses. */
function gate(): { readonly promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets every pending continuation run: a macrotask comes after all microtasks. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('KeyedMutex', () => {
  it('runs the work under one key strictly in order, each after the last has settled', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const first = gate();
    const a = mutex.run('k', async () => {
      log.push('a:start');
      await first.promise;
      log.push('a:end');
      return 'a';
    });
    const b = mutex.run('k', async () => {
      log.push('b:start');
      await settle();
      log.push('b:end');
      return 'b';
    });
    const c = mutex.run('k', async () => {
      log.push('c:start');
      return 'c';
    });

    await settle();
    // b and c wait while a holds the key, however long it holds it.
    expect(log).toEqual(['a:start']);

    first.open();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start']);
  });

  it('makes a newcomer wait for whoever holds the key now, a waiter that took it over included', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const first = gate();
    const second = gate();
    const a = mutex.run('k', async () => {
      await first.promise;
      log.push('a');
    });
    const b = mutex.run('k', async () => {
      log.push('b:start');
      await second.promise;
      log.push('b:end');
    });

    first.open();
    await settle();
    // a is done, and b, which queued behind it, holds the key now. a's
    // clean-up must leave the key alone, or the next caller would not wait.
    expect(log).toEqual(['a', 'b:start']);
    expect(mutex.size).toBe(1);

    const c = mutex.run('k', async () => {
      log.push('c');
    });
    await settle();
    expect(log).toEqual(['a', 'b:start']);

    second.open();
    await Promise.all([a, b, c]);
    expect(log).toEqual(['a', 'b:start', 'b:end', 'c']);
    expect(mutex.size).toBe(0);
  });

  it('never makes one key wait for another', async () => {
    const mutex = new KeyedMutex();
    const held = gate();
    const slow = mutex.run('community-a', () => held.promise);
    let ran = false;
    const other = mutex.run('community-b', async () => {
      ran = true;
    });

    await settle();
    expect(ran).toBe(true);
    await other;

    held.open();
    await slow;
  });

  it('releases the key when the work fails — the failure reaches its caller, the next in line runs', async () => {
    const mutex = new KeyedMutex();
    const rejected = mutex.run('k', async () => {
      throw new Error('write failed');
    });
    const thrown = mutex.run('k', (): Promise<never> => {
      throw new Error('failed before any promise existed');
    });
    const next = mutex.run('k', async () => 'next');

    await expect(rejected).rejects.toThrow('write failed');
    await expect(thrown).rejects.toThrow('failed before any promise existed');
    await expect(next).resolves.toBe('next');
    expect(mutex.size).toBe(0);
  });

  it('cleans up idle keys: nothing is held once the work under them is done', async () => {
    const mutex = new KeyedMutex();
    const held = gate();
    const runs = [
      mutex.run('a', () => held.promise),
      mutex.run('a', async () => undefined),
      mutex.run('b', async () => undefined),
    ];
    // A key counts from the moment someone holds or waits for it.
    expect(mutex.size).toBe(2);

    await settle();
    // b is done and gone; a is still held, with one waiting behind it.
    expect(mutex.size).toBe(1);

    held.open();
    await Promise.all(runs);
    expect(mutex.size).toBe(0);

    await Promise.all(Array.from({ length: 100 }, (_, i) => mutex.run(`key-${i}`, async () => i)));
    expect(mutex.size).toBe(0);
  });
});
