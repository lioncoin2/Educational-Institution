import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../../files/contracts/file-assets';
import type { FileKind } from '../../files/contracts/file-kind';
import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
} from '../../identity/contracts';
import type { LiveSession } from '../domain/live-session';
import {
  LIVE_SESSION_REPOSITORY,
  PRESENTER_GRANT_REPOSITORY,
  type LiveSessionRepository,
  type PresenterGrantRepository,
} from '../domain/ports';
import { LiveAccess } from './live-access';
import { LiveRefusals, isLiveId } from './live-settings';
import { LiveStanding } from './live-standing';

const NO_AVATAR = failure('not_found', 'live.participant_avatar_not_found', 'No profile picture.');
const AVATAR_KINDS: readonly FileKind[] = ['IMAGE'];

/**
 * A short-lived link to a live session participant's profile picture (C15,
 * ADR 0048) — so the live room shows each person's real picture wherever it
 * already shows who they are, through the one source every other surface uses:
 * identity's `avatarFileAssetId`, verified by Files, minted as Files' 5-minute
 * link (ADR 0038). Live keeps no copy of a picture or a link.
 *
 * Whose picture a caller may have is exactly whose identity the room already
 * shows them, never more:
 *
 *   1. identity's `files.read` (the route also asks `live.join`); a malformed
 *      session or person id → 404, before any store call;
 *   2. the session → 404; the caller may see it (`LiveAccess.viewer`) → else
 *      the same 404 an unknown session is;
 *   3. the person is the caller, the session's host or one of its current
 *      presenters — the people the session view names to every viewer; or the
 *      caller moderates the session and the person may take part in it now
 *      (`community.live.remain`, or a moderator) — the named roster and hands
 *      queue are moderators' alone (Q68). Anyone else → no picture (404), so
 *      a listener learns nothing about who else is a member;
 *   4. identity's directory gives the person's picture reference; Files
 *      confirms it is still an image that person owns before the link is
 *      minted, so a reference since cleared or replaced cannot leak. No
 *      picture → 404, and the room shows initials.
 *
 * Not audited and announces nothing: a read. An ended session's people stay
 * as visible as the session itself.
 */
@Injectable()
export class GetLiveParticipantAvatarUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
    private readonly access: LiveAccess,
    private readonly standing: LiveStanding,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(PRESENTER_GRANT_REPOSITORY) private readonly presenters: PresenterGrantRepository,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly userId: string;
  }): Promise<Result<DownloadLink>> {
    const { principal, sessionId, userId } = query;
    const readsFiles = this.identity.authorize(principal, Permissions.files.read);
    if (!readsFiles.ok) return readsFiles;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    if (!isLiveId(userId)) return err(NO_AVATAR);

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const viewer = await this.access.viewer(principal, session, LiveRefusals.sessionNotFound);
    if (!viewer.ok) return viewer;

    if (!(await this.shown(principal, session, userId, viewer.value.moderator !== null))) {
      return err(NO_AVATAR);
    }

    const [person] = await this.directory.describe([userId]);
    if (person === undefined || person.avatarFileAssetId === null) return err(NO_AVATAR);
    const verified = await this.files.verifyAttachable(
      person.avatarFileAssetId,
      userId,
      AVATAR_KINDS,
    );
    if (!verified.ok) return err(NO_AVATAR);
    const link = await this.files.createDownloadLink(person.avatarFileAssetId);
    return link.ok ? ok(link.value) : err(NO_AVATAR);
  }

  /** Step 3: whether the room already shows this caller who `userId` is. */
  private async shown(
    principal: Principal,
    session: LiveSession,
    userId: string,
    moderator: boolean,
  ): Promise<boolean> {
    if (userId === principal.userId || userId === session.hostUserId) return true;
    const presenting = await this.presenters.activeGrants(session.id);
    if (presenting.some((grant) => grant.userId === userId)) return true;
    if (!moderator) return false;
    const standing = (await this.standing.ofAccounts(session, [userId])).get(userId);
    return standing?.eligible === true;
  }
}
