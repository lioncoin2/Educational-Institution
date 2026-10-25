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
  ACADEMIC_RELATIONSHIPS,
  type AcademicRelationships,
} from '../../academic/contracts/relationships';
import { FILE_ASSETS, type FileAssets } from '../../files/contracts/file-assets';
import type { FileKind } from '../../files/contracts/file-kind';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';
import { isSystemPrincipal } from '../../identity/contracts/principal';
import { COMMUNITY_RESOURCE } from '../contracts/capabilities';
import { ruleFor } from '../domain/act-rules';
import { COMMUNITY_NOT_FOUND } from '../domain/authority';
import { newCommunity, setChatMode } from '../domain/community';
import {
  chatModeForKind,
  type CommunityChatMode,
  type CommunityKind,
} from '../contracts/vocabulary';
import {
  communityChatModeChanged,
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
import { normalizeDescription, normalizeTitle } from '../domain/text';
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
    /**
     * GROUP (open member posting) or CHANNEL (publishers only), ADR 0039.
     * Defaults to GROUP — the brief's "groups" — when a caller omits it.
     */
    readonly kind?: CommunityKind;
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
      chatMode: chatModeForKind(command.kind ?? 'GROUP'),
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
        [], // a brand-new community has no halaqa associations yet
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
        await this.authorization.meOf(command.principal, command.communityId, read),
        read.halaqaIds,
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
      const pageReads = page.items.map((row) => ({
        communityId: row.community.id,
        read: { community: row.community, stint: { ...row.stint, grants: row.grants } },
      }));
      // ADR 0044 C: one recovery question for the whole page, as `me` needs it.
      const recoverable = await this.authorization.recoverableOwnership(principal, pageReads);
      return ok({
        items: page.items.map((row, index) =>
          communityView(
            row.community,
            this.authorization.me(
              principal,
              row.community.id,
              pageReads[index].read,
              recoverable.has(row.community.id),
            ),
            row.halaqaIds,
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
    const pageReads = page.items.map((community) => ({
      communityId: community.id,
      read: { community, stint: stints.get(community.id)?.stint ?? null },
    }));
    // ADR 0044 C: one recovery question for the whole page, as `me` needs it.
    const recoverable = await this.authorization.recoverableOwnership(principal, pageReads);
    return ok({
      items: page.items.map((community, index) =>
        communityView(
          community,
          this.authorization.me(
            principal,
            community.id,
            pageReads[index].read,
            recoverable.has(community.id),
          ),
          stints.get(community.id)?.halaqaIds ?? [],
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
    const view = async (community: Parameters<typeof communityView>[0]) =>
      communityView(
        community,
        await this.authorization.meOf(principal, communityId, {
          community,
          stint: read?.stint ?? null,
        }),
        read?.halaqaIds ?? [],
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
        return ok(await view(outcome.community));
      }
      case 'unchanged':
        return ok(await view(outcome.community));
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'basis_lost':
        return err(await refusalAfterBasisLost(this.authorization, principal, communityId, rule));
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/** The picture named is not an image the editor uploaded (Files' own check). */
const COMMUNITY_AVATAR_INVALID = failure(
  'validation',
  'communities.avatar_invalid',
  'The picture must be an image you have uploaded.',
);

/** A community's picture is always an image. */
const AVATAR_KINDS: readonly FileKind[] = ['IMAGE'];

/**
 * Edit a community's own title, description and picture together
 * (`community.profile.edit`, ADR 0038).
 *
 * The decision is Communities' (ceiling + basis + lifecycle), asked through the
 * one evaluator. A new picture is verified through the Files contract — an
 * image the editor uploaded — before it is stored, exactly as messaging
 * verifies an attachment; the unchanged picture is left untouched, so an
 * overseer correcting the text need not own whoever's image it already carries.
 * Membership, roles and grants are not touched.
 */
@Injectable()
export class EditCommunityProfileUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly title: string;
    readonly description: string | null;
    readonly avatarFileAssetId: string | null;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal, communityId } = command;

    const title = normalizeTitle(command.title);
    if (!title.ok) return title;
    const description = normalizeDescription(command.description);
    if (!description.ok) return description;

    const rule = ruleFor('community.profile.edit');
    const { result, read } = await this.authorization.evaluate(principal, communityId, rule);
    if (!result.ok) return result;
    const permit = result.value;

    // Verify a NEW picture only — an image the editor owns — so correcting text
    // never fails on a picture someone else uploaded earlier.
    const currentAvatar = read?.community?.avatarFileAssetId ?? null;
    if (command.avatarFileAssetId !== null && command.avatarFileAssetId !== currentAvatar) {
      const verified = await this.files.verifyAttachable(
        command.avatarFileAssetId,
        principal.userId,
        AVATAR_KINDS,
      );
      if (!verified.ok) return err(COMMUNITY_AVATAR_INVALID);
    }

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.editProfile({
      communityId,
      title: title.value,
      description: description.value,
      avatarFileAssetId: command.avatarFileAssetId,
      actor: actingBasis(permit),
      actorUserId: actor,
      at,
    });
    const view = async (community: Parameters<typeof communityView>[0]) =>
      communityView(
        community,
        await this.authorization.meOf(principal, communityId, {
          community,
          stint: read?.stint ?? null,
        }),
        read?.halaqaIds ?? [],
      );

    switch (outcome.kind) {
      case 'changed':
        await this.journal.record(
          {
            actorUserId: actor,
            action: CommunityAudit.communityProfileUpdated,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: {
              hasDescription: outcome.community.description !== null,
              hasAvatar: outcome.community.avatarFileAssetId !== null,
              authority: authorityOf(permit),
            },
            correlationId: command.meta.correlationId,
          },
          [],
        );
        return ok(await view(outcome.community));
      case 'unchanged':
        return ok(await view(outcome.community));
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
 * Restrict or restore ordinary-member posting in a GROUP (`community.chat.manage`,
 * ADR 0039). `membersMayPost` is the admin's intent: true → GROUP_OPEN,
 * false → GROUP_RESTRICTED. The domain `setChatMode` refuses an invalid
 * transition (a CHANNEL, or turning a group into a channel) from the read
 * snapshot before any write; the store re-verifies the acting basis under lock.
 * Membership and read access are untouched — only who may publish changes.
 */
@Injectable()
export class SetChatModeUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly membersMayPost: boolean;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal, communityId } = command;
    const to: CommunityChatMode = command.membersMayPost ? 'GROUP_OPEN' : 'GROUP_RESTRICTED';

    const rule = ruleFor('community.chat.manage');
    const { result, read } = await this.authorization.evaluate(principal, communityId, rule);
    if (!result.ok) return result;
    const permit = result.value;

    // Validate the transition against the read snapshot: a CHANNEL's publishing
    // is fixed, and a group is never turned into a channel here.
    const current = read?.community ?? null;
    if (current === null) return err(COMMUNITY_NOT_FOUND);
    const transition = setChatMode(current, to, this.clock.now());
    if (!transition.ok) return transition;

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.setChatMode({
      communityId,
      to,
      actor: actingBasis(permit),
      actorUserId: actor,
      at,
    });
    const view = async (community: Parameters<typeof communityView>[0]) =>
      communityView(
        community,
        await this.authorization.meOf(principal, communityId, {
          community,
          stint: read?.stint ?? null,
        }),
        read?.halaqaIds ?? [],
      );

    switch (outcome.kind) {
      case 'changed':
        await this.journal.record(
          {
            actorUserId: actor,
            action: CommunityAudit.communityChatModeChanged,
            resourceType: COMMUNITY_AUDIT_RESOURCE,
            resourceId: communityId,
            at,
            metadata: { chatMode: outcome.community.chatMode, authority: authorityOf(permit) },
            correlationId: command.meta.correlationId,
          },
          [communityChatModeChanged(outcome.community, actor, at, command.meta.correlationId)],
        );
        return ok(await view(outcome.community));
      case 'unchanged':
        return ok(await view(outcome.community));
      case 'not_found':
        return err(COMMUNITY_NOT_FOUND);
      case 'basis_lost':
        return err(await refusalAfterBasisLost(this.authorization, principal, communityId, rule));
      case 'conflict':
        return err(COMMUNITY_CONFLICT);
    }
  }
}

/** A link named a halaqa that academic does not have. */
const HALAQA_NOT_FOUND = failure('not_found', 'communities.halaqa_not_found', 'No such halaqa.');

/**
 * The view of a community after a halaqa link changed: the community and its
 * current halaqa associations, read back in one authority read (which also
 * carries the `me` block), so the response reflects exactly what was written.
 * A community that vanished under the write is `COMMUNITY_NOT_FOUND`.
 */
async function halaqaLinkView(
  authorization: CommunityAuthorizationService,
  store: CommunityStore,
  principal: Principal,
  communityId: string,
): Promise<Result<CommunityView>> {
  const read = await store.authorityOf(communityId, principal.userId);
  if (read.community === null) return err(COMMUNITY_NOT_FOUND);
  return ok(
    communityView(read.community, authorization.me(principal, communityId, read), read.halaqaIds),
  );
}

/**
 * Associates a community with an academic halaqa (Q50). A group or channel may
 * be associated with many halaqat, and a halaqa with many groups and channels
 * (ADR 0033). Institutional oversight — `communities.manage`, held by the owner
 * and admins — decides it, never membership or ownership of the community; the
 * same administrators administer the academic structure, so no new authority is
 * invented. The association is inert metadata: it creates and removes no
 * membership, grants and revokes no capability, and derives no messaging,
 * attendance or academic authorization. Linking the same halaqa again changes
 * nothing (idempotent).
 *
 * A link's target is validated through academic's read-only
 * `ACADEMIC_RELATIONSHIPS` contract — existence only, revealing no enrollment,
 * teaching or roster — so a dangling reference is refused before it is stored
 * (ADR 0033). Communities reaches academic through that contract alone and
 * never its internals or tables.
 */
@Injectable()
export class LinkCommunityHalaqaUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACADEMIC_RELATIONSHIPS) private readonly academic: AcademicRelationships,
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly halaqaId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal, communityId } = command;
    const oversees = this.identity.authorize(principal, Permissions.communities.manage, {
      resourceType: COMMUNITY_RESOURCE,
      resourceId: communityId,
    });
    if (!oversees.ok) return oversees;

    // Reject a dangling reference before persisting.
    if (!(await this.academic.halaqaExists(command.halaqaId))) return err(HALAQA_NOT_FOUND);

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.linkHalaqa({
      linkId: this.ids.next<'CommunityHalaqaLink'>(),
      communityId,
      halaqaId: command.halaqaId,
      linkedBy: actor,
      at,
    });
    if (outcome.kind === 'not_found') return err(COMMUNITY_NOT_FOUND);
    if (outcome.kind === 'conflict') return err(COMMUNITY_CONFLICT);
    if (outcome.kind === 'linked') {
      await this.journal.record(
        {
          actorUserId: actor,
          action: CommunityAudit.halaqaLinked,
          resourceType: COMMUNITY_AUDIT_RESOURCE,
          resourceId: communityId,
          at,
          metadata: { halaqaId: command.halaqaId },
          correlationId: command.meta.correlationId,
        },
        [],
      );
    }
    return halaqaLinkView(this.authorization, this.store, principal, communityId);
  }
}

/**
 * Removes one of a community's academic halaqa associations (Q50). The same
 * oversight gate (`communities.manage`) and the same inertness as linking;
 * removing a link that is not there changes nothing (idempotent) and touches no
 * other link, membership or association. Unlinking needs no academic
 * validation — a link to a halaqa that no longer exists can always be removed.
 */
@Injectable()
export class UnlinkCommunityHalaqaUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly authorization: CommunityAuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: CommunitiesJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly halaqaId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<CommunityView>> {
    const { principal, communityId } = command;
    const oversees = this.identity.authorize(principal, Permissions.communities.manage, {
      resourceType: COMMUNITY_RESOURCE,
      resourceId: communityId,
    });
    if (!oversees.ok) return oversees;

    const at = this.clock.now();
    const actor = actorOf(principal);
    const outcome = await this.store.unlinkHalaqa({ communityId, halaqaId: command.halaqaId });
    if (outcome.kind === 'not_found') return err(COMMUNITY_NOT_FOUND);
    if (outcome.kind === 'conflict') return err(COMMUNITY_CONFLICT);
    if (outcome.kind === 'unlinked') {
      await this.journal.record(
        {
          actorUserId: actor,
          action: CommunityAudit.halaqaUnlinked,
          resourceType: COMMUNITY_AUDIT_RESOURCE,
          resourceId: communityId,
          at,
          metadata: { halaqaId: command.halaqaId },
          correlationId: command.meta.correlationId,
        },
        [],
      );
    }
    return halaqaLinkView(this.authorization, this.store, principal, communityId);
  }
}
