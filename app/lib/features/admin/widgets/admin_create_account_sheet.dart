import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/admin.dart';
import '../admin_copy.dart';
import '../state/admin_accounts_controller.dart';

/// Opens the create-account sheet. The caller shows the entry only to a holder
/// of `users.manage`; the server re-authorises the create on the request.
Future<void> showCreateAccount(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => const _CreateAccountSheet(),
  );
}

/// A name, an email and an initial password, then one create. The client guard
/// mirrors only the server's reachable minimums (all three present, password
/// ≥ 8); the server validates the rest (email shape, uniqueness) and is the
/// authority. One request, sent once — a second tap while it is on its way
/// sends nothing. On success the directory is read again and the sheet closes;
/// a refusal is said in words and the sheet stays open to correct.
class _CreateAccountSheet extends ConsumerStatefulWidget {
  const _CreateAccountSheet();

  @override
  ConsumerState<_CreateAccountSheet> createState() =>
      _CreateAccountSheetState();
}

class _CreateAccountSheetState extends ConsumerState<_CreateAccountSheet> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      !_submitting &&
      _name.text.trim().isNotEmpty &&
      _email.text.trim().isNotEmpty &&
      _password.text.length >= 8;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() => _submitting = true);
    try {
      await ref
          .read(adminAccountsProvider.notifier)
          .create(
            displayName: _name.text,
            identifier: _email.text,
            initialPassword: _password.text,
          );
    } on AdminException catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      messenger.toast(AdminCopy.createFailed(error.code));
      return;
    }
    if (!mounted) return;
    // Read the directory again so the new (PENDING) account appears.
    ref.invalidate(adminAccountsProvider);
    messenger.toast(AdminCopy.accountCreated);
    if (navigator.canPop()) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          Insets.lg,
          0,
          Insets.lg,
          Insets.lg + bottomInset,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(AdminCopy.createAccountTitle, style: context.text.titleMedium),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('admin-account-name'),
              controller: _name,
              autofocus: true,
              enabled: !_submitting,
              textInputAction: TextInputAction.next,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                labelText: AdminCopy.nameLabel,
                hintText: AdminCopy.nameHint,
              ),
            ),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('admin-account-email'),
              controller: _email,
              enabled: !_submitting,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              autocorrect: false,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                labelText: AdminCopy.emailLabel,
              ),
            ),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('admin-account-password'),
              controller: _password,
              enabled: !_submitting,
              obscureText: true,
              textInputAction: TextInputAction.done,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(
                labelText: AdminCopy.passwordLabel,
                hintText: AdminCopy.passwordHint,
              ),
            ),
            const SizedBox(height: Insets.md),
            FilledButton.icon(
              key: const Key('admin-account-submit'),
              onPressed: _canSubmit ? _submit : null,
              icon: _submitting
                  ? const ExcludeSemantics(
                      child: SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : const Icon(Icons.person_add_alt_1_outlined),
              label: const Text(AdminCopy.createAccountAction),
            ),
          ],
        ),
      ),
    );
  }
}
