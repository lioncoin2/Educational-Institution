/**
 * Assignments — tasks set to learners, and what they hand back.
 */
export type SubmissionState = 'draft' | 'submitted' | 'returned' | 'graded';

export interface AssignmentRef {
  readonly assignmentId: string;
  readonly halaqaId: string;
  readonly dueAt: Date | null;
}

export interface SubmissionRef {
  readonly submissionId: string;
  readonly assignmentId: string;
  readonly studentPersonId: string;
  readonly state: SubmissionState;
}
