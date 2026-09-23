import { asId } from '../../../shared';
import type { NotificationTarget } from '../contracts/targets';
import { NOTIFICATION_TYPES } from '../contracts/vocabulary';
import { ACTIVE_CATEGORIES, NOTIFICATION_CATALOG, bodyKeyOf, titleKeyOf } from './catalog';
import {
  createNotification,
  parseParams,
  parseTarget,
  type NotificationRequest,
} from './notification';
import { plainText } from './text';

const AT = new Date('2026-09-01T08:00:00Z');
const ID = asId<'Notification'>('n-1');

const valid: NotificationRequest = {
  recipientUserId: 'user-1',
  type: 'MESSAGE_RECEIVED',
  titleKey: 'notification.message_received.title',
  bodyKey: 'notification.message_received.body',
  params: { senderDisplayName: 'أحمد', messageType: 'TEXT', conversationType: 'GROUP' },
  target: { kind: 'conversation', conversationId: 'c-1' },
  dedupeKey: 'message:m-1:user:user-1',
};

const refusal = (request: Partial<NotificationRequest> | Record<string, unknown>) => {
  const result = createNotification({ ...valid, ...request }, ID, AT);
  return result.ok ? null : result.error.details?.field;
};

describe('a notification', () => {
  it('is created unread, with its category from the catalog', () => {
    const created = createNotification(valid, ID, AT);
    expect(created.ok && created.value).toEqual({
      id: ID,
      recipientUserId: 'user-1',
      type: 'MESSAGE_RECEIVED',
      category: 'MESSAGES',
      titleKey: 'notification.message_received.title',
      bodyKey: 'notification.message_received.body',
      params: { senderDisplayName: 'أحمد', messageType: 'TEXT', conversationType: 'GROUP' },
      target: { kind: 'conversation', conversationId: 'c-1' },
      dedupeKey: 'message:m-1:user:user-1',
      createdAt: AT,
      readAt: null,
    });
  });

  it('keeps nothing a request carries beyond the named fields', () => {
    const created = createNotification(
      {
        ...valid,
        target: { kind: 'conversation', conversationId: 'c-1' },
        params: { senderDisplayName: 'أحمد' },
        // Smuggled fields on the request itself are simply not read.
        ...({ category: 'ASSIGNMENTS', readAt: AT } as object),
      },
      ID,
      AT,
    );
    expect(created.ok && created.value.category).toBe('MESSAGES');
    expect(created.ok && created.value.readAt).toBeNull();
  });

  it('needs a real recipient account — not a system principal, not nothing', () => {
    expect(refusal({ recipientUserId: '' })).toBe('recipientUserId');
    expect(refusal({ recipientUserId: 'system:reminders' })).toBe('recipientUserId');
    expect(refusal({ recipientUserId: 'x'.repeat(129) })).toBe('recipientUserId');
  });

  it('refuses an unknown type, and a reserved one nothing may create yet', () => {
    expect(refusal({ type: 'SOMETHING_ELSE' })).toBe('type');
    for (const type of NOTIFICATION_TYPES.filter((t) => !NOTIFICATION_CATALOG[t].active)) {
      expect(refusal({ type, titleKey: titleKeyOf(type), bodyKey: bodyKeyOf(type) })).toBe('type');
    }
  });

  it("uses only its own type's templates", () => {
    expect(refusal({ titleKey: 'notification.assignment_created.title' })).toBe('titleKey');
    expect(refusal({ bodyKey: 'Hello, {name}' })).toBe('bodyKey');
    expect(refusal({ bodyKey: 'notification.message_received.' })).toBe('bodyKey');
  });

  it('leads only where its type leads, through a well-formed target', () => {
    expect(refusal({ target: { kind: 'assignment', assignmentId: 'a-1' } })).toBe('target');
    expect(refusal({ target: { kind: 'conversation' } as never })).toBe('target');
    expect(refusal({ target: { kind: 'url', href: 'https://evil.example' } as never })).toBe(
      'target',
    );
    expect(
      refusal({
        target: { kind: 'conversation', conversationId: 'c-1', href: 'https://x' } as never,
      }),
    ).toBe('target');
    expect(refusal({ target: { kind: 'conversation', conversationId: '../admin' } })).toBe(
      'target',
    );
  });

  it('takes a few plain values as parameters — never markup, structure or code', () => {
    expect(refusal({ params: { nested: { a: 1 } } as never })).toBe('params');
    expect(refusal({ params: { list: ['a'] } as never })).toBe('params');
    expect(refusal({ params: { fn: (() => 1) as never } })).toBe('params');
    expect(refusal({ params: { __proto__: 'x' } as never })).toBeNull(); // not an own key
    expect(refusal({ params: JSON.parse('{"__proto__":"x"}') as never })).toBe('params');
    expect(refusal({ params: { 'bad-name': 'x' } })).toBe('params');
    expect(refusal({ params: { name: 'line\nbreak' } })).toBe('params');
    expect(refusal({ params: { name: 'evil\u202eexe.jpg' } })).toBe('params');
    expect(refusal({ params: { name: '' } })).toBe('params');
    expect(refusal({ params: { name: 'x'.repeat(201) } })).toBe('params');
    expect(refusal({ params: { count: Number.NaN } })).toBe('params');
    expect(
      refusal({ params: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, i])) }),
    ).toBe('params');
    expect(refusal({ params: { count: 3, urgent: true, name: 'حلقة الفجر' } })).toBeNull();
  });

  it('needs a deduplication key', () => {
    expect(refusal({ dedupeKey: '' })).toBe('dedupeKey');
    expect(refusal({ dedupeKey: 'has spaces' })).toBe('dedupeKey');
    expect(refusal({ dedupeKey: 'x'.repeat(201) })).toBe('dedupeKey');
  });
});

describe('targets', () => {
  it('reads every kind back exactly, and nothing more', () => {
    const targets: NotificationTarget[] = [
      { kind: 'conversation', conversationId: 'c-1' },
      { kind: 'assignment', assignmentId: 'a-1' },
      { kind: 'announcement', announcementId: 'an-1' },
      { kind: 'certificate', certificateId: 'ce-1' },
      { kind: 'halaqa', halaqaId: 'h-1' },
      { kind: 'live_room', liveSessionId: 'l-1' },
      { kind: 'profile' },
    ];
    for (const target of targets) expect(parseTarget({ ...target })).toEqual(target);
    expect(parseTarget({ kind: 'profile', userId: 'someone-else' })).toBeNull();
    expect(parseTarget({ kind: 'toString' })).toBeNull();
    expect(parseTarget('conversation:c-1')).toBeNull();
    expect(parseTarget(null)).toBeNull();
  });
});

describe('parameters', () => {
  it('copies plain values into a fresh object', () => {
    const input = { name: 'أحمد', count: 2 };
    const parsed = parseParams(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it('makes a display name safe to show: no controls, no direction tricks, whole letters', () => {
    expect(plainText('  أحمد\n\tبن  علي ', 50)).toBe('أحمد بن علي');
    expect(plainText('evil\u202egpj.exe', 50)).toBe('evil gpj.exe');
    expect(plainText('a\u2066b\u2069c', 50)).toBe('a b c');
    // Right-to-left and left-to-right MARKS are ordinary Arabic typography.
    expect(plainText('أحمد\u200f', 50)).toBe('أحمد\u200f');
    expect(plainText('😀😀😀', 2)).toBe('😀😀');
  });
});

describe('the catalog', () => {
  it('offers preferences only for categories that have notifications today', () => {
    expect(ACTIVE_CATEGORIES).toEqual(['MESSAGES']);
  });

  it('gives every type its own templates', () => {
    expect(titleKeyOf('MESSAGE_RECEIVED')).toBe('notification.message_received.title');
    expect(bodyKeyOf('ADDED_TO_CONVERSATION')).toBe('notification.added_to_conversation.body');
  });
});
