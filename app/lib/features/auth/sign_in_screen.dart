import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/auth.dart';
import '../../providers/app_providers.dart';

/// Signing in with an account staff created. There is no registration: the
/// institution provisions accounts (see the backend's /admin/users).
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final _identifier = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _identifier.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(authRepositoryProvider)
          .signIn(identifier: _identifier.text, password: _password.text);
      ref.invalidate(sessionUserProvider);
      if (!mounted) return;
      if (context.canPop()) {
        context.pop();
      } else {
        context.go(Routes.messages);
      }
    } on AuthException catch (error) {
      if (!mounted) return;
      setState(() => _error = _describe(error.code));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  static String _describe(String code) => switch (code) {
    'identity.invalid_credentials' => 'البريد أو كلمة المرور غير صحيحة.',
    'identity.account_suspended' =>
      'هذا الحساب موقوف مؤقتًا. راجع إدارة المعهد.',
    'identity.account_disabled' => 'هذا الحساب معطّل. راجع إدارة المعهد.',
    'identity.account_pending' => 'الحساب لم يُفعّل بعد. راجع إدارة المعهد.',
    'rate_limited' || 'platform.rate_limited' || 'identity.too_many_attempts' =>
      'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم.',
    _ => 'تعذّر تسجيل الدخول. حاول مرة أخرى.',
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('تسجيل الدخول')),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: Insets.xxl),
          children: [
            ResponsiveBody(
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'أدخل بيانات حسابك في المعهد',
                      style: context.text.titleMedium,
                    ),
                    const SizedBox(height: Insets.lg),
                    TextField(
                      controller: _identifier,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [
                        AutofillHints.username,
                        AutofillHints.email,
                      ],
                      textDirection: TextDirection.ltr,
                      decoration: const InputDecoration(
                        labelText: 'البريد الإلكتروني',
                      ),
                    ),
                    const SizedBox(height: Insets.md),
                    TextField(
                      controller: _password,
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _submit(),
                      decoration: const InputDecoration(
                        labelText: 'كلمة المرور',
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: Insets.md),
                      Text(
                        _error!,
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.error,
                        ),
                      ),
                    ],
                    const SizedBox(height: Insets.xl),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox.square(
                              dimension: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('دخول'),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
