import { expandParticipants } from '../core/identity';
import { getScenario } from '../scenarios/catalog';
import { MP_LIMITS, partitionParticipants, perWorker, validateMp } from '../mp/partition';

describe('MP partitioning', () => {
  it('computes participants-per-worker as a ceiling split', () => {
    expect(perWorker(20, 2)).toBe(10);
    expect(perWorker(40, 4)).toBe(10);
    expect(perWorker(41, 4)).toBe(11);
    expect(perWorker(10, 3)).toBe(4);
  });

  it('splits a plan into contiguous deterministic chunks, publisher in worker 0', () => {
    const s = getScenario('MP_SMOKE')!; // 1 pub + 19 listeners = 20, 2 workers
    const plan = expandParticipants(s);
    const chunks = partitionParticipants(plan, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    // publisher (plan[0], a speaker) is in worker 0
    expect(chunks[0]?.[0]?.role).toBe('speaker');
    // contiguous: no participant appears twice, union == plan
    const flat = chunks.flat().map((p) => p.identity);
    expect(new Set(flat).size).toBe(plan.length);
    // deterministic
    expect(partitionParticipants(plan, 2)).toEqual(chunks);
  });

  it('drops empty chunks when workers > participants', () => {
    const s = getScenario('MP_PUB')!; // 2 participants
    const plan = expandParticipants(s);
    const chunks = partitionParticipants(plan, 2);
    expect(chunks.flat()).toHaveLength(2);
  });

  it('enforces worker and per-worker caps', () => {
    expect(validateMp(20, 2)).toEqual([]);
    expect(validateMp(1000, 2).some((e) => e.includes('participants/worker'))).toBe(true);
    expect(validateMp(100, MP_LIMITS.maxWorkers + 1).some((e) => e.includes('workers'))).toBe(true);
    expect(validateMp(5, 10).some((e) => e.includes('exceeds total'))).toBe(true);
    expect(validateMp(20, 0).some((e) => e.includes('>= 1'))).toBe(true);
  });
});
