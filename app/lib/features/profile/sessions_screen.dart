import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/auth.dart';
import '../auth/sign_in_prompt.dart';
import 'state/sessions_controller.dart';

/// The signed-in user's devices and sessions (`GET /auth/sessions`): each row
/// is one active session, with the device, when it was last used, and which one
/// is this device. The user may end any OTHER session (`DELETE
/// /auth/sessions/:id`); this device is shown for reference only — signing it
/// out lives in the account card (which also clears this device's tokens), so
/// this screen does not duplicate it.
///
/// Every field shown comes from the session contract — nothing is invented.
/// Loading, error (with retry), empty and per-row busy states are all handled,
/// and the list refreshes after an end so a revoked row disappears. The screen
/// holds no HTTP or business logic: it calls [SessionsController] only.
class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key});

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  /// The session id currently being ended, so only its row shows a spinner.
  String? _ending;

  Future<void> _end(DeviceSession session) async {
    if (_ending != null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('إنهاء الجلسة'),
        content: Text('إنهاء الجلسة على «${_deviceName(session)}»؟'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('إنهاء'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _ending = session.id);
    try {
      await ref.read(sessionsProvider.notifier).endSession(session.id);
      if (mounted) context.toast('أُنهيت الجلسة.');
    } on AuthException catch (error) {
      if (!mounted) return;
      context.toast(_describe(error.code));
      // A session that is already gone (revoked elsewhere) must leave the list;
      // a plain refresh reconciles with the server's current truth.
      await ref.read(sessionsProvider.notifier).refresh();
    } finally {
      if (mounted) setState(() => _ending = null);
    }
  }

  static String _describe(String code) => switch (code) {
    'identity.session_not_found' => 'لم تعد هذه الجلسة موجودة.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'rate_limited' ||
    'platform.rate_limited' ||
    'identity.too_many_attempts' =>
      'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم.',
    _ => 'تعذّر إنهاء الجلسة. حاول مرة أخرى.',
  };

  static String _deviceName(DeviceSession session) {
    final label = session.label?.trim();
    if (label != null && label.isNotEmpty) return label;
    return switch (session.platform) {
      'web' => 'متصفّح ويب',
      'ios' => 'جهاز iOS',
      'android' => 'جهاز أندرويد',
      _ => 'جهاز غير معروف',
    };
  }

  static IconData _icon(String platform) => switch (platform) {
    'web' => Icons.language_rounded,
    'ios' || 'android' => Icons.smartphone_rounded,
    _ => Icons.devices_other_rounded,
  };

  static String _lastUsed(BuildContext context, DateTime at) {
    final local = at.toLocal();
    final now = DateTime.now();
    final l10n = MaterialLocalizations.of(context);
    final sameDay =
        local.year == now.year &&
        local.month == now.month &&
        local.day == now.day;
    final when = sameDay
        ? l10n.formatTimeOfDay(TimeOfDay.fromDateTime(local))
        : l10n.formatShortMonthDay(local);
    return 'آخر استخدام: $when';
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(sessionsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('الأجهزة والجلسات')),
      body: SafeArea(
        top: false,
        child: sessions.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) =>
              SignInPrompt.forError(
                error,
                onReturn: () => ref.read(sessionsProvider.notifier).refresh(),
              ) ??
              _Error(
                message: _describe(error is AuthException ? error.code : ''),
                onRetry: () => ref.read(sessionsProvider.notifier).refresh(),
              ),
          data: (items) => _list(context, items),
        ),
      ),
    );
  }

  Widget _list(BuildContext context, List<DeviceSession> items) {
    if (items.isEmpty) {
      return const Center(child: Text('لا توجد جلسات نشطة.'));
    }
    // This device first, then the rest by most-recently used.
    final sorted = [...items]..sort((a, b) {
      if (a.current != b.current) return a.current ? -1 : 1;
      return b.lastUsedAt.compareTo(a.lastUsedAt);
    });
    return RefreshIndicator(
      onRefresh: () => ref.read(sessionsProvider.notifier).refresh(),
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: Insets.lg),
        itemCount: sorted.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) => ResponsiveBody(
          child: _row(context, sorted[index]),
        ),
      ),
    );
  }

  Widget _row(BuildContext context, DeviceSession session) {
    final busy = _ending == session.id;
    return ListTile(
      leading: Icon(_icon(session.platform), color: context.colors.primary),
      title: Text(_deviceName(session), style: context.text.titleSmall),
      subtitle: Text(
        _lastUsed(context, session.lastUsedAt),
        style: context.text.bodySmall,
      ),
      trailing: session.current
          ? Chip(
              label: const Text('هذا الجهاز'),
              visualDensity: VisualDensity.compact,
              backgroundColor: context.colors.primaryContainer,
            )
          : busy
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : TextButton(
              onPressed: _ending == null ? () => _end(session) : null,
              child: const Text('إنهاء'),
            ),
    );
  }
}

class _Error extends StatelessWidget {
  const _Error({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Insets.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: context.text.bodyMedium,
            ),
            const SizedBox(height: Insets.md),
            FilledButton(onPressed: onRetry, child: const Text('إعادة المحاولة')),
          ],
        ),
      ),
    );
  }
}
