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
import { ruleFor } from '../domain/act-rules';
import { COMMUNITY_NOT_FOUND } from '../domain/authority';
import { newCommunity } from '../domain/community';
import {
  communityCreated,
  communityLocked,
  communityUnlocked,
  memberAdded,
} from '../domain/events';
import { ownerStint } from '../domain/membership';
import {
  COMMUNITY_READ_MODEL,
  COMMUNITY_STORE,
  type CommunityReadModel,
  type CommunityStore,
} from '../domain/ports';
import { normalizeTitle } from '../domain/text';
import {
  COMMUNITY_CONFLICT,
  PERSON_REQUIRED,
  actingBasis,
  actorOf,
  refusalAfterBasisLost,
} from './community-acts';
import { CommunityAuthorizationService } from './community-authorization.service';
import { CommunitiesJournal, authorityOf } from './communities-journal';
import {
  COMMUNITY_AUDIT_RESOURCE,
  CommunityAudit,
  CommunityPages,
  CommunityRateLimits,
  pageLimit,
} from './communities-settings';
import { decodeCursor, paged } from './cursors';
import { communityView, type CommunityView, type PageView } from './views';

/**
 * Creates a community (S1). The creator becomes its owner and first member,
 * in one transaction. Re-authorized here because jobs and handlers bypass
 * the HTTP guard. Not idempotent — two requests make two communities, as
 * two group creations do in messaging.
 */
@Injectable()
export class CreateCommunityUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly title: string;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal } = command;
    // Creating, and being eligible to own what one creates (§6.7).
    for (const permission of [Permissions.communities.create, Permissions.communities.moderate]) {
      const allowed = this.identity.authorize(principal, permission, {
        resourceType: COMMUNITY_RESOURCE,
      });
      if (!allowed.ok) return allowed;
    }
    if (isSystemPrincipal(principal)) return err(PERSON_REQUIRED);

    const throttle = await this.limiter.consume(
      principal.userId,
      CommunityRateLimits.communitiesCreatedPerUser,
    );
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'communities.too_many_communities',
          'Too many new communities. Try again later.',
          { retryAfterSeconds: throttle.retryAfterSeconds },
        ),
      );
    }
    const title = normalizeTitle(command.title);
    if (!title.ok) return title;

    const at = this.clock.now();
    const community = newCommunity({
      id: this.ids.next<'Community'>(),
      title: title.value,
      createdBy: principal.userId,
      at,
    });
    const owner = ownerStint({
      id: this.ids.next<'CommunityMembership'>(),
      communityId: community.id,
      userId: principal.userId,
      at,
    });
    await this.store.create(community, owner);

    await this.journal.record(
      {
        actorUserId: principal.userId,
        action: CommunityAudit.communityCreated,
        resourceType: COMMUNITY_AUDIT_RESOURCE,
        resourceId: community.id,
        at,
        metadata: { membershipId: owner.id },
        correlationId: command.meta.correlationId,
      },
      [
        communityCreated(community, command.meta.correlationId),
        memberAdded(owner, command.meta.correlationId),
      ],
    );
    return ok(
      communityView(
        community,
        this.authorization.me(principal, community.id, {
          community,
          stint: { ...owner, grants: [] },
        }),
      ),
    );
  }
}

/** One community, with what the caller may do in it. Members and overseers only. */
@Injectable()
export class GetCommunityUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { result, read } = await this.authorization.evaluate(
      command.principal,
      command.communityId,
      ruleFor('community.view'),
    );
    if (!result.ok) return result;
    if (read === null || read.community === null) return err(COMMUNITY_NOT_FOUND);
    if (result.value.basis === 'oversight') {
      await this.journal.oversightRead({
        actorUserId: actorOf(command.principal),
        communityId: command.communityId,
        act: 'community.view',
        at: this.clock.now(),
        correlationId: command.meta.correlationId,
      });
    }
    return ok(
      communityView(
        read.community,
        this.authorization.me(command.principal, command.communityId, read),
      ),
    );
  }
}

/**
 * The caller's communities (newest join first) — or, for an overseer, every
 * community (newest first; the listing itself is audited, Q43). Each item
 * carries its `me` block from the same read: no query per row.
 */
@Injectable()
export class ListCommunitiesUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(COMMUNITY_READ_MODEL) private readonly readModel: CommunityReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly scope: 'mine' | 'all';
    readonly cursor?: string;
    readonly limit?: number;
    readonly meta: CallMetadata;
  }): Promise<Result<PageView<CommunityView>>> {
    const { principal } = command;
    const context = { resourceType: COMMUNITY_RESOURCE };
    const reads = this.identity.authorize(principal, Permissions.communities.read, context);
    if (!reads.ok) return reads;
    const cursor = decodeCursor(command.cursor);
    if (!cursor.ok) return cursor;
    const limit = pageLimit(command.limit, CommunityPages.communities);

    if (command.scope === 'mine') {
      const rows = await this.readModel.myCommunities(principal.userId, {
        before: cursor.value,
        limit: limit + 1,
      });
      const page = paged(rows, limit, (row) => ({ at: row.stint.joinedAt, id: row.community.id }));
      return ok({
        items: page.items.map((row) =>
          communityView(
            row.community,
            this.authorization.me(principal, row.community.id, {
              community: row.community,
              stint: { ...row.stint, grants: row.grants },
            }),
          ),
        ),
        nextCursor: page.nextCursor,
      });
    }

    const oversees = this.identity.authorize(principal, Permissions.communities.manage, context);
    if (!oversees.ok) return oversees;
    const rows = await this.readModel.allCommunities({ before: cursor.value, limit: limit + 1 });
    const page = paged(rows, limit, (community) => ({ at: community.createdAt, id: community.id }));
    // The overseer's own stints, for the `me` blocks — one read for the page.
    const stints = await this.store.authorityOfEach(
      page.items.map((community) => community.id),
      principal.userId,
    );
    await this.journal.oversightRead({
      actorUserId: actorOf(principal),
      communityId: '*',
      act: null,
      at: this.clock.now(),
      correlationId: command.meta.correlationId,
      detail: { listing: 'all', count: page.items.length },
    });
    return ok({
      items: page.items.map((community) =>
        communityView(
          community,
          this.authorization.me(principal, community.id, {
            community,
            stint: stints.get(community.id)?.stint ?? null,
          }),
        ),
      ),
      nextCursor: page.nextCursor,
    });
  }
}

/**
 * Lock or unlock (§8.4). An absolute target, so a repeat — or ten
 * simultaneous locks — changes the community once: one audit entry, one
 * event, and the version raised once; every other request answers 200.
 * `community.lock` is never blocked by the lifecycle, so a locked community
 * can always be unlocked.
 */
@Injectable()
export class ChangeCommunityStatusUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly to: 'OPEN' | 'LOCKED';
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal, communityId } = command;
    const rule = ruleFor('community.lock');
    const { result, read } = await this.authorization.evaluate(principal, communityId, rule);
    if (!result.ok) return result;
    const permit = result.value;

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.changeStatus({
      communityId,
      to: command.to,
      actor: actingBasis(permit),
      actorUserId: actor,
      at,
    });
    const view = (community: Parameters<typeof communityView>[0]) =>
      communityView(
        community,
        this.authorization.me(principal, communityId, { community, stint: read?.stint ?? null }),
      );

    switch (outcome.kind) {
      case 'changed': {
        const locked = command.to === 'LOCKED';
        await this.journal.record(
          {
            actorUserId: actor,
            action: locked ? CommunityAudit.communityLocked : CommunityAudit.communityUnlocked,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: {
              lifecycleVersion: outcome.community.lifecycleVersion,
              authority: authorityOf(permit),
            },
            correlationId: command.meta.correlationId,
          },
          [
            locked
              ? communityLocked(outcome.community, actor, at, command.meta.correlationId)
              : communityUnlocked(outcome.community, actor, at, command.meta.correlationId),
          ],
        );
        return ok(view(outcome.community));
      }
      case 'unchanged':
        return ok(view(outcome.community));
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'basis_lost':
        return err(await refusalAfterBasisLost(this.authorization, principal, communityId, rule));
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}
