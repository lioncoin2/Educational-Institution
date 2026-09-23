import {
  asId,
  type AuditEntry,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
  type Id,
  type IdGenerator,
  type Principal,
} from '../../src/shared';
import type {
  AccountDirectory,
  AccountSummary,
  AuthorizationService,
  Permission,
} from '../../src/modules/identity/contracts';
import { systemPrincipal } from '../../src/modules/identity/contracts/principal';
// The real decision point and the provisional matrix — test-only reach into
// identity's internals, so every ceiling is decided exactly as in production.
import { PolicyAuthorizationService } from '../../src/modules/identity/application/authorization.service';
import {
  PROVISIONAL_POLICY_RULES,
  PROVISIONAL_ROLE_PERMISSIONS,
} from '../../src/modules/identity/domain/provisional-policy';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import { CapabilityHoldersService } from '../../src/modules/communities/application/capability-holders.service';
import { CommunityAuthorizationService } from '../../src/modules/communities/application/community-authorization.service';
import { CommunityDirectoryService } from '../../src/modules/communities/application/community-directory.service';
import { CommunityMembershipService } from '../../src/modules/communities/application/community-membership.service';
import { CommunityPeople } from '../../src/modules/communities/application/community-people';
import {
  ChangeCommunityStatusUseCase,
  CreateCommunityUseCase,
  GetCommunityUseCase,
  ListCommunitiesUseCase,
} from '../../src/modules/communities/application/community.use-cases';
import { CommunitiesJournal } from '../../src/modules/communities/application/communities-journal';
import {
  GrantCapabilitiesUseCase,
  ListGrantsUseCase,
  RevokeGrantUseCase,
  TransferOwnershipUseCase,
} from '../../src/modules/communities/application/delegation.use-cases';
import {
  CreateInvitationUseCase,
  ListInvitationsUseCase,
  RedeemInvitationUseCase,
  RevokeInvitationUseCase,
} from '../../src/modules/communities/application/invitation.use-cases';
import {
  AddMembersUseCase,
  LeaveCommunityUseCase,
  ListMembersUseCase,
  RemoveMemberUseCase,
} from '../../src/modules/communities/application/membership.use-cases';
import type { CommunityCapability } from '../../src/modules/communities/contracts/capabilities';
import type {
  CommunityReadModel,
  CommunityStore,
} from '../../src/modules/communities/domain/ports';
import { CryptoInvitationSecrets } from '../../src/modules/communities/infrastructure/crypto-invitation-secrets';
import { InMemoryCommunityStore } from '../../src/modules/communities/infrastructure/in-memory-community-store';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import { AdjustableClock } from './identity-harness';
import { principalWith } from './principals';

export const META = { correlationId: 'test-request' } as const;

/** Ids that look like the uuids production uses — distinct, ordered, and never reused. */
export class SequentialIds implements IdGenerator {
  private n = 0;
  next<TBrand extends string>(): Id<TBrand> {
    this.n += 1;
    return asId<TBrand>(`00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`);
  }
}

/** One ordered record of the journal: audit entries and events, interleaved as written. */
export class Journal implements AuditLog, EventPublisher {
  readonly entries: AuditEntry[] = [];
  readonly events: DomainEvent[] = [];
  readonly order: string[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    this.order.push(`audit:${entry.action}`);
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.events.push(event);
      this.order.push(`event:${event.name}`);
    }
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }

  eventNames(): string[] {
    return this.events.map((event) => event.name);
  }

  clear(): void {
    this.entries.length = 0;
    this.events.length = 0;
    this.order.length = 0;
  }
}

/**
 * Identity's account directory as Communities sees it: names, whether an
 * account is ACTIVE, and — through the real provisional matrix — which
 * permissions its roles grant. Unknown ids are absent, as in production.
 */
export class StubAccounts implements AccountDirectory {
  private readonly accounts = new Map<
    string,
    {
      displayName: string;
      roles: KnownRoleCode[];
      active: boolean;
      /** Replaces what the roles grant — for combinations no provisional role has. */
      permissions?: readonly string[];
    }
  >();
  describeCalls = 0;

  add(userId: string, roles: readonly KnownRoleCode[], displayName = userId): void {
    this.accounts.set(userId, { displayName, roles: [...roles], active: true });
  }

  suspend(userId: string): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) account.active = false;
  }

  setRoles(userId: string, roles: readonly KnownRoleCode[]): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) account.roles = [...roles];
  }

  /** Exactly these permissions, whatever the account's roles say. */
  setPermissions(userId: string, permissions: readonly Permission[]): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) account.permissions = [...permissions];
  }

  async describe(userIds: readonly string[]): Promise<readonly AccountSummary[]> {
    this.describeCalls += 1;
    return userIds.flatMap((userId) => {
      const account = this.accounts.get(userId);
      return account === undefined
        ? []
        : [{ userId, displayName: account.displayName, active: account.active }];
    });
  }

  async withPermission(
    userIds: readonly string[],
    permission: Permission,
  ): Promise<ReadonlySet<string>> {
    return new Set(
      userIds.filter((userId) => {
        const account = this.accounts.get(userId);
        if (account === undefined || !account.active) return false;
        if (account.permissions !== undefined) return account.permissions.includes(permission);
        return account.roles.some((role) =>
          (PROVISIONAL_ROLE_PERMISSIONS[role] as readonly string[]).includes(permission),
        );
      }),
    );
  }
}

/**
 * Communities, assembled exactly as the module wires it without a database:
 * the in-memory store, identity's real policy, real token secrets, the
 * in-process rate limiter — and a clock and ids the test controls.
 */
export function communitiesHarness(
  options: {
    readonly identity?: AuthorizationService;
    /** Other adapters behind the ports — the Postgres suite passes its own. */
    readonly store?: CommunityStore;
    readonly readModel?: CommunityReadModel;
  } = {},
) {
  const clock = new AdjustableClock(new Date('2026-09-23T08:00:00.000Z'));
  const ids = new SequentialIds();
  const journal = new Journal();
  const accounts = new StubAccounts();
  const identity = options.identity ?? new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);
  const memory = new InMemoryCommunityStore();
  const store: CommunityStore = options.store ?? memory;
  const readModel: CommunityReadModel = options.readModel ?? memory;
  const secrets = new CryptoInvitationSecrets();
  const limiter = new InMemoryRateLimiter(clock);
  const communitiesJournal = new CommunitiesJournal(journal, journal);
  const authorization = new CommunityAuthorizationService(identity, store);
  const people = new CommunityPeople(accounts);

  const h = {
    clock,
    ids,
    journal,
    accounts,
    identity,
    store,
    readModel,
    secrets,
    limiter,
    authorization,
    membership: new CommunityMembershipService(readModel),
    holders: new CapabilityHoldersService(readModel, people),
    directory: new CommunityDirectoryService(readModel),
    create: new CreateCommunityUseCase(
      identity,
      authorization,
      store,
      limiter,
      clock,
      ids,
      communitiesJournal,
    ),
    get: new GetCommunityUseCase(authorization, clock, communitiesJournal),
    list: new ListCommunitiesUseCase(
      identity,
      authorization,
      store,
      readModel,
      clock,
      communitiesJournal,
    ),
    status: new ChangeCommunityStatusUseCase(authorization, store, clock, communitiesJournal),
    add: new AddMembersUseCase(
      authorization,
      people,
      store,
      limiter,
      clock,
      ids,
      communitiesJournal,
    ),
    remove: new RemoveMemberUseCase(authorization, store, clock, communitiesJournal),
    leave: new LeaveCommunityUseCase(authorization, store, clock, communitiesJournal),
    members: new ListMembersUseCase(authorization, people, readModel, clock, communitiesJournal),
    invite: new CreateInvitationUseCase(
      authorization,
      store,
      secrets,
      limiter,
      clock,
      ids,
      communitiesJournal,
    ),
    invitations: new ListInvitationsUseCase(authorization, readModel, clock, communitiesJournal),
    revoke: new RevokeInvitationUseCase(authorization, store, clock, communitiesJournal),
    redeem: new RedeemInvitationUseCase(
      identity,
      authorization,
      people,
      store,
      secrets,
      limiter,
      clock,
      ids,
      communitiesJournal,
    ),
    grant: new GrantCapabilitiesUseCase(
      authorization,
      people,
      store,
      limiter,
      clock,
      ids,
      communitiesJournal,
    ),
    revokeGrant: new RevokeGrantUseCase(authorization, store, clock, communitiesJournal),
    grants: new ListGrantsUseCase(authorization, people, readModel),
    transfer: new TransferOwnershipUseCase(authorization, people, store, clock, communitiesJournal),

    /** A signed-in person with these roles, known to the directory. */
    person(userId: string, roles: readonly KnownRoleCode[]): Principal {
      accounts.add(userId, roles);
      return principalWith(userId, roles);
    },

    /** A job with exactly these permissions and no stint anywhere. */
    system(name: string, permissions: readonly Permission[]): Principal {
      return systemPrincipal(name, permissions);
    },

    /** A community owned by `owner`, as the create use case makes it. */
    async community(owner: Principal, title = 'حلقة التجويد'): Promise<string> {
      const created = await h.create.execute({ principal: owner, title, meta: META });
      if (!created.ok) throw new Error(`could not create a community: ${created.error.code}`);
      return created.value.id;
    },

    /** Adds members through the use case, as the owner. */
    async addPeople(owner: Principal, communityId: string, ...userIds: string[]): Promise<void> {
      const added = await h.add.execute({ principal: owner, communityId, userIds, meta: META });
      if (!added.ok) throw new Error(`could not add members: ${added.error.code}`);
    },

    /**
     * Grants capabilities through the use case, as the owner; the ids of the
     * grants the member now holds for them, in the order named.
     */
    async delegate(
      owner: Principal,
      communityId: string,
      userId: string,
      ...capabilities: CommunityCapability[]
    ): Promise<string[]> {
      const granted = await h.grant.execute({
        principal: owner,
        communityId,
        userId,
        capabilities,
        meta: META,
      });
      if (!granted.ok) throw new Error(`could not grant: ${granted.error.code}`);
      const held = [...granted.value.view.created, ...granted.value.view.unchanged];
      return capabilities.map(
        (capability) => held.find((grant) => grant.capability === capability)?.grantId ?? '',
      );
    },

    /** A link's token, created by `owner`. */
    async link(
      owner: Principal,
      communityId: string,
      terms: { readonly expiresInSeconds?: number; readonly maxUses?: number | null } = {},
    ): Promise<{ readonly token: string; readonly invitationId: string }> {
      const created = await h.invite.execute({
        principal: owner,
        communityId,
        ...terms,
        meta: META,
      });
      if (!created.ok) throw new Error(`could not create a link: ${created.error.code}`);
      return { token: created.value.token, invitationId: created.value.invitation.id };
    },
  };
  return h;
}

export type CommunitiesHarness = ReturnType<typeof communitiesHarness>;

/** The failure code of a Result, or 'ok'. */
export const codeOf = (result: { ok: boolean; error?: { code: string } }): string =>
  result.ok ? 'ok' : (result.error?.code ?? 'unknown');
