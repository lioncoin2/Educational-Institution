import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/admin.dart';
import '../../data/models/auth.dart' show AccountStatus;
import '../../providers/app_providers.dart';
import 'account_detail_copy.dart';
import 'admin_copy.dart';
import 'state/account_detail_controller.dart';

/// The roles a role may be assigned from — the known institution roles. The
/// server decides which of these the caller may actually grant (a role carrying
/// permissions the caller lacks is refused); this list never implies otherwise.
const _assignableRoles = <String>[
  'ADMIN',
  'SUPERVISOR',
  'TEACHER',
  'ASSISTANT_TEACHER',
  'STUDENT',
];

/// Status transitions the domain allows, mirrored so the UI offers only valid
/// targets; the server stays the authority (`identity.status_transition_invalid`).
const _transitions = <AccountStatus, List<AccountStatus>>{
  AccountStatus.pending: [AccountStatus.active, AccountStatus.disabled],
  AccountStatus.active: [AccountStatus.suspended, AccountStatus.disabled],
  AccountStatus.suspended: [AccountStatus.active, AccountStatus.disabled],
  AccountStatus.disabled: [AccountStatus.active],
};

/// One account's record and its lifecycle administration (OWNER/ADMIN). Each
/// control is shown only to a holder of the matching capability and never on
/// the caller's own account; the server re-authorises every write.
class AccountDetailScreen extends ConsumerWidget {
  const AccountDetailScreen({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(accountDetailProvider(userId));
    final session = ref.watch(sessionUserProvider).value;
    final demo = !ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(account.value?.displayName ?? AccountDetailCopy.title),
        actions: [
          IconButton(
            tooltip: AccountDetailCopy.refresh,
            onPressed: () => ref.invalidate(accountDetailProvider(userId)),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: account,
          onRetry: () => ref.invalidate(accountDetailProvider(userId)),
          builder: (context, data) {
            final isSelf = session?.id == data.id;
            final canManageUsers = session?.can('users.manage') ?? false;
            final canAssignRoles = session?.can('roles.assign') ?? false;
            final canManageSessions = session?.can('sessions.manage') ?? false;
            return ListView(
              padding: const EdgeInsets.only(bottom: Insets.giant),
              children: [
                if (demo || data.origin.isMock)
                  const ResponsiveBody(
                    child: Padding(
                      padding: EdgeInsets.only(top: Insets.md),
                      child: MockBanner(message: AccountDetailCopy.demoBanner),
                    ),
                  ),
                ResponsiveBody(child: _HeaderCard(account: data)),
                ResponsiveBody(child: _IdentifiersCard(account: data)),
                ResponsiveBody(
                  child: _RolesCard(
                    account: data,
                    canAssign: canAssignRoles && !isSelf,
                    onAssign: () => _assignRole(context, ref, data),
                    onRemove: (role) => _removeRole(context, ref, data, role),
                  ),
                ),
                if (isSelf)
                  const ResponsiveBody(
                    child: Padding(
                      padding: EdgeInsets.only(top: Insets.lg),
                      child: AppCard(child: Text(AccountDetailCopy.selfNote)),
                    ),
                  )
                else if (canManageUsers || canManageSessions)
                  ResponsiveBody(
                    child: _ManagementCard(
                      canManageUsers: canManageUsers,
                      canManageSessions: canManageSessions,
                      onStatus: () => _changeStatus(context, ref, data),
                      onPassword: () => _resetPassword(context, ref, data),
                      onRevoke: () => _revokeSessions(context, ref, data),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _HeaderCard extends StatelessWidget {
  const _HeaderCard({required this.account});

  final AdminAccount account;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Insets.md),
      child: AppCard(
        child: Row(
          children: [
            Icon(
              Icons.account_circle_outlined,
              size: 40,
              color: context.colors.onSurfaceVariant,
            ),
            const SizedBox(width: Insets.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(account.displayName, style: context.text.titleMedium),
                  const SizedBox(height: 4),
                  Text(
                    AdminCopy.status(account.status),
                    style: context.text.bodyMedium?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _IdentifiersCard extends StatelessWidget {
  const _IdentifiersCard({required this.account});

  final AdminAccount account;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Insets.lg),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SectionHeader(title: AccountDetailCopy.identifiersSection),
            const SizedBox(height: Insets.sm),
            if (account.identifiers.isEmpty)
              Text(AdminCopy.noIdentifier, style: context.text.bodyMedium)
            else
              for (final id in account.identifiers)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    children: [
                      Icon(
                        Icons.alternate_email,
                        size: 18,
                        color: context.colors.onSurfaceVariant,
                      ),
                      const SizedBox(width: Insets.sm),
                      Expanded(child: Text(id.value)),
                    ],
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

class _RolesCard extends StatelessWidget {
  const _RolesCard({
    required this.account,
    required this.canAssign,
    required this.onAssign,
    required this.onRemove,
  });

  final AdminAccount account;
  final bool canAssign;
  final VoidCallback onAssign;
  final void Function(String role) onRemove;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Insets.lg),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SectionHeader(title: AccountDetailCopy.rolesSection),
            const SizedBox(height: Insets.sm),
            if (account.roles.isEmpty) ...[
              Text(AccountDetailCopy.noRoles, style: context.text.bodyMedium),
              const SizedBox(height: Insets.xs),
              Text(
                AccountDetailCopy.nextStepPending,
                style: context.text.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ] else
              Wrap(
                spacing: Insets.sm,
                runSpacing: Insets.sm,
                children: [
                  for (final role in account.roles)
                    canAssign
                        ? Chip(
                            label: Text(AdminCopy.role(role)),
                            onDeleted: () => onRemove(role),
                            deleteIcon: const Icon(Icons.close, size: 18),
                          )
                        : Chip(label: Text(AdminCopy.role(role))),
                ],
              ),
            if (canAssign) ...[
              const SizedBox(height: Insets.md),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: OutlinedButton.icon(
                  key: const Key('account-assign-role-button'),
                  onPressed: onAssign,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text(AccountDetailCopy.assignRole),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ManagementCard extends StatelessWidget {
  const _ManagementCard({
    required this.canManageUsers,
    required this.canManageSessions,
    required this.onStatus,
    required this.onPassword,
    required this.onRevoke,
  });

  final bool canManageUsers;
  final bool canManageSessions;
  final VoidCallback onStatus;
  final VoidCallback onPassword;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Insets.lg),
      child: AppCard(
        padding: EdgeInsets.zero,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(
                Insets.lg,
                Insets.lg,
                Insets.lg,
                Insets.sm,
              ),
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: SectionHeader(
                  title: AccountDetailCopy.managementSection,
                ),
              ),
            ),
            if (canManageUsers)
              ListTile(
                key: const Key('account-change-status-button'),
                leading: const Icon(Icons.toggle_on_outlined),
                title: const Text(AccountDetailCopy.changeStatus),
                onTap: onStatus,
              ),
            if (canManageUsers)
              ListTile(
                key: const Key('account-reset-password-button'),
                leading: const Icon(Icons.password_outlined),
                title: const Text(AccountDetailCopy.resetPassword),
                onTap: onPassword,
              ),
            if (canManageSessions)
              ListTile(
                key: const Key('account-revoke-sessions-button'),
                leading: const Icon(Icons.logout_outlined),
                title: const Text(AccountDetailCopy.revokeSessions),
                onTap: onRevoke,
              ),
          ],
        ),
      ),
    );
  }
}

// ── Actions ──────────────────────────────────────────────────────────────

Future<void> _assignRole(
  BuildContext context,
  WidgetRef ref,
  AdminAccount account,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final available = [
    for (final r in _assignableRoles)
      if (!account.roles.contains(r)) r,
  ];
  if (available.isEmpty) {
    messenger.toast(AccountDetailCopy.noAssignableRoles);
    return;
  }
  final role = await _pickFromSheet<String>(
    context,
    title: AccountDetailCopy.assignRoleTitle,
    options: available,
    label: AdminCopy.role,
  );
  if (role == null || !context.mounted) return;
  final ok = await _confirm(
    context,
    AccountDetailCopy.confirmAssign(AdminCopy.role(role), account.displayName),
  );
  if (ok != true) return;
  try {
    await ref.read(accountDetailProvider(account.id).notifier).assignRole(role);
  } on AdminException catch (error) {
    messenger.toast(AccountDetailCopy.actionFailed(error.code));
    return;
  }
  messenger.toast(AccountDetailCopy.roleAssigned);
}

Future<void> _removeRole(
  BuildContext context,
  WidgetRef ref,
  AdminAccount account,
  String role,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final ok = await _confirm(
    context,
    AccountDetailCopy.confirmRemove(AdminCopy.role(role), account.displayName),
  );
  if (ok != true) return;
  try {
    await ref.read(accountDetailProvider(account.id).notifier).removeRole(role);
  } on AdminException catch (error) {
    messenger.toast(AccountDetailCopy.actionFailed(error.code));
    return;
  }
  messenger.toast(AccountDetailCopy.roleRemoved);
}

Future<void> _changeStatus(
  BuildContext context,
  WidgetRef ref,
  AdminAccount account,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final targets = _transitions[account.status] ?? const <AccountStatus>[];
  if (targets.isEmpty) {
    messenger.toast(AccountDetailCopy.noStatusChanges);
    return;
  }
  final target = await _pickFromSheet<AccountStatus>(
    context,
    title: AccountDetailCopy.changeStatusTitle,
    options: targets,
    label: AdminCopy.status,
  );
  if (target == null || !context.mounted) return;
  final ok = await _confirm(
    context,
    AccountDetailCopy.confirmStatus(
      AdminCopy.status(target),
      AccountDetailCopy.effectOf(target),
    ),
  );
  if (ok != true) return;
  try {
    await ref
        .read(accountDetailProvider(account.id).notifier)
        .setStatus(target);
  } on AdminException catch (error) {
    messenger.toast(AccountDetailCopy.actionFailed(error.code));
    return;
  }
  messenger.toast(AccountDetailCopy.statusChanged);
}

Future<void> _resetPassword(
  BuildContext context,
  WidgetRef ref,
  AdminAccount account,
) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _ResetPasswordSheet(userId: account.id),
  );
}

Future<void> _revokeSessions(
  BuildContext context,
  WidgetRef ref,
  AdminAccount account,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final ok = await _confirm(
    context,
    AccountDetailCopy.revokeSessionsExplain,
    confirmLabel: AccountDetailCopy.confirmRevoke,
  );
  if (ok != true) return;
  int count;
  try {
    count = await ref
        .read(accountDetailProvider(account.id).notifier)
        .revokeSessions();
  } on AdminException catch (error) {
    messenger.toast(AccountDetailCopy.actionFailed(error.code));
    return;
  }
  messenger.toast(AccountDetailCopy.sessionsEnded(count));
}

Future<T?> _pickFromSheet<T>(
  BuildContext context, {
  required String title,
  required List<T> options,
  required String Function(T) label,
}) {
  return showModalBottomSheet<T>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(Insets.lg),
            child: Text(title, style: context.text.titleMedium),
          ),
          for (final option in options)
            ListTile(
              title: Text(label(option)),
              onTap: () => Navigator.of(context).pop(option),
            ),
          const SizedBox(height: Insets.sm),
        ],
      ),
    ),
  );
}

Future<bool?> _confirm(
  BuildContext context,
  String message, {
  String confirmLabel = AccountDetailCopy.confirm,
}) {
  return showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text(AccountDetailCopy.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
}

/// A new password, entered twice and obscured, sent once. Nothing is echoed,
/// logged or kept: on success the sheet simply closes with a confirmation.
class _ResetPasswordSheet extends ConsumerStatefulWidget {
  const _ResetPasswordSheet({required this.userId});

  final String userId;

  @override
  ConsumerState<_ResetPasswordSheet> createState() =>
      _ResetPasswordSheetState();
}

class _ResetPasswordSheetState extends ConsumerState<_ResetPasswordSheet> {
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      !_submitting && _password.text.length >= 8 && _confirm.text.isNotEmpty;

  Future<void> _submit() async {
    if (_password.text != _confirm.text) {
      setState(() => _error = AccountDetailCopy.passwordMismatch);
      return;
    }
    if (_password.text.length < 8) {
      setState(() => _error = AccountDetailCopy.passwordTooShort);
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref
          .read(accountDetailProvider(widget.userId).notifier)
          .resetPassword(_password.text);
    } on AdminException catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      messenger.toast(AccountDetailCopy.actionFailed(error.code));
      return;
    }
    if (!mounted) return;
    messenger.toast(AccountDetailCopy.passwordUpdated);
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
            Text(
              AccountDetailCopy.resetPasswordTitle,
              style: context.text.titleMedium,
            ),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('account-password-new'),
              controller: _password,
              autofocus: true,
              enabled: !_submitting,
              obscureText: true,
              textInputAction: TextInputAction.next,
              onChanged: (_) => setState(() => _error = null),
              decoration: const InputDecoration(
                labelText: AccountDetailCopy.newPasswordLabel,
                hintText: AccountDetailCopy.newPasswordHint,
              ),
            ),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('account-password-confirm'),
              controller: _confirm,
              enabled: !_submitting,
              obscureText: true,
              textInputAction: TextInputAction.done,
              onChanged: (_) => setState(() => _error = null),
              onSubmitted: (_) => _canSubmit ? _submit() : null,
              decoration: InputDecoration(
                labelText: AccountDetailCopy.confirmPasswordLabel,
                errorText: _error,
              ),
            ),
            const SizedBox(height: Insets.lg),
            FilledButton(
              key: const Key('account-password-submit'),
              onPressed: _canSubmit ? _submit : null,
              child: _submitting
                  ? const ExcludeSemantics(
                      child: SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : const Text(AccountDetailCopy.setPasswordAction),
            ),
          ],
        ),
      ),
    );
  }
}
