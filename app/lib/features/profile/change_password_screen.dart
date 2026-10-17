import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/auth.dart';
import '../../providers/app_providers.dart';

/// The signed-in user changes their own password (`POST /auth/password`).
///
/// The server is the authority: it verifies the current password, enforces the
/// policy (≥ 8 characters, not blank, different from the current) and ends
/// every OTHER device's session — this device stays signed in. The client only
/// mirrors the cheap checks for a fast message; it never decides the outcome.
/// No password is logged or kept: the fields feed the one request and are
/// disposed with the screen.
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  /// The policy floor the server enforces (`password-policy.ts`); mirrored only
  /// to give an instant hint before a round-trip.
  static const int minLength = 8;

  @override
  ConsumerState<ChangePasswordScreen> createState() =>
      _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() => _error = null);
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).changePassword(
            currentPassword: _current.text,
            newPassword: _next.text,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'تم تغيير كلمة المرور. سُجّل خروج جلساتك على الأجهزة الأخرى.',
          ),
        ),
      );
      context.pop();
    } on AuthException catch (error) {
      if (!mounted) return;
      setState(() => _error = _describe(error.code));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Server-side refusals that the client cannot pre-empt (a wrong current
  /// password, the policy, rate limiting, the session). Client-side shape
  /// problems are caught by the field validators before any request.
  static String _describe(String code) => switch (code) {
    'identity.current_password_incorrect' => 'كلمة المرور الحالية غير صحيحة.',
    'identity.password_unchanged' =>
      'اختر كلمة مرور تختلف عن الحالية.',
    'identity.password_too_short' =>
      'كلمة المرور قصيرة — ${ChangePasswordScreen.minLength} أحرف على الأقل.',
    'identity.password_too_long' => 'كلمة المرور طويلة جدًّا.',
    'identity.password_blank' => 'كلمة المرور لا يمكن أن تكون فراغات.',
    'rate_limited' ||
    'platform.rate_limited' ||
    'identity.too_many_attempts' =>
      'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.',
    'identity.authentication_required' ||
    'identity.user_not_found' =>
      'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم.',
    _ => 'تعذّر تغيير كلمة المرور. حاول مرة أخرى.',
  };

  String? _validateNext(String? value) {
    final text = value ?? '';
    if (text.trim().isEmpty) return 'أدخل كلمة المرور الجديدة.';
    if (text.characters.length < ChangePasswordScreen.minLength) {
      return '${ChangePasswordScreen.minLength} أحرف على الأقل.';
    }
    if (text == _current.text) return 'يجب أن تختلف عن كلمة المرور الحالية.';
    return null;
  }

  String? _validateConfirm(String? value) {
    if ((value ?? '') != _next.text) return 'لا يطابق كلمة المرور الجديدة.';
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('تغيير كلمة المرور'),
        actions: [
          IconButton(
            tooltip: _obscure ? 'إظهار' : 'إخفاء',
            icon: Icon(
              _obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
            ),
            onPressed: () => setState(() => _obscure = !_obscure),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: Insets.xxl),
          children: [
            ResponsiveBody(
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'سيُطلب تسجيل الدخول من جديد على أجهزتك الأخرى.',
                      style: context.text.bodyMedium,
                    ),
                    const SizedBox(height: Insets.lg),
                    TextFormField(
                      controller: _current,
                      obscureText: _obscure,
                      autofillHints: const [AutofillHints.password],
                      decoration: const InputDecoration(
                        labelText: 'كلمة المرور الحالية',
                      ),
                      validator: (value) => (value ?? '').isEmpty
                          ? 'أدخل كلمة المرور الحالية.'
                          : null,
                    ),
                    const SizedBox(height: Insets.md),
                    TextFormField(
                      controller: _next,
                      obscureText: _obscure,
                      autofillHints: const [AutofillHints.newPassword],
                      decoration: const InputDecoration(
                        labelText: 'كلمة المرور الجديدة',
                      ),
                      validator: _validateNext,
                    ),
                    const SizedBox(height: Insets.md),
                    TextFormField(
                      controller: _confirm,
                      obscureText: _obscure,
                      autofillHints: const [AutofillHints.newPassword],
                      onFieldSubmitted: (_) => _submit(),
                      decoration: const InputDecoration(
                        labelText: 'تأكيد كلمة المرور الجديدة',
                      ),
                      validator: _validateConfirm,
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
                          : const Text('حفظ كلمة المرور'),
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
