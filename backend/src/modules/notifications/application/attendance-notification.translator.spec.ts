import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import {
  domainEvent,
  type DomainEvent,
  type EventSubscriber,
  type Principal,
} from '../../../shared';
import { AttendanceEvents } from '../../attendance/contracts';
import {
  MAX_HOLDER_PAGE,
  type CommunityCapabilityHolders,
  type CommunityCapability,
} from '../../communities/contracts';
import { AttendanceNotificationTranslator } from './attendance-notification.translator';

/**
 * A COMMUNITY_CAPABILITY_HOLDERS stand-in: holders by (community, capability),
 * keyset-paged at its own `pageSize` (short pages are legal per the contract),
 * so a handful of holders can exercise multi-page fan-out; `failFor` makes a
 * community's lookup reject, as a store failure would.
 */
class FakeCapabilityHolders implements CommunityCapabilityHolders {
  pageSize = MAX_HOLDER_PAGE;
  private readonly holders = new Map<string, readonly string[]>();
  private readonly failing = new Set<string>();

  setHolders(
    communityId: string,
    capability: CommunityCapability,
    userIds: readonly string[],
  ): void {
    this.holders.set(`${communityId}::${capability}`, userIds);
  }

  failFor(communityId: string): void {
    this.failing.add(communityId);
  }

  clearFailures(): void {
    this.failing.clear();
  }

  async list(
    communityId: string,
    capability: CommunityCapability,
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    if (this.failing.has(communityId)) throw new Error('capability holders unavailable');
    const all = this.holders.get(`${communityId}::${capability}`) ?? [];
    const start = page.cursor == null ? 0 : Number(page.cursor);
    const end = Math.min(start + Math.min(this.pageSize, page.limit), all.length);
    return { userIds: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  }
}

describe('attendance notifications', () => {
  let h: NotificationsHarness;
  let holders: FakeCapabilityHolders;
  let translator: AttendanceNotificationTranslator;
  let holder1: Principal;
  let holder2: Principal;
  let holder3: Principal;
  let recorder: Principal;
  let participant: Principal;

  const C = 'community-1';
  const S = 'session-1';
  const S2 = 'session-2';
  const VIEW: CommunityCapability = 'community.attendance.view';

  beforeEach(async () => {
    h = await notificationsHarness();
    holder1 = h.messaging.person('TEACHER', 'مشرف ١');
    holder2 = h.messaging.person('TEACHER', 'مشرف ٢');
    holder3 = h.messaging.person('TEACHER', 'مشرف ٣');
    recorder = h.messaging.person('TEACHER', 'المسجِّل');
    participant = h.messaging.person('STUDENT', 'طالب');
    holders = new FakeCapabilityHolders();
    holders.setHolders(C, VIEW, [holder1.userId, holder2.userId]);
    translator = new AttendanceNotificationTranslator(h.bus, holders, h.dispatcher);
    translator.onModuleInit();
  });

  afterEach(async () => {
    translator.onModuleDestroy();
    await h.cleanup();
  });

  const publish = async (event: DomainEvent): Promise<void> => {
    await h.bus.publish([event]);
    await translator.idle();
  };

  const snapshotIn = (liveSessionId: string, over: Record<string, unknown> = {}): DomainEvent =>
    domainEvent(
      AttendanceEvents.snapshotRecorded,
      liveSessionId,
      {
        snapshotId: 'snap-1',
        communityId: C,
        liveSessionId,
        recordedBy: recorder.userId,
        observedAt: h.clock.now().toISOString(),
        connectedCount: 3,
        connectingCount: 1,
        ...over,
      },
      h.clock.now(),
    );

  const snapshot = (over: Record<string, unknown> = {}): DomainEvent => snapshotIn(S, over);

  const attendanceOf = (p: Principal) =>
    h.inbox(p).then((ns) => ns.filter((n) => n.type === 'ATTENDANCE_SNAPSHOT_RECORDED'));

  it('one snapshot → one notification to every capability holder, pointing at the live room', async () => {
    await publish(snapshot());
    expect(await h.inbox(holder1)).toEqual([
      expect.objectContaining({
        type: 'ATTENDANCE_SNAPSHOT_RECORDED',
        category: 'ATTENDANCE',
        titleKey: 'notification.attendance_snapshot_recorded.title',
        bodyKey: 'notification.attendance_snapshot_recorded.body',
        params: {},
        target: { kind: 'live_room', liveSessionId: S },
      }),
    ]);
    expect((await attendanceOf(holder2)).map((n) => n.type)).toEqual([
      'ATTENDANCE_SNAPSHOT_RECORDED',
    ]);
    // A student/participant who holds nothing is not a recipient.
    expect(await h.inbox(participant)).toEqual([]);
  });

  it('walks every page of holders — a short page is not the end', async () => {
    holders.setHolders(C, VIEW, [holder1.userId, holder2.userId, holder3.userId]);
    holders.pageSize = 1; // three single-holder pages
    await publish(snapshot());
    for (const holder of [holder1, holder2, holder3]) {
      expect((await attendanceOf(holder)).map((n) => n.type)).toEqual([
        'ATTENDANCE_SNAPSHOT_RECORDED',
      ]);
    }
  });

  it('uses the per-session dedupe key, naming the session and recipient', async () => {
    await publish(snapshot());
    const stored = (await h.notifications.list(holder1.userId, { limit: 50 })).items;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.dedupeKey).toBe(`attendance:snapshot:${S}:user:${holder1.userId}`);
  });

  it('collapses every later snapshot of the SAME session to one notification per holder', async () => {
    await publish(snapshot({ snapshotId: 'snap-A' }));
    await publish(snapshot({ snapshotId: 'snap-A' })); // same fact redelivered
    await publish(snapshot({ snapshotId: 'snap-B' })); // a distinct snapshot, same session
    await publish(snapshot({ snapshotId: 'snap-C' })); // and another
    expect(await attendanceOf(holder1)).toHaveLength(1);
    expect(await attendanceOf(holder2)).toHaveLength(1);
  });

  it('notifies separately for a distinct live session', async () => {
    await publish(snapshotIn(S, { snapshotId: 'snap-A' }));
    await publish(snapshotIn(S2, { snapshotId: 'snap-B' }));
    expect(await attendanceOf(holder1)).toHaveLength(2);
  });

  it('does not suppress a recorder who is also a holder', async () => {
    holders.setHolders(C, VIEW, [holder1.userId, recorder.userId]);
    await publish(snapshot({ recordedBy: recorder.userId }));
    expect((await attendanceOf(recorder)).map((n) => n.type)).toEqual([
      'ATTENDANCE_SNAPSHOT_RECORDED',
    ]);
    expect((await attendanceOf(holder1)).map((n) => n.type)).toEqual([
      'ATTENDANCE_SNAPSHOT_RECORDED',
    ]);
  });

  it('ignores a malformed fact instead of guessing', async () => {
    await translator.translate(
      domainEvent(AttendanceEvents.snapshotRecorded, S, { communityId: C }, h.clock.now()),
    );
    await translator.translate(
      domainEvent(AttendanceEvents.snapshotRecorded, S, null, h.clock.now()),
    );
    expect(await h.inbox(holder1)).toEqual([]);
    expect(h.published.published).toEqual([]);
  });

  it('handles a holder-contract failure the way every translator does — logged, not thrown', async () => {
    holders.failFor(C);
    await publish(snapshot()); // schedule()'s catch swallows the rejection
    expect(await h.inbox(holder1)).toEqual([]);
    // The subscriber survives: once the lookup works again, a later session delivers.
    holders.clearFailures();
    await publish(snapshotIn(S2, { snapshotId: 'snap-B' }));
    expect((await attendanceOf(holder1)).map((n) => n.type)).toEqual([
      'ATTENDANCE_SNAPSHOT_RECORDED',
    ]);
  });

  it('leaves the dispatcher to skip an account that may not sign in', async () => {
    h.messaging.directory.deactivate(holder2.userId);
    await publish(snapshot());
    expect((await attendanceOf(holder1)).map((n) => n.type)).toEqual([
      'ATTENDANCE_SNAPSHOT_RECORDED',
    ]);
    expect(await h.inbox(holder2)).toEqual([]);
  });

  it('subscribes only to attendance.snapshot.recorded', () => {
    const names: string[] = [];
    const recording: EventSubscriber = {
      subscribe: (name) => {
        names.push(name);
        return () => {};
      },
    };
    const probe = new AttendanceNotificationTranslator(recording, holders, h.dispatcher);
    probe.onModuleInit();
    expect(names).toEqual([AttendanceEvents.snapshotRecorded]);
    probe.onModuleDestroy();
  });

  it('leaves the existing messaging notifications working', async () => {
    const group = await h.messaging.group(holder1, [participant]);
    await h.settle();
    await h.messaging.text(holder1, group.id, 'السلام عليكم');
    await h.settle();
    expect((await h.inbox(participant)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(
      1,
    );
  });
});
