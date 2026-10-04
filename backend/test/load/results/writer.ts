/**
 * P8.4 — writes a rung's machine-readable evidence (design §10, §11) into one
 * run directory: every host's samples as NDJSON (`p84-sample/v1`), the result
 * (`p84-rung-result/v1`) and a SHA-256 for every evidence file. Refuses to
 * write a result the schema validator rejects.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type HostSample } from '../observe/sample';
import { type RungResult, validateResult } from './schema';

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** Writes samples + result under `dir`; returns the result file path. */
export async function writeRungEvidence(
  dir: string,
  result: RungResult,
  samples: Readonly<Record<string, readonly HostSample[]>>,
  extraFiles: readonly string[] = [],
): Promise<string> {
  // Validate first: an invalid result writes nothing at all.
  const problems = validateResult({ ...result, evidence: [] });
  if (problems.length > 0)
    throw new Error(`refusing to write an invalid result: ${problems.join('; ')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files: string[] = [...extraFiles];
  for (const [host, series] of Object.entries(samples)) {
    const path = join(dir, `samples-${host.replace(/[^A-Za-z0-9_.-]/g, '_')}.ndjson`);
    await writeFile(path, series.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
    files.push(path);
  }
  const evidence = await Promise.all(
    files.map(async (path) => ({ path, sha256: await sha256(path) })),
  );
  const final: RungResult = { ...result, evidence };
  const out = join(dir, `result-${result.meta.rung}-${result.meta.runId}.json`);
  await writeFile(out, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
  return out;
}
