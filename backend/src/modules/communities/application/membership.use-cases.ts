import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { ruleFor } from '../domain/act-rules';
import { COMMUNITY_NOT_FOUND } from '../domain/authority';
import { MEMBER_HOLDS_MORE_CAPABILITIES } from '../domain/delegation';
import { memberAdded, memberRemoved } from '../domain/events';
import {
  COMMUNITY_READ_MODEL,
  COMMUNITY_STORE,
  type CommunityReadModel,
  type CommunityStore,
} from '../domain/ports';
import { COMMUNITY_CONFLICT, actingBasis, actorOf, refusalAfterBasisLost } from './community-acts';
import { CommunityAuthorizationService } from './community-authorization.service';
import { CommunityPeople } from './community-people';
import { CommunitiesJournal, authorityOf } from './communities-journal';
import {
  COMMUNITY_AUDIT_RESOURCE,
  CommunityAudit,
  CommunityPages,
  CommunityRateLimits,
  MAX_MEMBERS_PER_ADD,
  pageLimit,
} from './communities-settings';
import { decodeCursor, paged } from './cursors';
import type { AddMembersView, MemberView, PageView } from './views';

const COMMUNITY_LOCKED = failure(
  'precondition_failed',
  'communities.community_locked',
  'This community is locked.',
  { act: 'community.members.invite' },
);

const MEMBER_NOT_FOUND = failure(
  'not_found',
  'communities.member_not_found',
  'That account is not a member of this community.',
);

/**
 * A manager adds accounts directly (the owner, or a delegate holding
 * `community.members.invite` — oversight never adds, §6.11). Idempotent per account: someone already a member is
 * reported `unchanged` and nothing is written for them. Everyone named must
 * be an ACTIVE account allowed to take part in communities; an unknown id and
 * an ineligible one are refused alike, so nobody can probe for accounts.
 * Someone a manager removed may be added again this way (Q49).
 */
@Injectable()
export class AddMembersUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    private readonly people: CommunityPeople,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly userIds: readonly string[];
    readonly meta: CallMetadata;
  }): Promise<Result<{ readonly view: AddMembersView; readonly anyAdded: boolean }>> {
    const { principal, communityId } = command;
    const rule = ruleFor('community.members.invite');
    const { result } = await this.authorization.evaluate(principal, communityId, rule);
    if (!result.ok) return result;
    const permit = result.value;

    const userIds = [...new Set(command.userIds)];
    if (userIds.length === 0 || userIds.length > MAX_MEMBERS_PER_ADD) {
      return err(
        failure(
          'validation',
          'communities.members_invalid',
          `Name 1 to ${MAX_MEMBERS_PER_ADD} accounts.`,
          { max: MAX_MEMBERS_PER_ADD },
        ),
      );
    }
    const throttle = await this.limiter.consume(
      principal.userId,
      CommunityRateLimits.memberAddsPerUser,
    );
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'communities.too_many_additions',
          'Too many additions. Try again later.',
          { retryAfterSeconds: throttle.retryAfterSeconds },
        ),
      );
    }
    const eligible = await this.people.eligible(userIds, Permissions.communities.read);
    const ineligible = userIds.filter((userId) => !eligible.has(userId));
    if (ineligible.length > 0) {
      return err(
        failure(
          'validation',
          'communities.members_not_eligible',
          'Some of these accounts cannot be added to a community.',
          { userIds: ineligible },
        ),
      );
    }

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.addMembers({
      communityId,
      userIds,
      actor: actingBasis(permit),
      addedBy: actor,
      at,
      newId: () => this.ids.next<'CommunityMembership'>(),
    });
    switch (outcome.kind) {
      case 'added':
        for (const stint of outcome.added) {
          await this.journal.record(
            {
              actorUserId: actor,
              action: CommunityAudit.memberAdded,
              resourceType: COMMUNITY_AUDIT_RESOURCE,
              resourceId: communityId,
              at,
              metadata: {
                userId: stint.userId,
                membershipId: stint.id,
                membershipVersion: stint.version,
                authority: authorityOf(permit),
              },
              correlationId: command.meta.correlationId,
            },
            [memberAdded(stint, command.meta.correlationId)],
          );
        }
        return ok({
          view: {
            added: outcome.added.map((stint) => stint.userId),
            unchanged: outcome.unchanged,
          },
          anyAdded: outcome.added.length > 0,
        });
      case 'locked':
        return err(COMMUNITY_LOCKED);
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'basis_lost':
        return err(await refusalAfterBasisLost(this.authorization, principal, communityId, rule));
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/**
 * A manager removes a member: the owner, a delegate holding
 * `community.members.remove`, or oversight. Allowed while LOCKED. The owner
 * is never removed, and a delegate never removes someone holding a
 * capability the delegate does not effectively hold (R6, decided under
 * lock). The member's grants end with the stint. Only the removed person is
 * told (P5); nothing else is announced to members (Q49).
 */
@Injectable()
export class RemoveMemberUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly userId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const { principal, communityId } = command;
    const rule = ruleFor('community.members.remove');
    const { result } = await this.authorization.evaluate(principal, communityId, rule);
    if (!result.ok) return result;
    const permit = result.value;

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.removeMember({
      communityId,
      userId: command.userId,
      actor: actingBasis(permit),
      removerCeilings: this.authorization.capabilitiesWithinCeiling(principal, communityId),
      removedBy: actor,
      at,
    });
    switch (outcome.kind) {
      case 'removed':
        await this.journal.record(
          {
            actorUserId: actor,
            action: CommunityAudit.memberRemoved,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: {
              userId: outcome.stint.userId,
              membershipId: outcome.stint.id,
              membershipVersion: outcome.stint.version,
              endedGrantIds: outcome.endedGrants.map((grant) => grant.id),
              authority: authorityOf(permit),
            },
            correlationId: command.meta.correlationId,
          },
          [memberRemoved(outcome.stint, command.meta.correlationId)],
        );
        return ok(undefined);
      case 'not_member':
        return err(MEMBER_NOT_FOUND);
      case 'holds_more':
        return err(MEMBER_HOLDS_MORE_CAPABILITIES);
      case 'owner':
        return err(
          failure(
            'precondition_failed',
            'communities.owner_not_removable',
            'The owner of a community cannot be removed from it.',
          ),
        );
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'basis_lost':
        return err(await refusalAfterBasisLost(this.authorization, principal, communityId, rule));
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/**
 * A member leaves (Q49). The owner cannot (Q42): ownership must be handed
 * over first. Someone who is not a member — an overseer included — has
 * nothing to leave, and is told what a non-member is always told.
 */
@Injectable()
export class LeaveCommunityUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const { principal, communityId } = command;
    const { result } = await this.authorization.evaluate(
      principal,
      communityId,
      ruleFor('community.view'),
    );
    if (!result.ok) return result;
    const permit = result.value;
    if (permit.basis !== 'membership') return err(COMMUNITY_NOT_FOUND);

    const at = this.clock.now();
    const outcome = await this.store.leave({ communityId, userId: principal.userId, at });
    switch (outcome.kind) {
      case 'left':
        await this.journal.record(
          {
            actorUserId: principal.userId,
            action: CommunityAudit.memberLeft,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: {
              membershipId: outcome.stint.id,
              membershipVersion: outcome.stint.version,
              endedGrantIds: outcome.endedGrants.map((grant) => grant.id),
              authority: authorityOf(permit),
            },
            correlationId: command.meta.correlationId,
          },
          [memberRemoved(outcome.stint, command.meta.correlationId)],
        );
        return ok(undefined);
      case 'owner':
        return err(
          failure(
            'precondition_failed',
            'communities.owner_cannot_leave',
            'The owner cannot leave a community; ownership must be handed over first.',
          ),
        );
      case 'not_member':
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/**
 * The roster, a page at a time (Q22): the owner, a delegate holding
 * `community.members.view`, or an overseer (whose read is audited). Display names from identity, one call per page —
 * never an email, never how or by whom someone joined.
 */
@Injectable()
export class ListMembersUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    private readonly people: CommunityPeople,
    @Inject(COMMUNITY_READ_MODEL) private readonly readModel: CommunityReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly meta: CallMetadata;
  }): Promise<Result<PageView<MemberView>>> {
    const { principal, communityId } = command;
    const { result } = await this.authorization.evaluate(
      principal,
      communityId,
      ruleFor('community.members.view'),
    );
    if (!result.ok) return result;
    const cursor = decodeCursor(command.cursor);
    if (!cursor.ok) return cursor;
    const limit = pageLimit(command.limit, CommunityPages.roster);

    const rows = await this.readModel.roster(communityId, {
      after: cursor.value,
      limit: limit + 1,
    });
    const page = paged(rows, limit, (stint) => ({ at: stint.joinedAt, id: stint.userId }));
    const people = await this.people.describe(page.items.map((stint) => stint.userId));
    if (result.value.basis === 'oversight') {
      await this.journal.oversightRead({
        actorUserId: actorOf(principal),
        communityId,
        act: 'community.members.view',
        at: this.clock.now(),
        correlationId: command.meta.correlationId,
      });
    }
    return ok({
      items: page.items.map((stint) => {
        const person = people.get(stint.userId);
        return {
          userId: stint.userId,
          displayName: person?.displayName ?? null,
          active: person?.active ?? false,
          joinedAt: stint.joinedAt,
        };
      }),
      nextCursor: page.nextCursor,
    });
  }
}
