import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import {
  COMMUNITY_MEMBERSHIP,
  MAX_MEMBER_PAGE,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import { MESSAGING_READ_MODEL, type MessagingReadModel } from '../domain/ports';
import { COMMUNITY_CHAT_SETTINGS, type CommunityChatSettings } from './community-chat-settings';
import { CommunityChatSync } from './community-chat-sync';

export interface SweepReport {
  /** Communities looked at. */
  readonly communities: number;
  /** Chats missing or behind their community's head: handed to the sync. */
  readonly behind: number;
  /** Chats ahead of their community's head: handed to the sync, which rebuilds them. */
  readonly ahead: number;
}

/**
 * The backstop that makes a lost wake-up harmless (community-chat.md §7.5):
 * at boot and every `sweepIntervalMs` (60 s, PROVISIONAL Q26) it pages every
 * community's head, 1,000 at a time, and reads the chats of that page in one
 * lookup — two statements per 1,000 communities:
 *
 *   no chat, or projected behind the head  →  the sync (which materializes)
 *   projected ahead of the head            →  the sync, which rebuilds it
 *                                             (the reconciler, in its worker)
 *
 * Stateless: a failed tick is logged and the next starts from the first
 * page. Correctness never depends on it — every request asks Communities —
 * but if it stopped, new members would miss frames, notifications and list
 * entries until they open the chat.
 */
@Injectable()
export class CommunityChatSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CommunityChatSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<SweepReport | null> | undefined;

  constructor(
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly sync: CommunityChatSync,
    @Inject(COMMUNITY_CHAT_SETTINGS) private readonly settings: CommunityChatSettings,
  ) {}

  onApplicationBootstrap(): void {
    // The boot sweep: after a restart the in-memory schedule is gone, and
    // this finds every lag it left behind.
    void this.tick();
    if (this.settings.sweepIntervalMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.settings.sweepIntervalMs);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
  }

  /** One sweep; single-flight, never throws (null when it failed), awaitable by tests. */
  tick(): Promise<SweepReport | null> {
    this.running ??= this.sweep()
      .catch((error: unknown) => {
        this.logger.warn(
          { err: { name: error instanceof Error ? error.name : typeof error } },
          'community chat sweep failed; the next tick starts over',
        );
        return null;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async sweep(): Promise<SweepReport> {
    let communities = 0;
    let behind = 0;
    let ahead = 0;
    let after: string | undefined;
    do {
      const page = await this.membership.listHeads({
        afterCommunityId: after,
        limit: MAX_MEMBER_PAGE,
      });
      const chats = await this.readModel.communityChatsFor(
        page.items.map((head) => head.communityId),
      );
      const byCommunity = new Map(chats.map((chat) => [chat.communityId, chat]));
      for (const head of page.items) {
        communities += 1;
        const chat = byCommunity.get(head.communityId);
        if (chat === undefined || chat.projectedVersion < head.membershipVersion) {
          behind += 1;
          this.sync.schedule(head.communityId);
        } else if (chat.projectedVersion > head.membershipVersion) {
          ahead += 1;
          this.sync.schedule(head.communityId);
        }
      }
      after = page.next ?? undefined;
    } while (after !== undefined);
    const report = { communities, behind, ahead };
    if (behind > 0 || ahead > 0)
      this.logger.log(report, 'community chat sweep found lagging chats');
    return report;
  }
}
