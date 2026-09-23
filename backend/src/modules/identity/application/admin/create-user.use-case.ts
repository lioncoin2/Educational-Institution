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
} from '../../../../shared';
import { AUTHORIZATION_SERVICE, type AuthorizationService } from '../../contracts/authorization';
import { Permissions } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import { userCreated } from '../../domain/events';
import { normalizeIdentifier, type IdentifierKind } from '../../domain/login-identifier';
import { validateNewPassword } from '../../domain/password-policy';
import {
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type PasswordHasher,
  type UserRepository,
} from '../../domain/ports';
import { createUser } from '../../domain/user';
import { IdentityAudit, USER_RESOURCE, auditEntry } from '../audit-actions';
import { toUserAccountView, type UserAccountView } from '../views';

export interface CreateUserCommand {
  readonly actor: Principal;
  readonly displayName: string;
  readonly identifierKind: IdentifierKind;
  readonly identifier: string;
  readonly initialPassword: string;
  readonly meta: CallMetadata;
}

/**
 * Provisioning, step one: create an account. It starts PENDING, with no roles,
 * and cannot sign in until an administrator activates it.
 *
 * There is no public registration. Accounts in an institution are created by
 * staff who hold `users.manage`; whether that ever changes is Q2.
 */
@Injectable()
export class CreateUserUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateUserCommand): Promise<Result<UserAccountView>> {
    const allowed = this.authorization.authorize(command.actor, Permissions.users.manage, {
      resourceType: USER_RESOURCE,
    });
    if (!allowed.ok) return allowed;

    const identifier = normalizeIdentifier(command.identifierKind, command.identifier);
    if (!identifier.ok) return identifier;

    const policy = validateNewPassword(command.initialPassword);
    if (!policy.ok) return policy;

    const now = this.clock.now();
    const created = createUser({
      id: this.ids.next<'User'>(),
      displayName: command.displayName,
      identifier: identifier.value,
      passwordHash: await this.hasher.hash(command.initialPassword),
      at: now,
    });
    if (!created.ok) return created;
    const user = created.value;

    if ((await this.users.create(user)) === 'identifier_taken') {
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
          action: IdentityAudit.userCreated,
          actorUserId: command.actor.userId,
          resourceType: USER_RESOURCE,
          resourceId: user.id,
          at: now,
          metadata: { identifierKind: identifier.value.kind },
        },
        command.meta,
      ),
    );
    await this.events.publish([userCreated(user.id, now, command.meta.correlationId)]);

    return ok(toUserAccountView(user));
  }
}
