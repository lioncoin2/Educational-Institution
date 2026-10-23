import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { AcademicModule } from '../academic/academic.module';
import { FilesModule } from '../files/files.module';
import { IdentityModule } from '../identity/identity.module';
import { CommunitiesController } from './api/communities.controller';
import { CommunityGrantsController } from './api/community-grants.controller';
import { CommunityInvitationsController } from './api/community-invitations.controller';
import { CapabilityHoldersService } from './application/capability-holders.service';
import { CommunityAuthorizationService } from './application/community-authorization.service';
import { CommunityDirectoryService } from './application/community-directory.service';
import { CommunityMembershipService } from './application/community-membership.service';
import { CommunityPeople } from './application/community-people';
import { GetCommunityAvatarLinkUseCase } from './application/community-avatar-link.use-case';
import {
  ChangeCommunityStatusUseCase,
  CreateCommunityUseCase,
  EditCommunityProfileUseCase,
  GetCommunityUseCase,
  LinkCommunityHalaqaUseCase,
  ListCommunitiesUseCase,
  SetChatModeUseCase,
  UnlinkCommunityHalaqaUseCase,
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
import { SearchMemberCandidatesUseCase } from './application/member-candidates.use-case';
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
 * account, and may it take part?) and — since the owner approved the optional
 * halaqa link (Q50) — on academic's read-only `ACADEMIC_RELATIONSHIPS` contract
 * for one thing only: confirming a referenced halaqa EXISTS before a link is
 * stored (ADR 0033). It learns nothing else of academic — no enrollment, no
 * teaching, no roster. It also depends on files' `FILE_ASSETS` contract (ADR
 * 0037) to verify a community picture is an image the editor uploaded and to
 * mint a short-lived link to it — the same contract messaging uses for
 * attachments, and the dependency runs communities → files (files → identity,
 * never the reverse, so no cycle). No other module is reached: no chat, no live
 * session, no attendance; those modules ask Communities, never the reverse.
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
  imports: [IdentityModule, AcademicModule, FilesModule],
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
    LinkCommunityHalaqaUseCase,
    UnlinkCommunityHalaqaUseCase,
    EditCommunityProfileUseCase,
    GetCommunityAvatarLinkUseCase,
    SetChatModeUseCase,
    AddMembersUseCase,
    RemoveMemberUseCase,
    LeaveCommunityUseCase,
    ListMembersUseCase,
    SearchMemberCandidatesUseCase,
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
