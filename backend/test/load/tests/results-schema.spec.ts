import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type HostSample } from '../observe/sample';
import { type RungResult, validateResult } from '../results/schema';
import { writeRungEvidence } from '../results/writer';
import { genSample, result, sample, without } from './support/result-fixtures';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// results/schema.ts
// ---------------------------------------------------------------------------

describe('results/schema — validateResult', () => {
  it('accepts a complete result; null is a value (unknown), not a missing field', () => {
    expect(validateResult(result())).toEqual([]);
    const r = result();
    expect(validateResult({ ...r, network: { ...r.network, udpErrors: null } })).toEqual([]);
  });

  it('refuses anything that is not an object', () => {
    for (const r of [null, undefined, 'p84-rung-result/v1', 42, true])
      expect(validateResult(r)).toEqual(['result is not an object']);
  });

  it('checks the schema string exactly', () => {
    expect(validateResult({ ...result(), schema: 'p84-rung-result/v2' })).toEqual([
      'schema must be p84-rung-result/v1',
    ]);
    expect(validateResult(without(result(), 'schema'))).toEqual([
      'schema must be p84-rung-result/v1',
    ]);
  });

  it('reports every missing required path by name', () => {
    let r: unknown = result();
    for (const path of ['meta.runId', 'network.udpRcvbufErrors', 'cleanup.cleanupRows'])
      r = without(r, path);
    expect(validateResult(r)).toEqual([
      'missing meta.runId',
      'missing network.udpRcvbufErrors',
      'missing cleanup.cleanupRows',
    ]);
  });

  it('a missing or non-object section reports each required path under it', () => {
    expect(validateResult(without(result(), 'gate'))).toEqual([
      'missing gate.connected',
      'missing gate.failed',
      'missing gate.publisherPublished',
    ]);
    expect(validateResult({ ...result(), meta: 'S2' })).toEqual([
      'missing meta.runId',
      'missing meta.rung',
      'missing meta.requested',
    ]);
  });

  it('an empty object fails the schema and every requirement-list field (§11 names)', () => {
    const problems = validateResult({});
    expect(problems[0]).toBe('schema must be p84-rung-result/v1');
    expect(problems.slice(1).every((p) => p.startsWith('missing '))).toBe(true);
    expect(problems).toEqual(
      expect.arrayContaining([
        'missing timing.rampDuration',
        'missing timing.connectionDuration',
        'missing network.udpRcvbufErrors',
        'missing cleanup.cleanupRows',
        'missing cleanup.teardown',
        'missing verdict.class',
        'missing validity',
        'missing watchdog',
        'missing evidence',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// results/writer.ts
// ---------------------------------------------------------------------------

describe('results/writer — writeRungEvidence', () => {
  let root = '';
  let dir = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'p84-writer-spec-'));
    dir = join(root, 'runs', 'run-p84');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Files in `dir`, or [] when it does not exist. */
  const filesIn = async (d: string): Promise<string[]> =>
    readdir(d).then(
      (entries) => entries.sort(),
      () => [],
    );

  const SAMPLES = (): Record<string, HostSample[]> => ({
    sut: [sample({ seq: 1, t: 0 }), sample({ seq: 2, t: 5_000, load1: 2 })],
    'gen-1': [genSample({ seq: 1, t: 100 })],
  });

  it('writes one NDJSON file per host (one sample per line) and the result, in a private dir', async () => {
    const samples = SAMPLES();
    const out = await writeRungEvidence(dir, result(), samples);
    expect(out).toBe(join(dir, 'result-S2-run-p84.json'));
    expect(await filesIn(dir)).toEqual([
      'result-S2-run-p84.json',
      'samples-gen-1.ndjson',
      'samples-sut.ndjson',
    ]);
    for (const [host, series] of Object.entries(samples)) {
      const text = await readFile(join(dir, `samples-${host}.ndjson`), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.trimEnd().split('\n')).toHaveLength(series.length);
      expect(
        text
          .trimEnd()
          .split('\n')
          .map((l) => JSON.parse(l) as unknown),
      ).toEqual(series);
    }
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('records a SHA-256 for every evidence file that matches its contents (extra files first)', async () => {
    const events = join(root, 'events.csv');
    await writeFile(events, 'at,type\n1,connected\n', 'utf8');
    const stale = { ...result(), evidence: [{ path: 'stale', sha256: '0'.repeat(64) }] };
    const out = await writeRungEvidence(dir, stale, SAMPLES(), [events]);
    const written = JSON.parse(await readFile(out, 'utf8')) as RungResult;

    expect(written.evidence.map((e) => e.path)).toEqual([
      events,
      join(dir, 'samples-sut.ndjson'),
      join(dir, 'samples-gen-1.ndjson'),
    ]);
    for (const e of written.evidence) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.sha256).toBe(sha256(await readFile(e.path)));
    }
    expect(written).toEqual({ ...result(), evidence: written.evidence });
    expect(validateResult(written)).toEqual([]);
  });

  it('sanitises host names into file names inside the run directory', async () => {
    await writeRungEvidence(dir, result(), { 'gen/../1:a b': [genSample()] });
    expect(await filesIn(dir)).toContain('samples-gen_.._1_a_b.ndjson');
    expect(await filesIn(join(root, 'runs'))).toEqual(['run-p84']);
  });

  it('refuses an invalid result and writes no result file', async () => {
    const bad = { ...result(), schema: 'p84-rung-result/v0' } as unknown as RungResult;
    await expect(writeRungEvidence(dir, bad, SAMPLES())).rejects.toThrow(
      'refusing to write an invalid result: schema must be p84-rung-result/v1',
    );
    expect(await filesIn(dir)).not.toContain('result-S2-run-p84.json');
  });

  it('refuses an invalid result and writes NOTHING (no orphan sample evidence)', async () => {
    // Regression: the sample NDJSON files were once written before the result was validated.
    const bad = without(result(), 'network.udpErrors') as RungResult;
    await expect(writeRungEvidence(dir, bad, SAMPLES())).rejects.toThrow(
      'missing network.udpErrors',
    );
    expect(await filesIn(dir)).toEqual([]);
  });
});
