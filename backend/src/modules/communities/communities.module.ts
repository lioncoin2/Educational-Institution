import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { IdentityModule } from '../identity/identity.module';
import { CommunitiesController } from './api/communities.controller';
import { CommunityGrantsController } from './api/community-grants.controller';
import { CommunityInvitationsController } from './api/community-invitations.controller';
import { CapabilityHoldersService } from './application/capability-holders.service';
import { CommunityAuthorizationService } from './application/community-authorization.service';
import { CommunityDirectoryService } from './application/community-directory.service';
import { CommunityMembershipService } from './application/community-membership.service';
import { CommunityPeople } from './application/community-people';
import {
  ChangeCommunityStatusUseCase,
  CreateCommunityUseCase,
  GetCommunityUseCase,
  ListCommunitiesUseCase,
} from './application/community.use-cases';
import { CommunitiesJournal } from './application/communities-journal';
import {
  GrantCapabilitiesUseCase,
  ListGrantsUseCase,
  RevokeGrantUseCase,
  TransferOwnershipUseCase,
} from './application/delegation.use-cases';
import {
  CreateInvitationUseCase,
  ListInvitationsUseCase,
  RedeemInvitationUseCase,
  RevokeInvitationUseCase,
} from './application/invitation.use-cases';
import {
  AddMembersUseCase,
  LeaveCommunityUseCase,
  ListMembersUseCase,
  RemoveMemberUseCase,
} from './application/membership.use-cases';
import { COMMUNITY_AUTHORIZATION } from './contracts/authorization';
import { COMMUNITY_CAPABILITY_HOLDERS } from './contracts/capability-holders';
import { COMMUNITY_DIRECTORY } from './contracts/directory';
import { COMMUNITY_MEMBERSHIP } from './contracts/membership';
import { INVITATION_SECRETS } from './domain/invitation';
import {
  COMMUNITY_READ_MODEL,
  COMMUNITY_STORE,
  type CommunityReadModel,
  type CommunityStore,
} from './domain/ports';
import { CryptoInvitationSecrets } from './infrastructure/crypto-invitation-secrets';
import { DrizzleCommunityReadModel } from './infrastructure/drizzle-community-read-model';
import { DrizzleCommunityRepository } from './infrastructure/drizzle-community-repository';
import { InMemoryCommunityStore } from './infrastructure/in-memory-community-store';

/**
 * Communities — persistent spaces (the brief's "groups") and who belongs to
 * them: membership stints, invitation links, the OPEN/LOCKED lifecycle,
 * capabilities the owner delegates to members, and ownership transfer.
 *
 * It depends on identity's contracts (may this principal…? who is this
 * account, and may it take part?) and on nothing else — no chat, no live
 * session, no attendance: those modules ask Communities, never the reverse.
 * It exports its four contracts only:
 *
 *   COMMUNITY_AUTHORIZATION       may this principal do this act in this community?
 *   COMMUNITY_MEMBERSHIP          who belongs — facts, for trusted consumers
 *   COMMUNITY_CAPABILITY_HOLDERS  who holds a capability by standing — the same
 *   COMMUNITY_DIRECTORY           what a community is called, for display
 *
 * Without a database it runs on one in-memory store (mock mode); with
 * Postgres, on the Drizzle adapters.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CommunitiesController, CommunityInvitationsController, CommunityGrantsController],
  providers: [
    // Without a database, one in-memory store serves both ports, so what is
    // written is what is read.
    InMemoryCommunityStore,
    {
      provide: COMMUNITY_STORE,
      inject: [APP_CONFIG, DATABASE, InMemoryCommunityStore],
      useFactory: (config: AppConfig, db: Database, memory: InMemoryCommunityStore) =>
        (config.database.configured
          ? new DrizzleCommunityRepository(db)
          : memory) satisfies CommunityStore,
    },
    {
      provide: COMMUNITY_READ_MODEL,
      inject: [APP_CONFIG, DATABASE, InMemoryCommunityStore],
      useFactory: (config: AppConfig, db: Database, memory: InMemoryCommunityStore) =>
        (config.database.configured
          ? new DrizzleCommunityReadModel(db)
          : memory) satisfies CommunityReadModel,
    },
    { provide: INVITATION_SECRETS, useClass: CryptoInvitationSecrets },

    CommunityAuthorizationService,
    CommunityPeople,
    CommunitiesJournal,
    CreateCommunityUseCase,
    GetCommunityUseCase,
    ListCommunitiesUseCase,
    ChangeCommunityStatusUseCase,
    AddMembersUseCase,
    RemoveMemberUseCase,
    LeaveCommunityUseCase,
    ListMembersUseCase,
    CreateInvitationUseCase,
    ListInvitationsUseCase,
    RevokeInvitationUseCase,
    RedeemInvitationUseCase,
    GrantCapabilitiesUseCase,
    RevokeGrantUseCase,
    ListGrantsUseCase,
    TransferOwnershipUseCase,

    { provide: COMMUNITY_AUTHORIZATION, useExisting: CommunityAuthorizationService },
    { provide: COMMUNITY_MEMBERSHIP, useClass: CommunityMembershipService },
    { provide: COMMUNITY_CAPABILITY_HOLDERS, useClass: CapabilityHoldersService },
    { provide: COMMUNITY_DIRECTORY, useClass: CommunityDirectoryService },
  ],
  exports: [
    COMMUNITY_AUTHORIZATION,
    COMMUNITY_MEMBERSHIP,
    COMMUNITY_CAPABILITY_HOLDERS,
    COMMUNITY_DIRECTORY,
  ],
})
export class CommunitiesModule {}
