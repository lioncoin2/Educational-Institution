import type {
  LogEntryView,
  ResponseTotalsView,
  StatisticsView,
  TemplateView,
} from '../../application/views';
import { iso, person, personOrNull, type PersonRef } from './wire';

export interface TemplateResponse {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly buttons: readonly string[];
  readonly reportRequired: boolean;
  readonly approvalMode: string;
  readonly audiences: readonly string[];
  readonly communityId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface LogEntryResponse {
  readonly sequence: number;
  readonly action: string;
  readonly actor: PersonRef | null;
  readonly assignmentId: string | null;
  readonly reportId: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: string;
}

/** Counts plus the two rates the dashboard shows (roadmap §12); a rate over nobody is null. */
export interface TotalsResponse extends ResponseTotalsView {
  readonly acknowledgementRate: number | null;
  readonly completionRate: number | null;
}

export interface DashboardResponse {
  readonly totals: TotalsResponse;
  readonly byAudience: readonly (TotalsResponse & { readonly audience: string })[];
  readonly byCommunity: readonly (TotalsResponse & { readonly communityId: string })[];
  readonly byPerson: readonly (TotalsResponse & { readonly person: PersonRef })[];
}

export function toTemplateResponse(template: TemplateView): TemplateResponse {
  return { ...template, createdAt: iso(template.createdAt) };
}

export function toLogEntryResponse(
  entry: LogEntryView,
  names: ReadonlyMap<string, string>,
): LogEntryResponse {
  return {
    sequence: entry.sequence,
    action: entry.action,
    actor: personOrNull(entry.actorId, names),
    assignmentId: entry.assignmentId,
    reportId: entry.reportId,
    detail: entry.detail,
    occurredAt: iso(entry.occurredAt),
  };
}

const rate = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;

export function toTotalsResponse(totals: ResponseTotalsView): TotalsResponse {
  return {
    ...totals,
    acknowledgementRate: rate(totals.responded, totals.assignments),
    completionRate: rate(totals.completed, totals.assignments),
  };
}

export function toDashboardResponse(
  view: StatisticsView & { names: ReadonlyMap<string, string> },
): DashboardResponse {
  return {
    totals: toTotalsResponse(view.totals),
    byAudience: view.byAudience.map(({ audience, ...t }) => ({ audience, ...toTotalsResponse(t) })),
    byCommunity: view.byCommunity.map(({ communityId, ...t }) => ({
      communityId,
      ...toTotalsResponse(t),
    })),
    byPerson: view.byPerson.map(({ personId, ...t }) => ({
      person: person(personId, view.names),
      ...toTotalsResponse(t),
    })),
  };
}
