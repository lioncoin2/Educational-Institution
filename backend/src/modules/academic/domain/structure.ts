import type { Id } from '../../../shared/identifier';
import { err, failure, ok, type Result } from '../../../shared/result';
import type { StructureField } from '../contracts/events';
import { isSectionKind, type SectionKind, type StructureStatus } from '../contracts/vocabulary';
import { normalizeCode, normalizeDescription, normalizeName, validateOrder } from './text';

export type SectionId = Id<'AcademicSection'>;
export type ProgramId = Id<'AcademicProgram'>;
export type HalaqaId = Id<'AcademicHalaqa'>;

/**
 * A top-level educational area — one of the profile's sections, or an area
 * an administrator adds. It owns programs; it holds no halaqa directly.
 */
export interface Section {
  readonly id: SectionId;
  readonly code: string;
  readonly name: string;
  readonly kind: SectionKind;
  /** Display position among all sections; for PROGRESSIVE ones, their place on the ladder. */
  readonly order: number;
  readonly description: string | null;
  readonly status: StructureStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** An educational offering, in exactly one section. */
export interface Program {
  readonly id: ProgramId;
  readonly code: string;
  readonly sectionId: SectionId;
  readonly name: string;
  /** Display position within its section. */
  readonly order: number;
  readonly description: string | null;
  readonly status: StructureStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * الحلقة — the unit the institution teaches in: a specific group within one
 * program. Students are enrolled in a halaqa, and teachers assigned to one;
 * never to a program or section as such.
 */
export interface Halaqa {
  readonly id: HalaqaId;
  readonly code: string;
  readonly programId: ProgramId;
  readonly name: string;
  /** Display position within its program — not a claim that halaqat are taken in order (Q29). */
  readonly order: number;
  readonly status: StructureStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an administrator may change after creation. Codes and parents never change. */
export interface StructureChange {
  readonly name?: string;
  readonly order?: number;
  /** `null` clears it. */
  readonly description?: string | null;
}

interface Described {
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly description: string | null;
}

function described(input: {
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly description?: string | null;
}): Result<Described> {
  const code = normalizeCode(input.code);
  if (!code.ok) return code;
  const name = normalizeName(input.name);
  if (!name.ok) return name;
  const order = validateOrder(input.order);
  if (!order.ok) return order;
  const description = normalizeDescription(input.description);
  if (!description.ok) return description;
  return ok({
    code: code.value,
    name: name.value,
    order: order.value,
    description: description.value,
  });
}

/** New sections, programs and halaqat start ACTIVE. */
export function createSection(input: {
  readonly id: SectionId;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly order: number;
  readonly description?: string | null;
  readonly at: Date;
}): Result<Section> {
  if (!isSectionKind(input.kind)) {
    return err(
      failure(
        'validation',
        'academic.kind_invalid',
        'A section kind is PROGRESSIVE, SPECIAL or ACCOMPANYING.',
        { field: 'kind' },
      ),
    );
  }
  const fields = described(input);
  if (!fields.ok) return fields;
  return ok({
    id: input.id,
    kind: input.kind,
    ...fields.value,
    status: 'ACTIVE',
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function createProgram(input: {
  readonly id: ProgramId;
  readonly sectionId: SectionId;
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly description?: string | null;
  readonly at: Date;
}): Result<Program> {
  const fields = described(input);
  if (!fields.ok) return fields;
  return ok({
    id: input.id,
    sectionId: input.sectionId,
    ...fields.value,
    status: 'ACTIVE',
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function createHalaqa(input: {
  readonly id: HalaqaId;
  readonly programId: ProgramId;
  readonly code: string;
  readonly name: string;
  readonly order: number;
  readonly at: Date;
}): Result<Halaqa> {
  const fields = described({ ...input, description: null });
  if (!fields.ok) return fields;
  const { code, name, order } = fields.value;
  return ok({
    id: input.id,
    programId: input.programId,
    code,
    name,
    order,
    status: 'ACTIVE',
    createdAt: input.at,
    updatedAt: input.at,
  });
}

/**
 * When a change is stamped: `at`, unless another instance's clock runs behind
 * this entity's last write — `updatedAt` never moves backwards.
 */
export function stampedAt(entity: { readonly updatedAt: Date }, at: Date): Date {
  return at < entity.updatedAt ? entity.updatedAt : at;
}

const EMPTY_CHANGE = failure(
  'validation',
  'academic.change_empty',
  'Say what to change: name, order or description.',
);

/**
 * Applies an administrator's change to a section or program. Only fields
 * whose value actually differs are reported in `changed`; a change that
 * alters nothing leaves the entity (and its `updatedAt`) as it was.
 */
export function applyChange<T extends Section | Program>(
  entity: T,
  change: StructureChange,
  at: Date,
): Result<{ readonly entity: T; readonly changed: readonly StructureField[] }> {
  const keys = (['name', 'order', 'description'] as const).filter((key) => key in change);
  if (keys.length === 0) return err(EMPTY_CHANGE);

  let next: T = entity;
  const changed: StructureField[] = [];
  if (change.name !== undefined) {
    const name = normalizeName(change.name);
    if (!name.ok) return name;
    if (name.value !== entity.name) {
      next = { ...next, name: name.value };
      changed.push('name');
    }
  }
  if (change.order !== undefined) {
    const order = validateOrder(change.order);
    if (!order.ok) return order;
    if (order.value !== entity.order) {
      next = { ...next, order: order.value };
      changed.push('order');
    }
  }
  if ('description' in change) {
    const description = normalizeDescription(change.description);
    if (!description.ok) return description;
    if (description.value !== entity.description) {
      next = { ...next, description: description.value };
      changed.push('description');
    }
  }
  return ok({
    entity: changed.length === 0 ? entity : { ...next, updatedAt: stampedAt(entity, at) },
    changed,
  });
}

/** A halaqa has a name and a position; nothing else of it is editable. */
export function applyHalaqaChange(
  halaqa: Halaqa,
  change: Omit<StructureChange, 'description'>,
  at: Date,
): Result<{ readonly entity: Halaqa; readonly changed: readonly StructureField[] }> {
  if (change.name === undefined && change.order === undefined) {
    return err(
      failure('validation', 'academic.change_empty', 'Say what to change: name or order.'),
    );
  }
  let next = halaqa;
  const changed: StructureField[] = [];
  if (change.name !== undefined) {
    const name = normalizeName(change.name);
    if (!name.ok) return name;
    if (name.value !== halaqa.name) {
      next = { ...next, name: name.value };
      changed.push('name');
    }
  }
  if (change.order !== undefined) {
    const order = validateOrder(change.order);
    if (!order.ok) return order;
    if (order.value !== halaqa.order) {
      next = { ...next, order: order.value };
      changed.push('order');
    }
  }
  return ok({
    entity: changed.length === 0 ? halaqa : { ...next, updatedAt: stampedAt(halaqa, at) },
    changed,
  });
}

/**
 * Whether a new enrollment may be made in this halaqa: the halaqa, its
 * program and its section must all be ACTIVE. Checked from the outside in,
 * so the reason given is the root one ("the section is closed" rather than
 * "this halaqa is closed" when both are).
 *
 * Existing enrollments are unaffected by a program or section closing; a
 * halaqa, though, cannot close while it has active enrollments (see the
 * repository's `deactivateHalaqa`), so "an ACTIVE enrollment in an INACTIVE
 * halaqa" never exists.
 */
export function openForEnrollment(placement: {
  readonly section: Pick<Section, 'status'>;
  readonly program: Pick<Program, 'status'>;
  readonly halaqa: Pick<Halaqa, 'status'>;
}): Result<void> {
  if (placement.section.status !== 'ACTIVE') {
    return err(
      failure(
        'precondition_failed',
        'academic.section_inactive',
        'This section is not accepting new enrollments.',
      ),
    );
  }
  if (placement.program.status !== 'ACTIVE') {
    return err(
      failure(
        'precondition_failed',
        'academic.program_inactive',
        'This program is not accepting new enrollments.',
      ),
    );
  }
  if (placement.halaqa.status !== 'ACTIVE') {
    return err(
      failure(
        'precondition_failed',
        'academic.halaqa_inactive',
        'This halaqa is not accepting new enrollments.',
      ),
    );
  }
  return ok(undefined);
}
