import type { Report, ReportReview, ReportVersion } from '../../domain/report';
import type { Task } from '../../domain/task';

/** One report in full, for the administration: every version and decision. */
export interface ReportDetail {
  readonly report: Report;
  readonly task: Task;
  readonly versions: readonly ReportVersion[];
  readonly reviews: readonly ReportReview[];
  readonly names: ReadonlyMap<string, string>;
}
