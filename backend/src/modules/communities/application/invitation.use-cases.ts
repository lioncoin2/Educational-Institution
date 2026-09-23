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
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';
import { isSystemPrincipal } from '../../identity/contracts/principal';
import { COMMUNITY_RESOURCE } from '../contracts/capabilities';
import { LINK_MANAGEMENT_RULE, ruleFor } from '../domain/act-rules';
import { COMMUNITY_NOT_FOUND } from '../domain/authority';
import { invitationCreated, invitationRevoked, memberAdded } from '../domain/events';
import {
  INVITATION_SECRETS,
  isTokenShaped,
  validateTerms,
  type Invitation,
  type InvitationSecrets,
} from '../domain/invitation';
import {
  COMMUNITY_READ_MODEL,
  COMMUNITY_STORE,
  type CommunityReadModel,
  type CommunityStore,
} from '../domain/ports';
import {
  COMMUNITY_CONFLICT,
  PERSON_REQUIRED,
  actingBasis,
  actorOf,
  refusalAfterBasisLost,
} from './community-acts';
import { CommunityAuthorizationService } from './community-authorization.service';
import { CommunityPeople } from './community-people';
import { CommunitiesJournal, authorityOf } from './communities-journal';
import {
  COMMUNITY_AUDIT_RESOURCE,
  CommunityAudit,
  CommunityPages,
  CommunityRateLimits,
  pageLimit,
} from './communities-settings';
import { decodeCursor, paged } from './cursors';
import {
  communityView,
  invitationView,
  type CommunityView,
  type InvitationView,
  type PageView,
} from './views';

const INVITATION_NOT_FOUND = failure(
  'not_found',
  'communities.invitation_not_found',
  'No such invitation link in this community.',
);

/**
 * One answer for a malformed token, an unknown one, and a link whose creator
 * can no longer admit anyone: the holder learns nothing about which it was,
 * or about a third person's standing.
 */
const INVITATION_INVALID = failure(
  'not_found',
  'communities.invitation_invalid',
  'This invitation link is not valid.',
);

/**
 * A manager creates a link (S2): the owner — or a delegate from P3; never an
 * overseer, and never while the community is LOCKED. The token appears in
 * this response and nowhere else, ever: only its SHA-256 is stored, and no
 * log line, audit entry or event carries either.
 */
@Injectable()
export class CreateInvitationUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(INVITATION_SECRETS) private readonly secrets: InvitationSecrets,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly expiresInSeconds?: number;
    readonly maxUses?: number | null;
    readonly meta: CallMetadata;
  }): Promise<Result<{ readonly invitation: InvitationView; readonly token: string }>> {
    const { principal, communityId } = command;
    const rule = ruleFor('community.members.invite');
    const { result } = await this.authorization.evaluate(principal, communityId, rule);
    if (!result.ok) return result;
    const permit = result.value;

    const throttle = await this.limiter.consume(
      principal.userId,
      CommunityRateLimits.invitationsCreatedPerUser,
    );
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'communities.too_many_invitations',
          'Too many new links. Try again later.',
          { retryAfterSeconds: throttle.retryAfterSeconds },
        ),
      );
    }
    const terms = validateTerms({
      expiresInSeconds: command.expiresInSeconds,
      maxUses: command.maxUses,
    });
    if (!terms.ok) return terms;

    const at = this.clock.now();
    const id = this.ids.next<'CommunityInvitation'>();
    // A hash collision (about 2⁻²⁵⁶) issues once more; a second is a fault.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { token, tokenHash } = this.secrets.issue();
      const invitation: Invitation = {
        id,
        communityId,
        tokenHash,
        createdBy: principal.userId,
        createdAt: at,
        expiresAt: new Date(at.getTime() + terms.value.expiresInSeconds * 1000),
        maxUses: terms.value.maxUses,
        uses: 0,
        revokedAt: null,
        revokedBy: null,
      };
      const outcome = await this.store.createInvitation({
        invitation,
        actor: actingBasis(permit),
      });
      switch (outcome.kind) {
        case 'created':
          await this.journal.record(
            {
              actorUserId: principal.userId,
              action: CommunityAudit.invitationCreated,
              resourceType: COMMUNITY_AUDIT_RESOURCE,
              resourceId: communityId,
              at,
              metadata: {
                invitationId: invitation.id,
                expiresAt: invitation.expiresAt.toISOString(),
                maxUses: invitation.maxUses,
                authority: authorityOf(permit),
              },
              correlationId: command.meta.correlationId,
            },
            [invitationCreated(invitation, command.meta.correlationId)],
          );
          return ok({ invitation: invitationView(invitation, at), token });
        case 'token_collision':
          continue;
        case 'not_found':
          return err(COMMUNITY_NOT_FOUND);
        case 'basis_lost':
          return err(await refusalAfterBasisLost(this.authorization, principal, communityId, rule));
        case 'conflict':
          return err(COMMUNITY_CONFLICT);
      }
    }
    throw new Error('Two invitation token collisions in a row: the token source is broken.');
  }
}

/**
 * A community's links, newest first — metadata only, never a token or a
 * hash; the state derived now. The owner, or an overseer (audited) — who may
 * list and revoke links, to kill a leaked one, but never create them.
 */
@Injectable()
export class ListInvitationsUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
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
  }): Promise<Result<PageView<InvitationView>>> {
    const { principal, communityId } = command;
    const { result } = await this.authorization.evaluate(
      principal,
      communityId,
      LINK_MANAGEMENT_RULE,
    );
    if (!result.ok) return result;
    const cursor = decodeCursor(command.cursor);
    if (!cursor.ok) return cursor;
    const limit = pageLimit(command.limit, CommunityPages.invitations);

    const rows = await this.readModel.invitations(communityId, {
      before: cursor.value,
      limit: limit + 1,
    });
    const page = paged(rows, limit, (invitation) => ({
      at: invitation.createdAt,
      id: invitation.id,
    }));
    const now = this.clock.now();
    if (result.value.basis === 'oversight') {
      await this.journal.oversightRead({
        actorUserId: actorOf(principal),
        communityId,
        act: 'community.members.invite',
        at: now,
        correlationId: command.meta.correlationId,
        detail: { listing: 'invitations' },
      });
    }
    return ok({
      items: page.items.map((invitation) => invitationView(invitation, now)),
      nextCursor: page.nextCursor,
    });
  }
}

/**
 * Revokes a link, at once and for good — linearized with redemption on the
 * link's row, so a redemption either committed first or finds it revoked.
 * Revocation stops future use only: whoever joined stays, and removing them
 * is a separate, audited act. The community is authorized before the link
 * is loaded, so a link id is never an enumeration surface.
 */
@Injectable()
export class RevokeInvitationUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly invitationId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<InvitationView>> {
    const { principal, communityId } = command;
    const { result } = await this.authorization.evaluate(
      principal,
      communityId,
      LINK_MANAGEMENT_RULE,
    );
    if (!result.ok) return result;
    const permit = result.value;

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.revokeInvitation({
      communityId,
      invitationId: command.invitationId,
      actor: actingBasis(permit),
      revokedBy: actor,
      at,
    });
    switch (outcome.kind) {
      case 'revoked':
        await this.journal.record(
          {
            actorUserId: actor,
            action: CommunityAudit.invitationRevoked,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: { invitationId: outcome.invitation.id, authority: authorityOf(permit) },
            correlationId: command.meta.correlationId,
          },
          [invitationRevoked(outcome.invitation, command.meta.correlationId)],
        );
        return ok(invitationView(outcome.invitation, at));
      case 'unchanged':
        return ok(invitationView(outcome.invitation, at));
      case 'not_found':
        return err(INVITATION_NOT_FOUND);
      case 'basis_lost':
        return err(
          await refusalAfterBasisLost(
            this.authorization,
            principal,
            communityId,
            LINK_MANAGEMENT_RULE,
          ),
        );
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

export type RedemptionResult =
  | { readonly kind: 'joined'; readonly community: CommunityView }
  | { readonly kind: 'already_member'; readonly community: CommunityView };

/**
 * Redeems a link (S3). The token is the only input: it names the community,
 * so no community id is taken from the client and there is no mismatch or
 * enumeration case. A signed-in account allowed to take part in communities
 * — a link never creates an account (Q2).
 *
 * Before the transaction: the per-user limit, the token's shape, its hash,
 * one indexed lookup, and the creator's ceiling. Then one transaction decides
 * everything else. A second redemption by a member is 200 with nothing
 * consumed or recorded; every refusal consumes nothing.
 */
@Injectable()
export class RedeemInvitationUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly authorization: CommunityAuthorizationService,
    private readonly people: CommunityPeople,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(INVITATION_SECRETS) private readonly secrets: InvitationSecrets,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly token: unknown;
    readonly meta: CallMetadata;
  }): Promise<Result<RedemptionResult>> {
    const { principal } = command;
    const may = this.mayJoinByInvitation(principal);
    if (!may.ok) return may;

    const throttle = await this.limiter.consume(principal.userId, CommunityRateLimits.joinsPerUser);
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'communities.too_many_attempts',
          'Too many attempts. Try again later.',
          { retryAfterSeconds: throttle.retryAfterSeconds },
        ),
      );
    }
    if (!isTokenShaped(command.token)) return err(INVITATION_INVALID);
    const link = await this.store.findInvitationByTokenHash(this.secrets.hash(command.token));
    if (link === null) return err(INVITATION_INVALID);
    // The creator's ceiling, before the transaction; their standing, under lock.
    const creator = await this.people.eligible([link.createdBy], Permissions.communities.moderate);
    if (!creator.has(link.createdBy)) return err(INVITATION_INVALID);

    const at = this.clock.now();
    const outcome = await this.store.redeem({
      invitationId: link.invitationId,
      communityId: link.communityId,
      userId: principal.userId,
      creatorUserId: link.createdBy,
      stintId: this.ids.next<'CommunityMembership'>(),
      at,
    });
    switch (outcome.kind) {
      case 'joined':
        await this.journal.record(
          {
            actorUserId: principal.userId,
            action: CommunityAudit.memberJoined,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: link.communityId,
            at,
            metadata: {
              invitationId: link.invitationId,
              membershipId: outcome.stint.id,
              membershipVersion: outcome.stint.version,
            },
            correlationId: command.meta.correlationId,
          },
          [memberAdded(outcome.stint, command.meta.correlationId)],
        );
        return this.answer('joined', principal, link.communityId);
      case 'already_member':
        return this.answer('already_member', principal, link.communityId);
      case 'removed':
        return err(
          failure(
            'forbidden',
            'communities.rejoin_requires_manager',
            'You were removed from this community; only its managers can add you back.',
          ),
        );
      case 'revoked':
        return err(
          failure(
            'precondition_failed',
            'communities.invitation_revoked',
            'This link was revoked.',
          ),
        );
      case 'expired':
        return err(
          failure('precondition_failed', 'communities.invitation_expired', 'This link expired.'),
        );
      case 'exhausted':
        return err(
          failure(
            'precondition_failed',
            'communities.invitation_exhausted',
            'This link has been used as many times as it allows.',
          ),
        );
      case 'locked':
        return err(
          failure(
            'precondition_failed',
            'communities.community_locked',
            'This community is locked; its links work again once it is unlocked.',
          ),
        );
      case 'creator_lost':
      case 'not_found':
        return err(INVITATION_INVALID);
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }

  /**
   * The one seam for who may join by a link — PROVISIONALLY, a person who
   * may take part in communities (Q48). Guardians cannot while PARENT is
   * inactive (Q41).
   */
  private mayJoinByInvitation(principal: Principal): Result<void> {
    const allowed = this.identity.authorize(principal, Permissions.communities.read, {
      resourceType: COMMUNITY_RESOURCE,
    });
    if (!allowed.ok) return allowed;
    return isSystemPrincipal(principal) ? err(PERSON_REQUIRED) : ok(undefined);
  }

  private async answer(
    kind: RedemptionResult['kind'],
    principal: Principal,
    communityId: string,
  ): Promise<Result<RedemptionResult>> {
    const read = await this.store.authorityOf(communityId, principal.userId);
    if (read.community === null) return err(COMMUNITY_NOT_FOUND);
    return ok({
      kind,
      community: communityView(read.community, this.authorization.me(principal, communityId, read)),
    });
  }
}
