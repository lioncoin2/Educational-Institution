import type { TasksPorts } from './tasks-harness';
import { describePublishing } from './tasks-suite-publishing';
import { describeReportsAndDashboard } from './tasks-suite-reports';
import { describeWorkflow } from './tasks-suite-workflow';

/**
 * The tasks engine's behaviour, run against one adapter's ports. The same suite
 * runs on the in-memory twins (unit) and on Postgres (integration), which is
 * what holds the two to the same guarantees — the archive rule included.
 */
export function describeTasksContract(label: string, makePorts: () => Promise<TasksPorts>): void {
  describe(`tasks engine (${label})`, () => {
    describe('publishing and authorization', () => describePublishing(makePorts));
    describe('the workflow', () => describeWorkflow(makePorts));
    describe('reports, templates and the dashboard', () => describeReportsAndDashboard(makePorts));
  });
}
