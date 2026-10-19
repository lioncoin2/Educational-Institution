import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/auth.dart';
import '../../../providers/app_providers.dart';

/// The account & session surface on the profile: who is signed in on this
/// device, and the one place to sign out — or, when nobody is, to sign in.
///
/// Shown only in backend mode; the demo build has no server session to manage.
/// The sign-in/out behaviour itself is the auth repository's (the one owner of
/// [AuthRepository.signOut]); this widget only presents it and refreshes the
/// shared [sessionUserProvider], exactly as the sign-in screen does.
class AccountSection extends ConsumerStatefulWidget {
  const AccountSection({super.key});

  @override
  ConsumerState<AccountSection> createState() => _AccountSectionState();
}

class _AccountSectionState extends ConsumerState<AccountSection> {
  bool _busy = false;

  Future<void> _signOut() async {
    if (_busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('تسجيل الخروج'),
        content: const Text('هل تريد تسجيل الخروج من هذا الجهاز؟'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('تسجيل الخروج'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).signOut();
      ref.invalidate(sessionUserProvider);
    } on AuthException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(_describe(error.code))));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  static String _describe(String code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. حاول مرة أخرى.',
    _ => 'تعذّر تسجيل الخروج. حاول مرة أخرى.',
  };

  @override
  Widget build(BuildContext context) {
    if (!ref.watch(backendModeProvider)) return const SizedBox.shrink();
    final session = ref.watch(sessionUserProvider);
    final user = session.value;

    final Widget tile;
    if (user != null) {
      tile = _signedIn(context, user);
    } else if (session.isLoading) {
      tile = const ListTile(
        leading: SizedBox.square(
          dimension: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        title: Text('…'),
      );
    } else {
      tile = _signedOut(context);
    }

    return Padding(
      padding: const EdgeInsets.only(top: Insets.xxl),
      child: ResponsiveBody(
        child: AppCard(padding: EdgeInsets.zero, child: tile),
      ),
    );
  }

  Widget _signedIn(BuildContext context, CurrentUser user) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      ListTile(
        leading:
            Icon(Icons.verified_user_outlined, color: context.colors.primary),
        title: Text(user.displayName, style: context.text.titleSmall),
        subtitle:
            Text('جلسة نشطة على هذا الجهاز', style: context.text.bodySmall),
        trailing: _busy
            ? const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : TextButton.icon(
                onPressed: _signOut,
                icon: const Icon(Icons.logout_rounded),
                label: const Text('تسجيل الخروج'),
              ),
      ),
      const Divider(height: 1),
      ListTile(
        leading: Icon(Icons.photo_camera_outlined, color: context.colors.primary),
        title: Text('الصورة الشخصية', style: context.text.titleSmall),
        subtitle: Text(
          'اختيار صورة حسابك أو إزالتها',
          style: context.text.bodySmall,
        ),
        trailing: Icon(
          Icons.chevron_right_rounded,
          color: context.colors.onSurfaceVariant,
        ),
        onTap: _busy ? null : () => context.push(Routes.avatar),
      ),
      const Divider(height: 1),
      ListTile(
        leading: Icon(Icons.lock_outline, color: context.colors.primary),
        title: Text('تغيير كلمة المرور', style: context.text.titleSmall),
        subtitle: Text(
          'تحديث كلمة مرور حسابك على هذا الجهاز',
          style: context.text.bodySmall,
        ),
        trailing: Icon(
          Icons.chevron_right_rounded,
          color: context.colors.onSurfaceVariant,
        ),
        onTap: _busy ? null : () => context.push(Routes.changePassword),
      ),
      const Divider(height: 1),
      ListTile(
        leading: Icon(Icons.devices_outlined, color: context.colors.primary),
        title: Text('الأجهزة والجلسات', style: context.text.titleSmall),
        subtitle: Text(
          'عرض أجهزتك وإنهاء الجلسات الأخرى',
          style: context.text.bodySmall,
        ),
        trailing: Icon(
          Icons.chevron_right_rounded,
          color: context.colors.onSurfaceVariant,
        ),
        onTap: _busy ? null : () => context.push(Routes.sessions),
      ),
    ],
  );

  Widget _signedOut(BuildContext context) => ListTile(
    leading: Icon(Icons.login_rounded, color: context.colors.primary),
    title: Text('تسجيل الدخول', style: context.text.titleSmall),
    subtitle: Text(
      'ادخل بحساب المعهد لعرض سجلّك وحلقاتك',
      style: context.text.bodySmall,
    ),
    trailing: Icon(
      Icons.chevron_right_rounded,
      color: context.colors.onSurfaceVariant,
    ),
    onTap: () => context.push(Routes.signIn),
  );
}
