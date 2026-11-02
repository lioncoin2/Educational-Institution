import type { TaskAudience } from './audience';
import type { TaskContent, TaskSettings } from './task-config';

/**
 * A saved task configuration (roadmap §10): content, audiences and settings —
 * never responses. Publishing from it creates a new, independent task.
 */
export interface TaskTemplate extends TaskContent, TaskSettings {
  readonly id: string;
  readonly audiences: readonly TaskAudience[];
  readonly communityId: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}
