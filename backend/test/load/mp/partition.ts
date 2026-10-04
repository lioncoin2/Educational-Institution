/**
 * P8.3.5 — deterministic participant partitioning across workers. Contiguous
 * blocks keep the plan order (publishers first) intact, so the publisher (plan
 * index 0) always lands in worker 0, and every worker owns a bounded,
 * reproducible slice. Pure.
 */
import { type ParticipantPlan } from '../core/identity';

export interface MpLimits {
  readonly maxWorkers: number;
  readonly maxParticipantsPerWorker: number;
}

export const MP_LIMITS: MpLimits = {
  maxWorkers: 64,
  maxParticipantsPerWorker: 50,
};

/** participants-per-worker for `total` across `workers` (ceiling split). */
export function perWorker(total: number, workers: number): number {
  return Math.ceil(total / Math.max(1, workers));
}

/** Splits the plan into `workers` contiguous chunks (empties dropped). Deterministic. */
export function partitionParticipants(
  plan: readonly ParticipantPlan[],
  workers: number,
): ParticipantPlan[][] {
  const size = perWorker(plan.length, workers);
  const out: ParticipantPlan[][] = [];
  for (let w = 0; w < workers; w += 1) {
    const chunk = plan.slice(w * size, (w + 1) * size);
    if (chunk.length > 0) out.push([...chunk]);
  }
  return out;
}

/** Safety/well-formedness for a multi-process run. Empty = ok. */
export function validateMp(total: number, workers: number, limits: MpLimits = MP_LIMITS): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(workers) || workers < 1) errs.push('workers must be a whole number >= 1');
  if (workers > limits.maxWorkers) errs.push(`workers ${workers} exceeds cap ${limits.maxWorkers}`);
  const per = perWorker(total, workers);
  if (per > limits.maxParticipantsPerWorker)
    errs.push(
      `participants/worker ${per} exceeds cap ${limits.maxParticipantsPerWorker} (raise workers)`,
    );
  if (workers > total && total > 0)
    errs.push(`workers ${workers} exceeds total participants ${total}`);
  return errs;
}
