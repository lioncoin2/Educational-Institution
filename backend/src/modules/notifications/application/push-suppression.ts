import { Inject, Injectable } from '@nestjs/common';

import type { NotificationTarget } from '../contracts/targets';
import { isPushMutedFor } from '../domain/conversation-mute';
import {
  CONVERSATION_MUTE_REPOSITORY,
  NOTIFICATION_SETTINGS_REPOSITORY,
  type ConversationMuteRepository,
  type NotificationSettingsRepository,
} from '../domain/ports';
import {
  DEFAULT_USER_NOTIFICATION_SETTINGS,
  quietHoursSuppressesPush,
  type InstitutionQuietHours,
  type UserNotificationSettings,
} from '../domain/quiet-hours';

const NO_CONVERSATIONS: ReadonlySet<string> = new Set();

/**
 * The one place that decides whether a notification's PUSH is held back —
 * quiet hours (by the clock, in the recipient's timezone) or a per-conversation
 * mute. It decides PUSH only: storing the record and the realtime decision are
 * the dispatcher's, and this never changes them.
 *
 * It is consulted once per dispatch: `forUsers` loads the institution policy,
 * the batch's settings and their mutes in one round each, and returns a gate
 * that answers for every notification in the batch without touching the
 * database again.
 */
@Injectable()
export class PushSuppressionGate {
  constructor(
    @Inject(NOTIFICATION_SETTINGS_REPOSITORY)
    private readonly settings: NotificationSettingsRepository,
    @Inject(CONVERSATION_MUTE_REPOSITORY)
    private readonly mutes: ConversationMuteRepository,
  ) {}

  async forUsers(userIds: readonly string[], now: Date): Promise<PushGate> {
    const [institution, userSettings, muted] = await Promise.all([
      this.settings.institution(),
      this.settings.settingsForUsers(userIds),
      this.mutes.mutedConversationsForUsers(userIds),
    ]);
    return new PushGate(institution, userSettings, muted, now);
  }
}

/** A decision for one dispatch, over data already loaded. */
export class PushGate {
  constructor(
    private readonly institution: InstitutionQuietHours | null,
    private readonly userSettings: ReadonlyMap<string, UserNotificationSettings>,
    private readonly muted: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly now: Date,
  ) {}

  /**
   * Whether this recipient's push for this target should be held. PUSH ONLY —
   * the record is stored and realtime decided regardless. There is no
   * always-deliver bypass: a suppressed push is suppressed.
   */
  suppressesPush(recipientUserId: string, target: NotificationTarget): boolean {
    const settings = this.userSettings.get(recipientUserId) ?? DEFAULT_USER_NOTIFICATION_SETTINGS;
    if (quietHoursSuppressesPush(this.institution, settings, this.now)) return true;
    return isPushMutedFor(target, this.muted.get(recipientUserId) ?? NO_CONVERSATIONS);
  }
}
