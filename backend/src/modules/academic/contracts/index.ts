/**
 * Academic — the catalogue: departments, programs, levels and halaqat.
 *
 * It is the structure of what is taught. It owns no schedule and no attendance;
 * Operations does. Other modules reference these ids rather than copying names.
 */
export interface ProgramRef {
  readonly programId: string;
  readonly name: string;
}

export interface LevelRef {
  readonly levelId: string;
  readonly programId: string;
  readonly order: number;
}

export interface HalaqaRef {
  readonly halaqaId: string;
  readonly levelId: string;
  readonly teacherPersonId: string | null;
}
