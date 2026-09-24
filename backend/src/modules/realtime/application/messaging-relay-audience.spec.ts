import { connectDevice, type FakeLink } from '../../../../test/support/realtime-harness';
import { InProcessEventBus } from '../../../platform/events/event-bus';
import { domainEvent } from '../../../shared';
import {
  MAX_RECIPIENT_PAGE,
  MessagingEvents,
  type MessageDelivery,
  type MessageRecipients,
  type MessageView,
  type RecipientPage,
} from '../../messaging/contracts';
import { ConnectionManager } from './connection-manager';
import { MessagingRealtimeRelay } from './messaging-relay';

/** A deterministic generator, so a failure is reproducible from its seed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const AT = new Date('2026-09-24T10:00:00.000Z');
const CONVERSATION = 'channel-1';
const SEQUENCE = 42;
const SENDER = 'u-000000';
const idOf = (n: number) => `u-${n.toString().padStart(6, '0')}`;

type ListOptions = Parameters<MessageRecipients['list']>[1];

/**
 * MESSAGE_RECIPIENTS as messaging answers it: current members in id order,
 * keyset pages, `visibleSequence` hiding those who joined after a message,
 * `onlyUserIds` narrowing a page, and refusing what messaging refuses.
 * Every call is recorded with the options it was given.
 */
class FakeRecipients implements MessageRecipients {
  readonly calls: ListOptions[] = [];
  private readonly sorted: readonly { userId: string; hiddenThrough: number }[];
  private readonly byId: ReadonlyMap<string, { userId: string; hiddenThrough: number }>;

  constructor(members: readonly { userId: string; hiddenThrough: number }[]) {
    this.sorted = [...members].sort((a, b) => (a.userId < b.userId ? -1 : 1));
    this.byId = new Map(members.map((member) => [member.userId, member]));
  }

  async list(conversationId: string, options: ListOptions): Promise<RecipientPage> {
    this.calls.push(options);
    if (conversationId !== CONVERSATION) return { userIds: [], nextCursor: null };
    if (options.onlyUserIds !== undefined && options.onlyUserIds.length > MAX_RECIPIENT_PAGE) {
      throw new RangeError('At most 1000 users may be named at once.');
    }
    const cursor = options.cursor ?? null;
    const visible = (member: { userId: string; hiddenThrough: number }) =>
      (cursor === null || member.userId > cursor) &&
      (options.visibleSequence === undefined || member.hiddenThrough < options.visibleSequence);
    // One more than the page, as an index scan reads it: is there a next page?
    const matching: string[] = [];
    if (options.onlyUserIds !== undefined) {
      for (const userId of [...new Set(options.onlyUserIds)].sort()) {
        const member = this.byId.get(userId);
        if (member !== undefined && visible(member)) matching.push(userId);
        if (matching.length > options.limit) break;
      }
    } else {
      for (let i = this.after(cursor); i < this.sorted.length; i++) {
        const member = this.sorted[i];
        if (member !== undefined && visible(member)) matching.push(member.userId);
        if (matching.length > options.limit) break;
      }
    }
    const userIds = matching.slice(0, options.limit);
    return {
      userIds,
      nextCursor: matching.length > options.limit ? (userIds[userIds.length - 1] ?? null) : null,
    };
  }

  /** The index of the first member after `cursor` — a binary search, as a B-tree seeks. */
  private after(cursor: string | null): number {
    if (cursor === null) return 0;
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.sorted[middle]?.userId ?? '') <= cursor) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

const view = (clientMessageId: string | null): MessageView => ({
  id: 'message-1',
  conversationId: CONVERSATION,
  sequence: SEQUENCE,
  senderId: SENDER,
  type: 'TEXT',
  body: 'السلام عليكم',
  replyToMessageId: null,
  clientMessageId,
  createdAt: AT,
  editedAt: null,
  deletedAt: null,
  attachments: [],
});

const delivery: MessageDelivery = {
  message: async () => ({
    forSender: view('client-key-0001'),
    forMembers: view(null),
    sender: { userId: SENDER, displayName: 'المعلّم' },
  }),
  position: async () => {
    throw new Error('not asked here');
  },
};

const sent = domainEvent(
  MessagingEvents.messageSent,
  CONVERSATION,
  {
    conversationId: CONVERSATION,
    conversationType: 'CHANNEL',
    messageId: 'message-1',
    sequence: SEQUENCE,
    senderId: SENDER,
    messageType: 'TEXT',
  },
  AT,
);

const created = domainEvent(
  MessagingEvents.conversationCreated,
  CONVERSATION,
  {
    conversationId: CONVERSATION,
    conversationType: 'CHANNEL',
    createdBy: SENDER,
    participantCount: 3,
  },
  AT,
);

/**
 * The walk the relay made before G1, kept here as the oracle: every page of
 * recipients, filtered by who is online.
 */
async function oldWalk(
  recipients: MessageRecipients,
  connections: ConnectionManager,
  visibleSequence?: number,
): Promise<string[]> {
  const online: string[] = [];
  let cursor: string | null = null;
  do {
    const page: RecipientPage = await recipients.list(CONVERSATION, {
      visibleSequence,
      cursor,
      limit: MAX_RECIPIENT_PAGE,
    });
    online.push(...page.userIds.filter((userId) => connections.isOnline(userId)));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return online;
}

function world(members: readonly { userId: string; hiddenThrough: number }[]) {
  const recipients = new FakeRecipients(members);
  const connections = new ConnectionManager();
  const relay = new MessagingRealtimeRelay(
    new InProcessEventBus(),
    recipients,
    delivery,
    connections,
  );
  const links = new Map<string, FakeLink>();
  const online = (userIds: readonly string[]) => {
    for (const userId of userIds) {
      if (!links.has(userId)) links.set(userId, connectDevice(connections, userId));
    }
  };
  const reached = (type: string) =>
    [...links].filter(([, link]) => link.ofType(type).length > 0).map(([userId]) => userId);
  return { recipients, connections, relay, links, online, reached };
}

/**
 * Gate G1 (community-chat.md §12.5; ADR 0021 decision 7): the messaging
 * relay asks MESSAGE_RECIPIENTS only about the accounts connected here —
 * at most 1 + ⌈A/1000⌉ calls instead of every page — and reaches exactly
 * whom the old walk reached.
 */
describe('the messaging relay’s audience, bounded by who is online (G1)', () => {
  const thirtyThousand = Array.from({ length: 30_000 }, (_, n) => ({
    userId: idOf(n),
    // Every tenth joined after the message: its history window hides it.
    hiddenThrough: n % 10 === 9 ? SEQUENCE + 5 : 0,
  }));

  it.each([
    [50, 2],
    [2500, 4],
  ])(
    'tells %i people online among 30,000 recipients in at most %i calls, not every page',
    async (count, calls) => {
      const w = world(thirtyThousand);
      w.online(Array.from({ length: count }, (_, n) => idOf(n * 11)));
      const expected = await oldWalk(w.recipients, w.connections, SEQUENCE);
      // The old walk: a call per page of the 27,000 who can see the message.
      expect(w.recipients.calls).toHaveLength(27);
      w.recipients.calls.length = 0;

      await w.relay.relay(sent);

      expect(w.recipients.calls.length).toBeLessThanOrEqual(calls);
      expect(w.recipients.calls.length).toBeLessThanOrEqual(1 + Math.ceil(count / 1000));
      // Messaging's own filter goes on every call, the chunked ones included.
      expect(w.recipients.calls.every((call) => call.visibleSequence === SEQUENCE)).toBe(true);
      expect(w.reached('message.sent').sort()).toEqual([...expected].sort());
      // Someone who joined after the message is online, and is not told.
      expect(w.links.get(idOf(9 * 11))?.ofType('message.sent')).toEqual([]);
    },
  );

  it('asks one page — nothing more — of a conversation that fits one', async () => {
    const w = world([
      { userId: SENDER, hiddenThrough: 0 },
      { userId: idOf(1), hiddenThrough: 0 },
    ]);
    w.online([SENDER, idOf(1), 'stranger']);

    await w.relay.relay(created);

    expect(w.recipients.calls).toEqual([
      { visibleSequence: undefined, onlyUserIds: undefined, cursor: null, limit: 1000 },
    ]);
    expect(w.reached('conversation.created').sort()).toEqual([SENDER, idOf(1)]);
  });

  /**
   * The property: for any channel of 0–30,000 recipients (some outside the
   * message's history window) and 0–10,000 accounts online, members or not,
   * `message.sent` and `conversation.created` reach exactly the old walk's
   * set, the sender's devices with their own rendering, within the bound.
   */
  it('reaches exactly whom the old walk reached, for 40 seeded channels', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const size = Math.floor(next() * 30_001);
      const members = Array.from({ length: size }, (_, n) => ({
        userId: idOf(n),
        hiddenThrough: next() < 0.1 ? SEQUENCE + 1 : 0,
      }));
      const w = world(members);
      const onlineCount = Math.floor(next() * 10_001);
      w.online(
        Array.from({ length: onlineCount }, () =>
          next() < 0.7 && size > 0
            ? idOf(Math.floor(next() * size))
            : `stranger-${Math.floor(next() * 50_000)}`,
        ),
      );
      const accounts = w.connections.onlineUserIds().length;

      for (const [event, type, visibleSequence] of [
        [sent, 'message.sent', SEQUENCE],
        [created, 'conversation.created', undefined],
      ] as const) {
        const expected = [...(await oldWalk(w.recipients, w.connections, visibleSequence))].sort();
        w.recipients.calls.length = 0;
        await w.relay.relay(event);

        expect({ seed, type, reached: w.reached(type).sort() }).toEqual({
          seed,
          type,
          reached: expected,
        });
        expect({
          seed,
          type,
          bounded: w.recipients.calls.length <= 1 + Math.ceil(accounts / 1000),
        }).toEqual({ seed, type, bounded: true });
        if (accounts === 0)
          expect({ seed, calls: w.recipients.calls }).toEqual({ seed, calls: [] });
      }
      // Each reached once, and the sender's devices with the sender's rendering.
      const wrong = [...w.links].filter(([userId, link]) => {
        const frames = link.ofType('message.sent');
        const key = (frames[0]?.message as { clientMessageId: string | null } | undefined)
          ?.clientMessageId;
        return (
          frames.length > 1 ||
          (frames.length === 1 && key !== (userId === SENDER ? 'client-key-0001' : null))
        );
      });
      expect({ seed, wrong }).toEqual({ seed, wrong: [] });
    }
  }, 60_000);
});
