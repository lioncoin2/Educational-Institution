import { Inject, Injectable } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationContext,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import type { Permission } from '../../identity/contracts/permissions';
import {
  COMMUNITY_CAPABILITIES,
  COMMUNITY_PARTICIPATION,
  COMMUNITY_RESOURCE,
  type CommunityAct,
} from '../contracts/capabilities';
import {
  MAX_AUTHORIZE_BATCH,
  type CommunityAuthorization,
  type CommunityPermit,
} from '../contracts/authorization';
import { ruleFor, type ActRule } from '../domain/act-rules';
import {
  decideCommunityAct,
  holdsAnyCeiling,
  type AuthorityRead,
  type HeldCeilings,
} from '../domain/authority';
import { COMMUNITY_STORE, type CommunityAuthorityRead, type CommunityStore } from '../domain/ports';
import type { MeView } from './views';

/** An answer, and the read it was made from (null when nothing was read). */
export interface Evaluation {
  readonly result: Result<CommunityPermit>;
  readonly read: CommunityAuthorityRead | null;
}

/**
 * COMMUNITY_AUTHORIZATION — and the evaluator Communities' own use cases go
 * through, so there is exactly one way a community act is allowed.
 *
 * Identity answers the ceilings, in memory and before anything is read,
 * with the community as context (`communities.community/<id>`, and the act
 * as an attribute a future identity DENY rule could match). Communities never
 * passes `ownerUserId`, so no identity rule written for another resource can
 * fire here. Then one read — the community and the principal's ACTIVE stint
 * — and the pure `decideCommunityAct`.
 *
 * Stateless: nothing is cached between requests, and a store failure rejects
 * the promise — a caller fails closed and never answers from roles alone.
 */
@Injectable()
export class CommunityAuthorizationService implements CommunityAuthorization {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(COMMUNITY_STORE) private readonly store: CommunityStore,
  ) {}

  async authorize(
    principal: Principal,
    communityId: string,
    act: CommunityAct,
  ): Promise<Result<CommunityPermit>> {
    return (await this.evaluate(principal, communityId, ruleFor(act))).result;
  }

  async authorizeEach(
    principal: Principal,
    communityIds: readonly string[],
    act: CommunityAct,
  ): Promise<ReadonlyMap<string, Result<CommunityPermit>>> {
    if (communityIds.length > MAX_AUTHORIZE_BATCH) {
      throw new RangeError(`authorizeEach takes at most ${MAX_AUTHORIZE_BATCH} community ids.`);
    }
    const rule = ruleFor(act);
    const answers = new Map<string, Result<CommunityPermit>>();
    const toRead: string[] = [];
    const heldBy = new Map<string, HeldCeilings>();
    for (const communityId of new Set(communityIds)) {
      const held = this.ceilings(principal, communityId, rule);
      if (holdsAnyCeiling(rule, held)) {
        heldBy.set(communityId, held);
        toRead.push(communityId);
      } else {
        answers.set(communityId, this.noCeiling(principal, communityId, rule));
      }
    }
    if (toRead.length > 0) {
      const reads = await this.store.authorityOfEach(toRead, principal.userId);
      for (const communityId of toRead) {
        const read = reads.get(communityId) ?? { community: null, stint: null };
        const held = heldBy.get(communityId) as HeldCeilings;
        answers.set(communityId, this.decide(principal, communityId, rule, held, read));
      }
    }
    return answers;
  }

  /**
   * The evaluator with any rule — including the link-management override —
   * returning the read it made, so a use case can build its response from
   * the same snapshot instead of reading again.
   */
  async evaluate(principal: Principal, communityId: string, rule: ActRule): Promise<Evaluation> {
    const held = this.ceilings(principal, communityId, rule);
    if (!holdsAnyCeiling(rule, held)) {
      return { result: this.noCeiling(principal, communityId, rule), read: null };
    }
    const read = await this.store.authorityOf(communityId, principal.userId);
    return { result: this.decide(principal, communityId, rule, held, read), read };
  }

  /**
   * What the principal may do in the community, from a read already made:
   * every capability and participation act the same evaluator would permit
   * right now. No further read.
   */
  me(principal: Principal, communityId: string, read: AuthorityRead): MeView {
    const permits = (act: CommunityAct) => {
      const rule = ruleFor(act);
      return (
        decideCommunityAct(rule, this.ceilings(principal, communityId, rule), read).kind ===
        'permit'
      );
    };
    return {
      standing: read.stint?.standing ?? null,
      joinedAt: read.stint?.joinedAt ?? null,
      capabilities: COMMUNITY_CAPABILITIES.filter(permits),
      participation: COMMUNITY_PARTICIPATION.filter(permits),
    };
  }

  private decide(
    principal: Principal,
    communityId: string,
    rule: ActRule,
    held: HeldCeilings,
    read: AuthorityRead,
  ): Result<CommunityPermit> {
    const decision = decideCommunityAct(rule, held, read);
    switch (decision.kind) {
      case 'no_ceiling':
        return this.noCeiling(principal, communityId, rule);
      case 'refused':
        return err(decision.failure);
      case 'permit':
        return ok({
          principalUserId: principal.userId,
          communityId,
          scope: COMMUNITY_RESOURCE,
          act: rule.act,
          basis: decision.basis,
          membership: decision.membership,
          grantId: null,
          ceiling: decision.ceiling,
        });
    }
  }

  private context(communityId: string, rule: ActRule): AuthorizationContext {
    return {
      resourceType: COMMUNITY_RESOURCE,
      resourceId: communityId,
      attributes: { act: rule.act },
    };
  }

  private ceilings(principal: Principal, communityId: string, rule: ActRule): HeldCeilings {
    const context = this.context(communityId, rule);
    const holdsAll = (permissions: readonly Permission[]) =>
      permissions.every((permission) => this.identity.can(principal, permission, context));
    return {
      standing: holdsAll(rule.standingCeiling),
      oversight: rule.oversightCeiling !== null && holdsAll(rule.oversightCeiling),
    };
  }

  /** Identity's own refusal for the first ceiling permission the principal lacks. */
  private noCeiling(
    principal: Principal,
    communityId: string,
    rule: ActRule,
  ): Result<CommunityPermit> {
    const context = this.context(communityId, rule);
    for (const permission of rule.standingCeiling) {
      const allowed = this.identity.authorize(principal, permission, context);
      if (!allowed.ok) return allowed;
    }
    // Unreachable for a well-formed rule: the standing ceiling was not all held.
    throw new Error(`No ceiling refusal for ${rule.act}`);
  }
}
