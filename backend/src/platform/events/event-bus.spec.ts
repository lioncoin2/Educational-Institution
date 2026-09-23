import { domainEvent } from '../../shared';
import { InProcessEventBus } from './event-bus';

const event = (name: string) => domainEvent(name, 'agg-1', { value: 1 }, new Date());

describe('InProcessEventBus', () => {
  it('delivers an event to every subscriber of that name', async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe('a.happened', () => void seen.push('first'));
    bus.subscribe('a.happened', () => void seen.push('second'));
    bus.subscribe('b.happened', () => void seen.push('other'));

    await bus.publish([event('a.happened')]);

    expect(seen).toEqual(['first', 'second']);
  });

  it('awaits asynchronous subscribers before returning', async () => {
    const bus = new InProcessEventBus();
    let finished = false;
    bus.subscribe('a.happened', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await bus.publish([event('a.happened')]);

    expect(finished).toBe(true);
  });

  // The publishing module has already committed; one bad subscriber must not
  // turn its successful work into a failure.
  it('isolates a throwing subscriber and still runs the others', async () => {
    const errors: unknown[] = [];
    const bus = new InProcessEventBus((_event, error) => void errors.push(error));
    const seen: string[] = [];
    bus.subscribe('a.happened', () => {
      throw new Error('subscriber exploded');
    });
    bus.subscribe('a.happened', () => void seen.push('still ran'));

    await expect(bus.publish([event('a.happened')])).resolves.toBeUndefined();

    expect(seen).toEqual(['still ran']);
    expect(errors).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe('a.happened', () => void seen.push('x'));

    await bus.publish([event('a.happened')]);
    unsubscribe();
    await bus.publish([event('a.happened')]);

    expect(seen).toEqual(['x']);
  });

  it('tolerates a subscriber that unsubscribes during dispatch', async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe('a.happened', () => {
      unsubscribe();
      seen.push('first');
    });
    bus.subscribe('a.happened', () => void seen.push('second'));

    await bus.publish([event('a.happened')]);

    expect(seen).toEqual(['first', 'second']);
  });
});
