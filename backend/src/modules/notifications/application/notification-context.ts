import { Inject, Injectable } from '@nestjs/common';

import {
  MAX_NOTIFICATION_CONTEXT_REFS,
  MESSAGE_NOTIFICATION_CONTEXT,
  type MessageNotificationContext,
  type NotificationContextRef,
} from '../../messaging/contracts';
import type { NotificationView } from '../contracts/notification-reader';
import { NotificationLimits } from '../domain/notification-policy';
import { plainText } from '../domain/text';

/**
 * Notification content, resolved when a notification is SHOWN (owner decision
 * E, ADR 0046) — never stored with it. A stored notification about a
 * conversation holds ids, codes and the actor's name, as before; when its
 * recipient lists their inbox, or a realtime frame renders it, messaging is
 * asked what this recipient may be shown NOW, and the answer fills two
 * read-time params:
 *
 *   conversationTitle  the group's, channel's or community's title
 *   messagePreview     the start of the message's text or caption
 *
 * Messaging answers only for a recipient who may read the conversation now —
 * so a member removed since, a revoked account, a deleted message or one
 * from before their history window shows nothing more than the content-free
 * text it was created with, and an edit shows its new text. Nothing here
 * reaches a push: a lock screen says only what kind of thing happened
 * (`pushMessageFor`, ADR 0046 keeps Q24's lock-screen default).
 *
 * The only code besides the messaging translator that knows messaging exists.
 */
@Injectable()
export class NotificationContextResolver {
  constructor(
    @Inject(MESSAGE_NOTIFICATION_CONTEXT) private readonly messaging: MessageNotificationContext,
  ) {}

  async withContext(views: readonly NotificationView[]): Promise<NotificationView[]> {
    const byRecipient = new Map<string, NotificationContextRef[]>();
    for (const view of views) {
      const ref = refOf(view);
      if (ref === null) continue;
      const refs = byRecipient.get(view.recipientUserId) ?? [];
      refs.push(ref);
      byRecipient.set(view.recipientUserId, refs);
    }
    if (byRecipient.size === 0) return [...views];

    const contexts = new Map<string, { title: string | null; preview: string | null }>();
    for (const [recipientUserId, refs] of byRecipient) {
      const unique = [...new Map(refs.map((ref) => [keyOf(recipientUserId, ref), ref])).values()];
      for (let i = 0; i < unique.length; i += MAX_NOTIFICATION_CONTEXT_REFS) {
        const chunk = unique.slice(i, i + MAX_NOTIFICATION_CONTEXT_REFS);
        for (const context of await this.messaging.forRecipient(recipientUserId, chunk)) {
          contexts.set(keyOf(recipientUserId, context), {
            title: context.conversationTitle,
            preview: context.messagePreview,
          });
        }
      }
    }

    return views.map((view) => {
      const ref = refOf(view);
      const context = ref === null ? undefined : contexts.get(keyOf(view.recipientUserId, ref));
      if (context === undefined) return view;
      const title = shown(context.title);
      const preview = shown(context.preview);
      if (title === null && preview === null) return view;
      return {
        ...view,
        params: {
          ...view.params,
          ...(title === null ? {} : { conversationTitle: title }),
          ...(preview === null ? {} : { messagePreview: preview }),
        },
      };
    });
  }
}

/** The conversation a notification leads to, and its message for MESSAGE_RECEIVED. */
function refOf(view: NotificationView): NotificationContextRef | null {
  if (view.target.kind !== 'conversation') return null;
  const messageId = view.type === 'MESSAGE_RECEIVED' ? view.params.messageId : undefined;
  if (view.type === 'MESSAGE_RECEIVED' && typeof messageId !== 'string') {
    // Created before ADR 0046: the inbox knows which conversation, not which
    // message — it may still be titled, never previewed.
    return { conversationId: view.target.conversationId, messageId: null };
  }
  return {
    conversationId: view.target.conversationId,
    messageId: typeof messageId === 'string' ? messageId : null,
  };
}

const keyOf = (recipientUserId: string, ref: NotificationContextRef) =>
  `${recipientUserId}|${ref.conversationId}|${ref.messageId ?? ''}`;

/** A read-time value as plain text, the way every stored param already is. */
function shown(value: string | null): string | null {
  if (value === null) return null;
  const text = plainText(value, NotificationLimits.maxParamTextLength);
  return text.length === 0 ? null : text;
}
