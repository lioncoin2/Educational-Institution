import type { ConversationId, MessageId } from './ids';
import {
  asSeen,
  mediaDraft,
  normalizeBody,
  sameContent,
  textDraft,
  validateClientMessageId,
  type Message,
} from './message';
import { MESSAGE_BODY_MAX_LENGTH } from './messaging-policy';

const base = {
  id: 'm-1' as MessageId,
  conversationId: 'c-1' as ConversationId,
  senderId: 'u-1',
  clientMessageId: '6f1c2c1e-6c8e-4b3a-9f0e-8a1b2c3d4e5f',
  replyToMessageId: null,
  at: new Date('2026-09-01T08:00:00Z'),
};

const stored = (draft: ReturnType<typeof textDraft>): Message => {
  if (!draft.ok) throw new Error(draft.error.code);
  return { ...draft.value, sequence: 1, editedAt: null, deletedAt: null };
};

describe('message bodies', () => {
  it('normalizes line endings and strips control characters, keeping tabs and newlines', () => {
    expect(normalizeBody('  a\r\nb\rc\td\u0000e\u0007  ')).toBe('a\nb\nc\tde');
  });

  // Mixed Arabic and Latin text needs direction marks to render correctly.
  it('keeps direction marks in message text', () => {
    expect(normalizeBody('سورة‏ 2:255')).toBe('سورة‏ 2:255');
  });

  it('treats whitespace-only as no body', () => {
    expect(normalizeBody(' \n\t ')).toBeNull();
    expect(normalizeBody(undefined)).toBeNull();
  });
});

describe('typed drafts', () => {
  it('requires text in a text message', () => {
    const result = textDraft({ ...base, body: '   ' });
    expect(!result.ok && result.error.code).toBe('messaging.body_required');
  });

  it('bounds the body in code points, not UTF-16 units', () => {
    expect(textDraft({ ...base, body: 'ب'.repeat(MESSAGE_BODY_MAX_LENGTH) }).ok).toBe(true);
    const tooLong = textDraft({ ...base, body: '😀'.repeat(MESSAGE_BODY_MAX_LENGTH + 1) });
    expect(!tooLong.ok && tooLong.error.code).toBe('messaging.body_too_long');
    // 4000 emoji are 8000 UTF-16 units — and still exactly at the limit.
    expect(textDraft({ ...base, body: '😀'.repeat(MESSAGE_BODY_MAX_LENGTH) }).ok).toBe(true);
  });

  it('carries media as one attachment with an optional caption', () => {
    const result = mediaDraft({ ...base, type: 'VOICE', fileAssetId: 'asset-1' });
    expect(result.ok && result.value).toMatchObject({
      type: 'VOICE',
      body: null,
      attachments: [{ fileAssetId: 'asset-1', position: 0 }],
    });
  });

  it.each(['short', 'has space inside it', 'x'.repeat(65), 'ümlaut-12345', ''])(
    'refuses the client message id %j',
    (clientMessageId) => {
      expect(validateClientMessageId(clientMessageId).ok).toBe(false);
      expect(textDraft({ ...base, clientMessageId, body: 'hi' }).ok).toBe(false);
    },
  );
});

describe('idempotent retries', () => {
  it('recognizes a retry of the same message', () => {
    const original = stored(textDraft({ ...base, body: 'hello' }));
    const retry = textDraft({ ...base, id: 'm-2' as MessageId, body: 'hello' });
    expect(retry.ok && sameContent(original, retry.value)).toBe(true);
  });

  it('refuses to call different content with the same key the same message', () => {
    const original = stored(textDraft({ ...base, body: 'hello' }));
    const other = textDraft({ ...base, body: 'goodbye' });
    expect(other.ok && sameContent(original, other.value)).toBe(false);
  });
});

describe('tombstones', () => {
  it('shows that a deleted message existed, and nothing of what it said', () => {
    const message = stored(textDraft({ ...base, body: 'secret' }));
    const deleted = { ...message, deletedAt: new Date('2026-09-02T00:00:00Z') };
    expect(asSeen(deleted)).toMatchObject({ body: null, attachments: [], sequence: 1 });
    expect(asSeen(message)).toBe(message);
  });
});
