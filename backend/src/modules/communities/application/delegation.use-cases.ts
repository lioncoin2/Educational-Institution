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
import type { Permission } from '../../identity/contracts/permissions';
import {
  COMMUNITY_CAPABILITIES,
  isCommunityCapability,
  type CommunityCapability,
} from '../contracts/capabilities';
import { MANAGE_GRANTS, TRANSFER_OWNERSHIP, ruleFor } from '../domain/act-rules';
import { COMMUNITY_NOT_FOUND } from '../domain/authority';
import { GRANTEE_INELIGIBLE, ceilingOf, mayTransfer } from '../domain/delegation';
import { capabilityGranted, capabilityRevoked, ownershipTransferred } from '../domain/events';
import type { CapabilityGrant } from '../domain/grant';
import {
  COMMUNITY_READ_MODEL,
  COMMUNITY_STORE,
  type CommunityReadModel,
  type CommunityStore,
} from '../domain/ports';
import {
  COMMUNITY_CONFLICT,
  actorOf,
  ownerActingBasis,
  ownerBasis,
  ownerRefusalAfterBasisLost,
} from './community-acts';
import { CommunityAuthorizationService, type OwnerPermit } from './community-authorization.service';
import { CommunityPeople } from './community-people';
import { CommunitiesJournal, ownerAuthorityOf } from './communities-journal';
import {
  COMMUNITY_AUDIT_RESOURCE,
  CommunityAudit,
  CommunityPages,
  CommunityRateLimits,
  pageLimit,
} from './communities-settings';
import { decodeGrantCursor, encodeGrantCursor } from './cursors';
import {
  communityView,
  grantView,
  type CommunityView,
  type GrantCapabilitiesView,
  type GrantView,
  type PageView,
} from './views';

const CAPABILITIES_INVALID = failure(
  'validation',
  'communities.capabilities_invalid',
  `Name 1 to ${COMMUNITY_CAPABILITIES.length} different capabilities.`,
  { max: COMMUNITY_CAPABILITIES.length },
);

const GRANT_NOT_FOUND = failure(
  'not_found',
  'communities.grant_not_found',
  'No such grant in this community.',
);

const OWNER_INELIGIBLE = failure(
  'validation',
  'communities.owner_ineligible',
  'That account cannot own this community.',
);

const OWNER_SELF_ASSIGNMENT = failure(
  'forbidden',
  'communities.owner_self_assignment',
  'Oversight cannot make its own holder the owner of a community.',
);

const OWNER_CONFLICT = failure(
  'conflict',
  'communities.owner_conflict',
  'Ownership of this community changed while this request waited. Nothing was changed.',
);

/**
 * The owner gives a member capabilities (S4) — the whole batch or nothing.
 *
 *   R2  the owner holds every capability's ceiling — asked of identity in
 *       memory, before anything is read (403 `identity.permission_denied`)
 *   R1  the caller is the owner (404 for a non-member, 403
 *       `communities.not_community_owner` for a member)
 *   R3  the grantee is an ACTIVE account holding every ceiling permission —
 *       asked only after R1, so nobody but the owner can probe accounts —
 *       and, under lock, an ACTIVE member who is not the owner (422
 *       `communities.grantee_ineligible` alike for every miss)
 *   R7  a capability already held is reported `unchanged`, written nothing
 *
 * One audit entry and one event per grant created; a repeat records nothing.
 * Only the holder hears of it (P5); nothing is announced to members (Q45).
 */
@Injectable()
export class GrantCapabilitiesUseCase {
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
    readonly userId: string;
    readonly capabilities: readonly string[];
    readonly meta: CallMetadata;
  }): Promise<Result<{ readonly view: GrantCapabilitiesView; readonly anyCreated: boolean }>> {
    const { principal, communityId } = command;
    const requested = [...new Set(command.capabilities)];
    if (
      requested.length === 0 ||
      requested.length > COMMUNITY_CAPABILITIES.length ||
      !requested.every(isCommunityCapability)
    ) {
      return err(CAPABILITIES_INVALID);
    }
    const capabilities: readonly CommunityCapability[] = requested;

    // R2 — no escalation. In memory: nothing is read without it.
    for (const capability of capabilities) {
      const refusal = this.authorization.ceilingRefusal(
        principal,
        communityId,
        ruleFor(capability),
      );
      if (refusal !== null) return err(refusal);
    }
    // R1 — the owner alone grants.
    const { result } = await this.authorization.evaluateOwner(
      principal,
      communityId,
      MANAGE_GRANTS,
    );
    if (!result.ok) return result;
    const permit = result.value;

    const throttle = await this.limiter.consume(
      principal.userId,
      CommunityRateLimits.grantsPerUser,
    );
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'communities.too_many_grants',
          'Too many grants. Try again later.',
          {
            retryAfterSeconds: throttle.retryAfterSeconds,
          },
        ),
      );
    }
    // R3's account half: every permission of every requested capability's ceiling.
    const grantee = command.userId;
    if (grantee === principal.userId) return err(GRANTEE_INELIGIBLE);
    for (const permission of new Set(capabilities.flatMap(ceilingOf))) {
      const holding = await this.people.eligible([grantee], permission);
      if (!holding.has(grantee)) return err(GRANTEE_INELIGIBLE);
    }

    const at = this.clock.now();
    const outcome = await this.store.grant({
      communityId,
      owner: ownerBasis(permit),
      granteeUserId: grantee,
      capabilities,
      at,
      newId: () => this.ids.next<'CommunityGrant'>(),
    });
    switch (outcome.kind) {
      case 'granted':
        for (const grant of outcome.created) {
          await this.journal.record(
            {
              actorUserId: principal.userId,
              action: CommunityAudit.capabilityGranted,
              resourceType: COMMUNITY_AUDIT_RESOURCE,
              resourceId: communityId,
              at,
              metadata: {
                grantId: grant.id,
                membershipId: grant.membershipId,
                userId: grant.userId,
                capability: grant.capability,
                authority: ownerAuthorityOf(permit),
              },
              correlationId: command.meta.correlationId,
            },
            [capabilityGranted(grant, command.meta.correlationId)],
          );
        }
        // The grantee's ceiling was confirmed a moment ago: nothing here is dormant.
        return ok({
          view: {
            created: outcome.created.map((grant) => grantView(grant, false)),
            unchanged: outcome.unchanged.map((grant) => grantView(grant, false)),
          },
          anyCreated: outcome.created.length > 0,
        });
      case 'grantee_ineligible':
        return err(GRANTEE_INELIGIBLE);
      case 'basis_lost':
        return err(
          await ownerRefusalAfterBasisLost(
            this.authorization,
            principal,
            communityId,
            MANAGE_GRANTS,
          ),
        );
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/**
 * The owner takes a grant back — at once, and linearized with every act
 * resting on it: an act either committed first, or finds its basis gone.
 * Idempotent: a grant already ended answers the same, recording nothing. A
 * grant id from another community is not found — the community is
 * authorized first, so a grant id is never an enumeration surface.
 */
@Injectable()
export class RevokeGrantUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly grantId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const { principal, communityId } = command;
    const { result } = await this.authorization.evaluateOwner(
      principal,
      communityId,
      MANAGE_GRANTS,
    );
    if (!result.ok) return result;
    const permit = result.value;

    const at = this.clock.now();
    const outcome = await this.store.revokeGrant({
      communityId,
      grantId: command.grantId,
      owner: ownerBasis(permit),
      at,
    });
    switch (outcome.kind) {
      case 'revoked':
        await this.journal.record(
          {
            actorUserId: principal.userId,
            action: CommunityAudit.capabilityRevoked,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: {
              grantId: outcome.grant.id,
              membershipId: outcome.grant.membershipId,
              userId: outcome.grant.userId,
              capability: outcome.grant.capability,
              authority: ownerAuthorityOf(permit),
            },
            correlationId: command.meta.correlationId,
          },
          [capabilityRevoked(outcome.grant, command.meta.correlationId)],
        );
        return ok(undefined);
      case 'unchanged':
        return ok(undefined);
      case 'not_found':
        return err(GRANT_NOT_FOUND);
      case 'basis_lost':
        return err(
          await ownerRefusalAfterBasisLost(
            this.authorization,
            principal,
            communityId,
            MANAGE_GRANTS,
          ),
        );
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/**
 * A community's ACTIVE grants, by capability then holder (Q45, PROVISIONAL):
 * the owner sees every grant, each marked dormant or not; any other member
 * sees only their own. Overseers and non-members hear what anyone hears
 * about a community that does not exist. Dormancy is asked of identity one
 * permission at a time for the whole page, never per row.
 */
@Injectable()
export class ListGrantsUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    private readonly people: CommunityPeople,
    @Inject(COMMUNITY_READ_MODEL) private readonly readModel: CommunityReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly userId?: string;
    readonly capability?: CommunityCapability;
    readonly cursor?: string;
    readonly limit?: number;
    readonly meta: CallMetadata;
  }): Promise<Result<PageView<GrantView>>> {
    const { principal, communityId } = command;
    const { result, read } = await this.authorization.evaluate(
      principal,
      communityId,
      ruleFor('community.view'),
    );
    if (!result.ok) return result;
    if (result.value.basis !== 'membership' || read === null) return err(COMMUNITY_NOT_FOUND);
    const cursor = decodeGrantCursor(command.cursor);
    if (!cursor.ok) return cursor;
    const limit = pageLimit(command.limit, CommunityPages.grants);

    const seesAll = this.authorization.decideOwner(principal, communityId, MANAGE_GRANTS, read).ok;
    if (!seesAll && command.userId !== undefined && command.userId !== principal.userId) {
      return ok({ items: [], nextCursor: null });
    }
    const rows = await this.readModel.grants(communityId, {
      userId: seesAll ? command.userId : principal.userId,
      capability: command.capability,
      after: cursor.value,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const dormant = await this.dormancy(items);
    return ok({
      items: items.map((grant) => grantView(grant, dormant(grant))),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeGrantCursor({ capability: last.capability, userId: last.userId })
          : null,
    });
  }

  /** R4: a grant is dormant while its holder lacks any permission of the capability's ceiling. */
  private async dormancy(
    grants: readonly CapabilityGrant[],
  ): Promise<(grant: CapabilityGrant) => boolean> {
    const holders = [...new Set(grants.map((grant) => grant.userId))];
    const holding = new Map<Permission, ReadonlySet<string>>();
    for (const permission of new Set(grants.flatMap((grant) => ceilingOf(grant.capability)))) {
      holding.set(permission, await this.people.eligible(holders, permission));
    }
    return (grant) =>
      !ceilingOf(grant.capability).every(
        (permission) => holding.get(permission)?.has(grant.userId) === true,
      );
  }
}

/**
 * Hands ownership to an ACTIVE member (§6.9, PROVISIONAL Q42): by the owner,
 * or through oversight (`communities.manage`) naming someone other than
 * themself — the recovery path when an owner can no longer act. The target
 * must be an ACTIVE account holding `communities.moderate`. One transaction
 * demotes the owner, promotes the target and ends the target's own grants
 * (the owner holds everything). The loser of a race — another transfer, or
 * the target's removal — gets 409 `communities.owner_conflict`. Naming the
 * current owner answers 200 and records nothing.
 */
@Injectable()
export class TransferOwnershipUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    private readonly people: CommunityPeople,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly userId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal, communityId } = command;
    const { result, read } = await this.authorization.evaluateOwner(
      principal,
      communityId,
      TRANSFER_OWNERSHIP,
    );
    if (!result.ok) return result;
    const permit = result.value;

    const target = command.userId;
    switch (
      mayTransfer({
        basis: permit.basis,
        actorUserId: principal.userId,
        actorIsOwner: read?.stint?.standing === 'OWNER',
        targetUserId: target,
      })
    ) {
      case 'unchanged':
        return this.unchanged(permit, principal, command.meta);
      case 'self_assignment':
        return err(OWNER_SELF_ASSIGNMENT);
      case 'proceed':
        break;
    }
    for (const permission of TRANSFER_OWNERSHIP.ownerCeiling) {
      const eligible = await this.people.eligible([target], permission);
      if (!eligible.has(target)) return err(OWNER_INELIGIBLE);
    }

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.transfer({
      communityId,
      toUserId: target,
      actor: ownerActingBasis(permit),
      transferredBy: actor,
      at,
    });
    switch (outcome.kind) {
      case 'transferred': {
        const endedGrantIds = outcome.endedGrants.map((grant) => grant.id);
        await this.journal.record(
          {
            actorUserId: actor,
            action: CommunityAudit.ownershipTransferred,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: {
              fromUserId: outcome.from.userId,
              toUserId: outcome.to.userId,
              basis: permit.basis,
              endedGrantIds,
              authority: ownerAuthorityOf(permit),
            },
            correlationId: command.meta.correlationId,
          },
          [
            ownershipTransferred(
              {
                from: outcome.from,
                to: outcome.to,
                endedGrants: outcome.endedGrants,
                transferredBy: actor,
                basis: permit.basis,
                at,
              },
              command.meta.correlationId,
            ),
          ],
        );
        return this.answer(principal, communityId);
      }
      case 'unchanged':
        return this.unchanged(permit, principal, command.meta);
      case 'target_not_member':
        return err(OWNER_INELIGIBLE);
      case 'owner_conflict':
        return err(OWNER_CONFLICT);
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }

  /**
   * Nothing changed, and the caller is shown the community anyway. On the
   * oversight basis that is a read without membership, audited like every
   * other (PROVISIONAL, Q43) — though nothing was transferred.
   */
  private async unchanged(
    permit: OwnerPermit,
    principal: Principal,
    meta: CallMetadata,
  ): Promise<Result<CommunityView>> {
    if (permit.basis === 'oversight') {
      await this.journal.oversightRead({
        actorUserId: actorOf(principal),
        communityId: permit.communityId,
        act: null,
        at: this.clock.now(),
        correlationId: meta.correlationId,
        detail: { operation: permit.operation, outcome: 'unchanged' },
      });
    }
    return this.answer(principal, permit.communityId);
  }

  /** The community as the caller now stands in it — read after the change. */
  private async answer(principal: Principal, communityId: string): Promise<Result<CommunityView>> {
    const read = await this.store.authorityOf(communityId, principal.userId);
    if (read.community === null) return err(COMMUNITY_NOT_FOUND);
    return ok(communityView(read.community, this.authorization.me(principal, communityId, read)));
  }
}
