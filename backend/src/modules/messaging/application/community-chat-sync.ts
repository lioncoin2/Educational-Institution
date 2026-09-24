import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  CLOCK,
  EVENT_SUBSCRIBER,
  ID_GENERATOR,
  type Clock,
  type DomainEvent,
  type EventSubscriber,
  type IdGenerator,
  type Unsubscribe,
} from '../../../shared';
import { CommunityEvents } from '../../communities/contracts/events';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import { MAX_APPLY_BATCH } from '../domain/community-chat';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type CommunityChatRef,
  type MessagingReadModel,
  type MessagingRepository,
} from '../domain/ports';
import { memberStateOf } from './community-calls';
import { SYNC_CONCURRENCY } from './community-chat-settings';

/** What one pass over a community found. */
export type SyncOutcome =
  /** The projection reflects every change the authority reported. */
  | 'current'
  /** Communities knows no such community: nothing is created, nothing applied. */
  | 'unknown_community'
  /** The projection is AHEAD of the authority — restored from a backup: the reconciler's. */
  | 'ahead';

/** A pass stops after this many pages and is run again: no community holds the worker forever. */
const MAX_PAGES_PER_PASS = 100;

/**
 * Keeps each community chat's projection current (community-chat.md §7.5).
 *
 * Woken by `communities.member.added` and `.removed` — reading nothing from
 * them but the community id — and by access refusals, the lag filter and the
 * sweeper. A wake-up only schedules: the in-process bus awaits handlers, so
 * a Communities request never waits on messaging's work. The truth is then
 * PULLED: `changesSince(community, projected)` a page of at most 1,000
 * states at a time, each page one apply. Wake-ups may be lost, duplicated,
 * reordered or forged in process; none of that matters, because nothing
 * but the pulled states is ever applied and every apply is idempotent.
 *
 * One pass at a time per community: a wake-up during a pass sets a rerun
 * flag, so a storm of 100 wake-ups costs at most two passes. At most
 * SYNC_CONCURRENCY communities are synced at once, so the background never
 * takes more than its share of the connection pool.
 *
 * Nothing here publishes an event or writes an audit entry: membership
 * facts are Communities', and an apply is derived state.
 */
@Injectable()
export class CommunityChatSync implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommunityChatSync.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  /** Waiting for a worker, in arrival order. */
  private readonly pending = new Set<string>();
  /** Being synced now, and whether it was woken again meanwhile. */
  private readonly running = new Map<string, { rerun: boolean }>();
  private readonly workers = new Set<Promise<void>>();
  private passCount = 0;
  private stopped = false;

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  onModuleInit(): void {
    for (const name of [CommunityEvents.memberAdded, CommunityEvents.memberRemoved]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.wake(event)));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.pending.clear();
    await this.idle();
  }

  /** Passes run so far — for tests and metrics. */
  get passes(): number {
    return this.passCount;
  }

  /** Asks for a pass over this community's chat soon; returns at once. */
  schedule(communityId: string): void {
    // Shutting down: the boot sweep of the next process finds whatever is left.
    if (this.stopped) return;
    const run = this.running.get(communityId);
    if (run !== undefined) {
      run.rerun = true;
      return;
    }
    this.pending.add(communityId);
    this.pump();
  }

  /** Resolves once nothing is pending or running — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.workers.size > 0) await Promise.all([...this.workers]);
  }

  /**
   * One pass, now, awaited: materialize the chat if the community has none,
   * then pull and apply until the projection reflects everything the
   * authority reported. The sweeper and tests call it through `schedule`;
   * it is public so a caller that must wait can.
   */
  async syncCommunity(communityId: string): Promise<SyncOutcome> {
    let chat: CommunityChatRef | null = await this.readModel.communityChat(communityId);
    let projected = chat?.projectedVersion ?? 0;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
      // Fetch first, lock second: Communities is never asked while the
      // conversation row is held, so no lock spans the two modules.
      const changes = await this.membership.changesSince(communityId, projected, MAX_APPLY_BATCH);
      if (changes === null) return 'unknown_community';
      if (projected > changes.head.membershipVersion) return 'ahead';
      if (chat === null) {
        // The community exists (it answered): its chat is materialized
        // here, idempotently — a racing materialization returns the same one.
        const created = await this.repository.materializeCommunityChat({
          id: this.ids.next<'Conversation'>(),
          communityId,
          at: this.clock.now(),
        });
        chat = {
          conversationId: created.id,
          communityId,
          projectedVersion: created.projectedMembershipVersion ?? 0,
        };
      }
      if (changes.states.length === 0 && changes.throughVersion <= projected) return 'current';

      const applied = await this.repository.applyCommunityMembership({
        conversationId: chat.conversationId,
        states: changes.states.map(memberStateOf),
        advance: { from: projected, to: changes.throughVersion },
        at: this.clock.now(),
      });
      if (applied.kind !== 'applied') return 'unknown_community';
      // Another applier may already be further; the reconciler may have
      // lowered it (then the contiguity check held it back, and the next
      // page starts from where it really is).
      projected = applied.projectedVersion;
      if (!changes.hasMore && projected >= changes.throughVersion) return 'current';
    }
    // A very long backlog: yield the worker, and come back for the rest.
    this.schedule(communityId);
    return 'current';
  }

  /** A wake-up: only the community id is read from it. */
  private wake(event: DomainEvent): void {
    const payload = event.payload as { readonly communityId?: unknown } | null | undefined;
    const communityId = payload?.communityId;
    if (typeof communityId === 'string' && communityId.length > 0) {
      this.schedule(communityId);
    } else {
      this.logger.warn({ event: event.name }, 'ignoring a malformed community event');
    }
  }

  private pump(): void {
    while (this.running.size < SYNC_CONCURRENCY && this.pending.size > 0) {
      const communityId = this.pending.values().next().value as string;
      this.pending.delete(communityId);
      const run = { rerun: false };
      this.running.set(communityId, run);
      const worker: Promise<void> = this.loop(communityId, run).finally(() => {
        this.running.delete(communityId);
        this.workers.delete(worker);
        this.pump();
      });
      this.workers.add(worker);
    }
  }

  private async loop(communityId: string, run: { rerun: boolean }): Promise<void> {
    do {
      run.rerun = false;
      this.passCount += 1;
      try {
        const outcome = await this.syncCommunity(communityId);
        if (outcome === 'ahead') {
          this.logger.warn(
            { communityId },
            'community chat projection is ahead of Communities; the sweeper will reconcile it',
          );
        }
      } catch (error) {
        // Stateless: the next wake-up, access refusal or sweep starts over.
        this.logger.warn(
          { communityId, err: { name: error instanceof Error ? error.name : typeof error } },
          'community chat sync failed; it will be retried',
        );
      }
    } while (run.rerun);
  }
}
