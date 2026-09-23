import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from '../../../shared';
import { AccountStatuses } from '../domain/account-status';
import { roleAssigned, userCreated } from '../domain/events';
import { normalizeIdentifier, type IdentifierKind } from '../domain/login-identifier';
import { validateNewPassword } from '../domain/password-policy';
import {
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type PasswordHasher,
  type UserRepository,
} from '../domain/ports';
import { Roles } from '../domain/role';
import { assignRole, changeStatus, createUser } from '../domain/user';
import { IdentityAudit, USER_RESOURCE, auditEntry } from './audit-actions';
import { toUserAccountView, type UserAccountView } from './views';

export interface BootstrapOwnerCommand {
  readonly displayName: string;
  readonly identifierKind: IdentifierKind;
  readonly identifier: string;
  readonly password: string;
  readonly meta: CallMetadata;
}

/**
 * Creates the first OWNER — the one account that cannot be provisioned by
 * another account, because none exists yet.
 *
 * It refuses to run while any ACTIVE owner exists, so it is a way in only for
 * an empty system (or one that has lost every owner and is being recovered by
 * someone with shell access to the server — who could equally edit the
 * database directly). It has no HTTP route: it is invoked from the command
 * line, by an operator, with credentials supplied at that moment.
 *
 * This is what stands in for a seeded owner password, of which there is none.
 */
@Injectable()
export class BootstrapOwnerUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: BootstrapOwnerCommand): Promise<Result<UserAccountView>> {
    if (await this.users.anyActiveWithRole(Roles.owner)) {
      return err(
        failure(
          'conflict',
          'identity.owner_exists',
          'An active owner already exists. Further accounts are created by staff.',
        ),
      );
    }

    const identifier = normalizeIdentifier(command.identifierKind, command.identifier);
    if (!identifier.ok) return identifier;
    const policy = validateNewPassword(command.password);
    if (!policy.ok) return policy;

    const now = this.clock.now();
    const created = createUser({
      id: this.ids.next<'User'>(),
      displayName: command.displayName,
      identifier: identifier.value,
      passwordHash: await this.hasher.hash(command.password),
      at: now,
    });
    if (!created.ok) return created;

    const withRole = assignRole(created.value, Roles.owner, null, now);
    if (!withRole.ok) return withRole;
    const owner = changeStatus(withRole.value, AccountStatuses.active, now);
    if (!owner.ok) return owner;

    if ((await this.users.create(owner.value)) === 'identifier_taken') {
      return err(
        failure(
          'conflict',
          'identity.identifier_taken',
          'An account with this identifier already exists.',
        ),
      );
    }

    await this.audit.record(
      auditEntry(
        {
          action: IdentityAudit.ownerBootstrapped,
          actorUserId: null,
          resourceType: USER_RESOURCE,
          resourceId: owner.value.id,
          at: now,
        },
        command.meta,
      ),
    );
    await this.events.publish([
      userCreated(owner.value.id, now, command.meta.correlationId),
      roleAssigned(owner.value.id, Roles.owner, null, now, command.meta.correlationId),
    ]);
    return ok(toUserAccountView(owner.value));
  }
}
