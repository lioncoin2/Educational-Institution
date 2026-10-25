import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/theme/messaging_palette.dart';
import '../../core/widgets/foundations/app_avatar.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../data/models/communities.dart';
import '../../data/models/messaging.dart';
import '../../providers/app_providers.dart';
import '../communities/state/community_controller.dart';
import '../live/state/live_session_controller.dart';
import 'messaging_copy.dart';
import '../../data/models/notifications.dart';
import 'state/conversation_controller.dart';
import 'state/conversation_list_controller.dart';
import 'state/conversation_mutes_controller.dart';
import 'state/direct_message_starter.dart';
import 'widgets/composer.dart';
import 'widgets/connection_banner.dart';
import 'widgets/message_bubble.dart';

/// One conversation: its timeline, newest at the bottom, and the composer.
class ConversationScreen extends ConsumerStatefulWidget {
  const ConversationScreen({super.key, required this.conversationId});

  final String conversationId;

  @override
  ConsumerState<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends ConsumerState<ConversationScreen> {
  /// The watermark when the screen opened: messages after it get a
  /// "new messages" divider, which stays put while the watermark moves.
  int? _unreadAfter;

  /// Attached to the pinned message's bubble, so the banner can scroll to it.
  final GlobalKey _pinnedKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    final provider = conversationProvider(widget.conversationId);
    final value = ref.watch(provider);

    // Whatever is on screen counts as read — once it is on screen. The
    // provider is auto-disposed, so every opening goes loading → data and
    // this fires for it.
    ref.listen(provider, (previous, next) {
      final state = next.value;
      if (state == null) return;
      _unreadAfter ??= state.lastReadSequence;
      if (state.newestSequence > state.lastReadSequence) {
        ref.read(provider.notifier).markLatestRead();
      }
    });

    final conversation = value.value?.conversation;
    // Moderation authority is a COMMUNITY capability (ADR 0029), surfaced only
    // on the community's `me` — never on the conversation. For a community
    // chat, ask the community whether this viewer may moderate; the server
    // still re-checks every delete. Not a community chat → never offered.
    final communityId = conversation?.communityId;
    final canModerate = communityId == null
        ? false
        : ref.watch(
            communityProvider(communityId).select(
              (state) =>
                  state.value?.community?.me.has(
                    CommunityCapability.messagesModerate,
                  ) ??
                  false,
            ),
          );
    // Whether THIS viewer may post, and how posting stands here — for a
    // community chat this is the authoritative signal (ADR 0039 `me.canPost`):
    // an open-group member posts on membership without holding
    // `community.chat.post`, so the conversation's own `canPost` (which still
    // asks the capability) is not enough. The UI only reflects it; the server
    // re-authorises every send. Null for a direct conversation — there the
    // conversation's own `canPost` governs, unchanged.
    final communityPosting = communityId == null
        ? null
        : ref.watch(
            communityProvider(communityId).select((state) {
              final community = state.value?.community;
              return (
                canPost: community?.canPost ?? false,
                isChannel: community?.isChannel ?? false,
                isRestrictedGroup: community?.isRestrictedGroup ?? false,
              );
            }),
          );
    // Starting a direct conversation (Q6, owner GROUP A ruling): offered on a
    // co-member's name in a group or community chat, to a viewer whose account
    // may start one (a student → another student; staff → anyone). The server
    // decides who they may actually reach, so this only governs the affordance.
    final canStartDm = ref.watch(
      sessionUserProvider.select(
        (user) =>
            user.value?.can('messaging.start_direct_peer') == true ||
            user.value?.can('messaging.start_direct') == true,
      ),
    );
    // Per-conversation PUSH mute (Q6 / ADR 0036), the viewer's own choice.
    // Backend-only (the server stores it); the server re-checks every change.
    final backend = ref.watch(backendModeProvider);
    final muted =
        ref
            .watch(conversationMutesProvider)
            // Only this account's settled set — never a rebuild's `previous`.
            .asData
            ?.value
            .contains(widget.conversationId) ??
        false;
    // The conversation surface presents itself in the institution's green
    // (the shared [InstitutionGreenPalette]), cohesive with Home and مساري,
    // rather than the app's global plum — scoped here, below the nav shell, so
    // no other tab is touched. (Conversation-colour cohesion request.)
    final scaffold = Scaffold(
      appBar: AppBar(
        title: _title(conversation),
        actions: [
          if (backend && conversation != null)
            IconButton(
              key: const Key('conversation-mute-toggle'),
              tooltip: muted ? MessagingCopy.unmute : MessagingCopy.mute,
              onPressed: () => _toggleMute(muted),
              icon: Icon(
                muted
                    ? Icons.notifications_off_outlined
                    : Icons.notifications_none_rounded,
              ),
            ),
          IconButton(
            tooltip: 'تحديث',
            onPressed: () => ref.read(provider.notifier).refreshNewer(),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: AsyncView(
        value: value,
        onRetry: () => ref.invalidate(provider),
        builder: (context, state) {
          // Whether to offer the composer. The conversation's own `canPost`
          // governs a direct conversation, and a community publisher (a holder
          // of `community.chat.post`) in any mode. On top of that, a plain
          // member of an OPEN group posts on membership alone (ADR 0039) — a
          // case the conversation's capability-based `canPost` may miss — so
          // the community's `me.canPost` opens it too, but only while the group
          // is open (its mode is a stable fact, so this can never wrongly offer
          // a composer in a channel or a restricted group). The server
          // re-authorises every send regardless. The same gate offers the reply
          // long-press.
          final canPostHere =
              !state.removed &&
              (state.conversation.canPost ||
                  ((communityPosting?.canPost ?? false) &&
                      !(communityPosting?.isChannel ?? false) &&
                      !(communityPosting?.isRestrictedGroup ?? false)));
          final pinnedId = state.conversation.pinnedMessageId;
          return Column(
            children: [
              if (communityId != null)
                _LiveNowBanner(communityId: communityId),
              const ConnectionBanner(),
              // The pinned-message banner (ADR 0043): a compact bar under the
              // header, its preview resolved from the loaded timeline like a
              // reply quote. When the pinned message is not loaded (or removed),
              // `pinned` is null and the banner shows the pin-specific truthful
              // fallback. Only moderators (canModerate) may unpin.
              if (pinnedId != null)
                _PinnedBanner(
                  pinned:
                      state.messages.any((m) => m.id == pinnedId)
                      ? _repliedById(
                          pinnedId,
                          {for (final m in state.messages) m.id: m},
                          state,
                        )
                      : null,
                  canUnpin: canModerate,
                  onTap: () => _scrollToPinned(pinnedId),
                  onUnpin: () => _unpin(),
                ),
              Expanded(
                child: _Timeline(
                  state: state,
                  unreadAfter: _unreadAfter,
                  canReply: canPostHere,
                  canModerate: canModerate,
                  canStartDm: canStartDm,
                  pinnedMessageId: pinnedId,
                  pinnedKey: _pinnedKey,
                  onPin: _pin,
                  onUnpin: _unpin,
                ),
              ),
              if (state.removed)
                const _Notice(
                  icon: Icons.person_off_outlined,
                  text: 'لم تعد عضوًا في هذه المحادثة.',
                )
              else if (canPostHere)
                Composer(
                  replyDraft: state.replyDraft,
                  onCancelReply: () =>
                      ref.read(provider.notifier).cancelReply(),
                  onSendText: (text) =>
                      ref.read(provider.notifier).sendText(text),
                  onSendFile: (file) =>
                      ref.read(provider.notifier).sendFile(file),
                )
            // Read-only, and why — as much as is known without guessing. A
            // channel reserves posting for the owner and publishers; a
            // restricted group limits it to its moderators; otherwise the
            // chat may be locked or simply not the viewer's to post in, and
            // the server does not say which, so neither does the screen.
            else if (communityPosting?.isChannel ?? false)
              const _Notice(
                key: Key('conversation-read-only'),
                icon: Icons.campaign_outlined,
                text: MessagingCopy.channelReadOnly,
              )
            else if (communityPosting?.isRestrictedGroup ?? false)
              const _Notice(
                key: Key('conversation-read-only'),
                icon: Icons.edit_off_outlined,
                text: MessagingCopy.groupRestrictedReadOnly,
              )
            else if (state.conversation.isCommunityChat)
              const _Notice(
                key: Key('conversation-read-only'),
                icon: Icons.lock_outline_rounded,
                text: MessagingCopy.cannotPostHere,
              )
              else
                const _Notice(
                  icon: Icons.campaign_outlined,
                  text: 'هذه قناة إعلانات: يمكنك القراءة فقط.',
                ),
            ],
          );
        },
      ),
    );
    return Theme(
      data: MessagingPalette.themeOf(context),
      child: scaffold,
    );
  }

  /// The app-bar title. For a community's chat it is a tappable header —
  /// the community's picture and name — that opens the community's own info &
  /// management page (the one the communities tab already uses, never a second
  /// one). What that page then offers is the server's `me` to decide, not this
  /// screen's. For any other conversation the title is plain text.
  Widget _title(Conversation? conversation) {
    if (conversation == null) {
      return const Text(
        MessagingCopy.conversationFallbackTitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
    }

    final label = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          conversation.title ?? MessagingCopy.conversationFallbackTitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        Text(
          MessagingCopy.conversationSubtitle(conversation),
          style: context.text.labelSmall,
        ),
      ],
    );

    final communityId = conversation.communityId;
    // Every chat carries an avatar: the community's picture for a community
    // chat, the title's initials otherwise (no counterpart picture is fetched
    // for a direct chat, so none is invented).
    final header = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AppAvatar(
          name: conversation.title,
          imageUrl: communityId == null
              ? null
              : ref.watch(communityAvatarUrlProvider(communityId)).value,
          radius: 18,
        ),
        const SizedBox(width: Insets.sm),
        Flexible(child: label),
      ],
    );

    // Only a community chat's header is a button into the community page.
    if (communityId == null) return header;
    return InkWell(
      key: const Key('conversation-community-header'),
      onTap: () => context.push(Routes.community(communityId)),
      child: Semantics(
        button: true,
        label: MessagingCopy.communityInfo,
        child: header,
      ),
    );
  }

  /// Flips this conversation's PUSH mute through the controller (optimistic,
  /// reverts on failure), and says what changed. The server is the authority.
  Future<void> _toggleMute(bool muted) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(conversationMutesProvider.notifier)
          .setMuted(widget.conversationId, !muted);
      messenger.toast(muted ? MessagingCopy.unmuted : MessagingCopy.muted);
    } on NotificationsException {
      messenger.toast(MessagingCopy.muteToggleFailed);
    }
  }

  /// Pins [messageId] through the controller; the banner follows the server's
  /// authoritative re-read. A refusal is said through its code.
  Future<void> _pin(String messageId) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(conversationProvider(widget.conversationId).notifier).pinMessage(messageId);
      messenger.toast(MessagingCopy.pinDone);
    } on MessagingException catch (error) {
      messenger.toast(MessagingCopy.error(error.code));
    }
  }

  Future<void> _unpin() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(conversationProvider(widget.conversationId).notifier).unpinMessage();
      messenger.toast(MessagingCopy.unpinDone);
    } on MessagingException catch (error) {
      messenger.toast(MessagingCopy.error(error.code));
    }
  }

  /// Brings the pinned message into view. If it is not in the loaded page, older
  /// history is loaded (bounded) until it is; a still-unavailable target (far
  /// back, or deleted and purged) is reported truthfully, never faked.
  Future<void> _scrollToPinned(String messageId) async {
    final provider = conversationProvider(widget.conversationId);
    final messenger = ScaffoldMessenger.of(context);
    bool loaded() =>
        ref.read(provider).value?.messages.any((m) => m.id == messageId) ?? false;
    var guard = 0;
    while (!loaded() && (ref.read(provider).value?.hasOlder ?? false) && guard < 20) {
      guard += 1;
      await ref.read(provider.notifier).loadOlder();
    }
    if (!mounted) return;
    if (!loaded()) {
      messenger.toast(MessagingCopy.pinnedUnavailable);
      return;
    }
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) return;
    final target = _pinnedKey.currentContext;
    if (target != null && target.mounted) {
      await Scrollable.ensureVisible(
        target,
        alignment: 0.3,
        duration: Motion.card,
      );
    } else {
      // Loaded but not built (far up a long timeline): tell the viewer it is
      // now in the history to scroll to, rather than jumping unpredictably.
      messenger.toast(MessagingCopy.pinLoading);
    }
  }
}

/// The pinned-message banner (ADR 0043): a compact, distinct bar under the
/// header showing the single pinned message's sender and a one-line preview,
/// resolved from the loaded timeline (never fabricated — a target outside the
/// window reads "unavailable"). Tapping scrolls to the message; a moderator may
/// unpin from here. Hidden entirely when nothing is pinned (the caller decides).
class _PinnedBanner extends StatelessWidget {
  const _PinnedBanner({
    required this.pinned,
    required this.canUnpin,
    required this.onTap,
    required this.onUnpin,
  });

  final RepliedMessage? pinned;
  final bool canUnpin;
  final VoidCallback onTap;
  final VoidCallback onUnpin;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Material(
      key: const Key('pinned-message-banner'),
      color: colors.surfaceContainerHigh,
      child: InkWell(
        onTap: onTap,
        child: Semantics(
          button: true,
          label: MessagingCopy.pinnedTitle,
          child: Padding(
            padding: const EdgeInsetsDirectional.only(
              start: Insets.md,
              end: Insets.xs,
              top: Insets.sm,
              bottom: Insets.sm,
            ),
            child: Row(
              children: [
                Container(
                  width: 3,
                  height: 34,
                  margin: const EdgeInsetsDirectional.only(end: Insets.sm),
                  decoration: BoxDecoration(
                    color: colors.primary,
                    borderRadius: Radii.pill,
                  ),
                ),
                Icon(Icons.push_pin_rounded, size: 18, color: colors.primary),
                const SizedBox(width: Insets.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        pinned?.senderName ?? MessagingCopy.pinnedTitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.labelSmall?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        pinned?.preview ?? MessagingCopy.pinnedUnavailable,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                if (canUnpin)
                  IconButton(
                    key: const Key('pinned-message-unpin'),
                    tooltip: MessagingCopy.unpinTooltip,
                    visualDensity: VisualDensity.compact,
                    onPressed: onUnpin,
                    icon: const Icon(Icons.close_rounded),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A "live now" bar under the app bar of a community chat, shown only while the
/// server reports a running session for THIS community.
///
/// It watches [liveSessionProvider], which is the authority (an HTTP read of
/// the community's current session) and keeps itself fresh on its own: it
/// re-reads on a realtime `live.session.started`/`ended` hint and on every
/// reconnect, so the bar appears when a session starts and disappears when it
/// ends or the app comes back after being away — never on a loading or error
/// guess (it shows only a confirmed live session), and never another
/// community's session (the provider is keyed by this community's id).
///
/// Tapping it opens the EXISTING live screen for the same community; if no
/// session is live there is nothing to tap and no screen opens. The bar states
/// that a session is running — it makes no claim that audio or video work,
/// which depends on the media provider and is the live screen's to report.
class _LiveNowBanner extends ConsumerWidget {
  const _LiveNowBanner({required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(liveSessionProvider(communityId)).value;
    if (session == null || !session.isLive) return const SizedBox.shrink();

    // A prominent gradient "live now" banner (reference panel 1). Static: it
    // sits in a chat timeline, and a pulsing animation would be noise and never
    // let a `pumpAndSettle` test settle. The real speaker count only — no
    // fabricated audience number or avatar stack.
    final count = session.speakerCount;
    const gradient = LinearGradient(
      begin: AlignmentDirectional.centerStart,
      end: AlignmentDirectional.centerEnd,
      colors: [Color(0xFFD1356F), Color(0xFF8A3FC0)],
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(Insets.md, Insets.sm, Insets.md, Insets.sm),
      child: Material(
        color: Colors.transparent,
        borderRadius: Radii.brLg,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const Key('community-live-indicator'),
          // Opens the live session AND joins its audio directly (Telegram-style).
          onTap: () =>
              context.push(Routes.communityLive(communityId, autoJoin: true)),
          child: Semantics(
            button: true,
            label: MessagingCopy.liveNowSemantics,
            child: Ink(
              decoration: const BoxDecoration(gradient: gradient),
              child: Padding(
                padding: const EdgeInsets.all(Insets.md),
                child: Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.22),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.sensors_rounded,
                        size: 20,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: Insets.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            MessagingCopy.liveNow,
                            style: context.text.labelLarge?.copyWith(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            MessagingCopy.liveNowHint,
                            style: context.text.labelSmall?.copyWith(
                              color: Colors.white.withValues(alpha: 0.92),
                            ),
                          ),
                          if (count > 0) ...[
                            const SizedBox(height: Insets.xs),
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(
                                  Icons.graphic_eq_rounded,
                                  size: 13,
                                  color: Colors.white70,
                                ),
                                const SizedBox(width: Insets.xs),
                                Text(
                                  '$count',
                                  style: context.text.labelSmall?.copyWith(
                                    color: Colors.white70,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: Insets.sm),
                    Container(
                      width: 28,
                      height: 28,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.25),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.chevron_left,
                        size: 18,
                        color: Colors.white,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Timeline extends ConsumerWidget {
  const _Timeline({
    required this.state,
    required this.unreadAfter,
    this.canReply = false,
    this.canModerate = false,
    this.canStartDm = false,
    this.pinnedMessageId,
    this.pinnedKey,
    this.onPin,
    this.onUnpin,
  });

  final ConversationState state;
  final int? unreadAfter;

  /// The pinned message's id (ADR 0043), and the key to attach to its bubble so
  /// the banner can scroll to it.
  final String? pinnedMessageId;
  final GlobalKey? pinnedKey;

  /// Pin a message / clear the pin (moderators), or null when the viewer may not.
  final void Function(String messageId)? onPin;
  final VoidCallback? onUnpin;

  /// The viewer may post here, so a long-press offers a reply. Matches exactly
  /// the condition that shows the composer; the server re-authorises the send.
  final bool canReply;

  /// The viewer may moderate this community chat (ADR 0029): a delete on any
  /// message, and a review of a deleted one. Always false outside a community
  /// chat, and for a member without the capability.
  final bool canModerate;

  /// The viewer's account may start a direct conversation (Q6): a student with
  /// another student, staff with anyone. Makes a co-member's name in a group or
  /// community chat tappable; the server still decides who they may reach.
  final bool canStartDm;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(
      conversationProvider(state.conversation.id).notifier,
    );
    if (state.messages.isEmpty && state.pending.isEmpty) {
      return Center(
        child: Text(
          'لا توجد رسائل بعد. ابدأ المحادثة.',
          style: context.text.bodyMedium,
        ),
      );
    }

    final showNames = state.conversation.type != ConversationType.direct;
    // One representative message per sender that has a picture, so every bubble
    // of that sender resolves the one link (not one fetch per message).
    final avatarMessageId = <String, String>{};
    if (showNames) {
      for (final m in state.messages) {
        if (!state.isMine(m) &&
            state.senderAvatarAssets[m.senderId] != null) {
          avatarMessageId.putIfAbsent(m.senderId, () => m.id);
        }
      }
    }
    // Consecutive messages from the same sender read as one block: the later
    // ones drop the sender header and sit closer. Keyed by id so the reversed
    // render below stays unchanged.
    final byId = {for (final m in state.messages) m.id: m};
    final continuesRun = <String, bool>{};
    for (var j = 0; j < state.messages.length; j++) {
      final previous = j > 0 ? state.messages[j - 1] : null;
      continuesRun[state.messages[j].id] =
          previous != null &&
          previous.senderId == state.messages[j].senderId;
    }
    final firstUnread = state.messages
        .where(
          (m) =>
              unreadAfter != null &&
              m.sequence > unreadAfter! &&
              !state.isMine(m),
        )
        .firstOrNull;
    // Newest first, because the list is reversed: it opens at the bottom and
    // stays anchored there as messages arrive.
    final entries = <Widget>[
      for (final pending in state.pending.reversed)
        PendingBubble(
          key: ValueKey('pending-${pending.clientMessageId}'),
          pending: pending,
          repliedTo: _repliedById(pending.replyToMessageId, byId, state),
          onRetry: () => notifier.retry(pending.clientMessageId),
          onDiscard: () => notifier.discard(pending.clientMessageId),
        ),
      for (final message in state.messages.reversed) ...[
        MessageBubble(
          key: message.id == pinnedMessageId && pinnedKey != null
              ? pinnedKey
              : ValueKey(message.id),
          message: message,
          mine: state.isMine(message),
          senderName: showNames && !state.isMine(message)
              ? state.senderNames[message.senderId]
              : null,
          showHeader: !(continuesRun[message.id] ?? false),
          groupedWithPrevious: continuesRun[message.id] ?? false,
          repliedTo: _repliedFor(message, byId, state),
          onPin:
              canModerate &&
                  !message.isDeleted &&
                  message.id != pinnedMessageId &&
                  onPin != null
              ? () => onPin!(message.id)
              : null,
          onUnpin: canModerate && message.id == pinnedMessageId
              ? onUnpin
              : null,
          onReply: canReply && !message.isDeleted
              ? () => notifier.startReply(
                  ReplyDraft(
                    targetId: message.id,
                    senderName: state.isMine(message)
                        ? MessagingCopy.you
                        : state.senderNames[message.senderId],
                    preview: MessagingCopy.quotePreview(message),
                  ),
                )
              : null,
          senderAvatarUrl: avatarMessageId[message.senderId] != null
              ? ref
                    .watch(
                      senderAvatarUrlProvider((
                        conversationId: state.conversation.id,
                        messageId: avatarMessageId[message.senderId]!,
                      )),
                    )
                    .value
              : null,
          // Tapping a co-member's name starts a direct conversation with them
          // (Q6), when the viewer's account may and the name is known. The
          // server decides who they may actually reach — the UI is not the gate.
          onTapAuthor:
              canStartDm &&
                  showNames &&
                  !state.isMine(message) &&
                  state.senderNames[message.senderId] != null
              ? () => _messageAuthor(
                  context,
                  ref,
                  message.senderId,
                  state.senderNames[message.senderId]!,
                )
              : null,
          // A moderator may delete a live message, or review a tombstoned one
          // (ADR 0029). The server re-authorizes every call regardless.
          onModerateDelete: canModerate && !message.isDeleted
              ? () =>
                    _moderateDelete(context, ref, state.conversation.id, message.id)
              : null,
          onReview: canModerate && message.isDeleted
              ? () => _review(context, ref, state.conversation.id, message.id)
              : null,
        ),
        if (message == firstUnread) const _UnreadDivider(),
      ],
    ];

    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.md,
        vertical: Insets.sm,
      ),
      itemCount: entries.length + 1,
      itemBuilder: (context, index) {
        if (index < entries.length) return entries[index];
        return _OlderMessages(state: state);
      },
    );
  }
}

/// The top of the timeline: loads older messages as it scrolls into view.
/// The quote for a reply, resolved from the real `replyToMessageId`: the
/// original's sender (when it is in the loaded window and not the reader's own)
/// and a one-line preview. Null when the message is not a reply. Outside the
/// window the reference is kept but shown without a name — never invented.
RepliedMessage? _repliedFor(
  Message message,
  Map<String, Message> byId,
  ConversationState state,
) => _repliedById(message.replyToMessageId, byId, state);

/// The quote for a reply id. Null when there is no reply; a truthful
/// "unavailable" quote when the target is outside the loaded window or removed.
RepliedMessage? _repliedById(
  String? replyId,
  Map<String, Message> byId,
  ConversationState state,
) {
  if (replyId == null) return null;
  final original = byId[replyId];
  if (original == null) {
    return const RepliedMessage(preview: MessagingCopy.quoteUnavailable);
  }
  return RepliedMessage(
    senderName: state.isMine(original)
        ? MessagingCopy.you
        : state.senderNames[original.senderId],
    preview: MessagingCopy.quotePreview(original),
  );
}

class _OlderMessages extends ConsumerStatefulWidget {
  const _OlderMessages({required this.state});

  final ConversationState state;

  @override
  ConsumerState<_OlderMessages> createState() => _OlderMessagesState();
}

class _OlderMessagesState extends ConsumerState<_OlderMessages> {
  @override
  void initState() {
    super.initState();
    if (widget.state.hasOlder && !widget.state.olderFailed) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          ref
              .read(conversationProvider(widget.state.conversation.id).notifier)
              .loadOlder();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (!state.hasOlder) {
      return Padding(
        padding: const EdgeInsets.all(Insets.lg),
        child: Center(
          child: Text('بداية المحادثة', style: context.text.labelSmall),
        ),
      );
    }
    if (state.loadingOlder) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: () => ref
            .read(conversationProvider(state.conversation.id).notifier)
            .loadOlder(),
        child: Text(
          state.olderFailed
              ? 'تعذّر التحميل — إعادة المحاولة'
              : 'عرض الرسائل الأقدم',
        ),
      ),
    );
  }
}

class _UnreadDivider extends StatelessWidget {
  const _UnreadDivider();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.sm),
      child: Row(
        children: [
          Expanded(child: Divider(color: context.colors.primary)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Insets.sm),
            child: Text(
              'رسائل جديدة',
              style: context.text.labelSmall?.copyWith(
                color: context.colors.primary,
              ),
            ),
          ),
          Expanded(child: Divider(color: context.colors.primary)),
        ],
      ),
    );
  }
}

/// Where the composer would be, when there is nothing to compose.
class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text, super.key});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.colors.surfaceContainerLow,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(Insets.lg),
          child: Row(
            children: [
              Icon(icon, color: context.colors.onSurfaceVariant),
              const SizedBox(width: Insets.sm),
              Expanded(child: Text(text, style: context.text.bodySmall)),
            ],
          ),
        ),
      ),
    );
  }
}

/// Deletes a message as a moderator (ADR 0029): confirm first, then the
/// controller tombstones it on success. The server re-authorizes; a refusal is
/// said through its code, nothing local changes then.
Future<void> _moderateDelete(
  BuildContext context,
  WidgetRef ref,
  String conversationId,
  String messageId,
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      scrollable: true,
      title: const Text(MessagingCopy.moderateDeleteTitle),
      content: const Text(MessagingCopy.moderateDeleteBody),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text(MessagingCopy.moderateCancel),
        ),
        TextButton(
          style: TextButton.styleFrom(foregroundColor: context.colors.error),
          onPressed: () => Navigator.pop(context, true),
          child: const Text(MessagingCopy.moderateDeleteConfirm),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  try {
    await ref
        .read(conversationProvider(conversationId).notifier)
        .moderateDelete(messageId);
    messenger.toast(MessagingCopy.moderateDeleteDone);
  } on MessagingException catch (error) {
    messenger.toast(MessagingCopy.error(error.code));
  }
}

/// Reveals a deleted message's original (ADR 0029 §21.3) in a dialog — its
/// content, who deleted it, and how many attachments it carried. Past the
/// 7-day window, or with no such deleted message, the server refuses and the
/// refusal is said through its code.
Future<void> _review(
  BuildContext context,
  WidgetRef ref,
  String conversationId,
  String messageId,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final ReviewedMessage reviewed;
  try {
    reviewed = await ref
        .read(conversationProvider(conversationId).notifier)
        .reviewMessage(messageId);
  } on MessagingException catch (error) {
    messenger.toast(MessagingCopy.error(error.code));
    return;
  }
  if (!context.mounted) return;
  final body = reviewed.body;
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      scrollable: true,
      title: const Text(MessagingCopy.reviewTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(body == null || body.isEmpty ? MessagingCopy.reviewNoText : body),
          if (reviewed.attachments.isNotEmpty) ...[
            const SizedBox(height: Insets.sm),
            Text(
              MessagingCopy.reviewAttachments(reviewed.attachments.length),
              style: context.text.labelSmall,
            ),
          ],
          const SizedBox(height: Insets.sm),
          Text(
            MessagingCopy.reviewDeletedBy(reviewed.deletedByName),
            style: context.text.labelSmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text(MessagingCopy.reviewClose),
        ),
      ],
    ),
  );
}

/// Offers to start a direct conversation with [userId] (Q6): a sheet naming the
/// person, then the start itself. The server decides who the viewer may reach —
/// a refusal (a counterpart they may not, reported like an unknown account) is
/// said through its code, and nothing opens. On success the conversation list
/// is refreshed and the conversation opened by its own id. The start is
/// idempotent, so even a stray second tap never makes a second conversation.
Future<void> _messageAuthor(
  BuildContext context,
  WidgetRef ref,
  String userId,
  String name,
) async {
  final chosen = await showModalBottomSheet<bool>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.all(Insets.lg),
            child: Text(
              MessagingCopy.messagePerson(name),
              style: context.text.titleMedium,
            ),
          ),
          ListTile(
            key: Key('start-dm-$userId'),
            leading: const Icon(Icons.chat_bubble_outline_rounded),
            title: const Text(MessagingCopy.startDm),
            onTap: () => Navigator.pop(sheet, true),
          ),
          const SizedBox(height: Insets.sm),
        ],
      ),
    ),
  );
  if (chosen != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final result = await ref.read(directMessageStarterProvider).start(userId);
  if (!context.mounted) return;
  switch (result) {
    case OpenConversation(:final location):
      // A newly started conversation should be in the list when the viewer
      // returns to it (offline, there is no realtime to announce it).
      ref.invalidate(conversationListProvider);
      context.push(location);
    case CannotStartDm(:final message):
      messenger.toast(message);
  }
}
