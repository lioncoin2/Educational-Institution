import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_avatar.dart';
import '../../../data/models/people.dart';
import '../../../providers/app_providers.dart';
import '../academic_people_copy.dart';

/// The institution people directory as a search (`GET /people`, `people.read`,
/// OWNER/ADMIN), keyed by the trimmed query; blank asks for nothing. It
/// discloses only {userId, displayName, avatarFileAssetId} — the caller does not
/// learn whether the person is an eligible student or teacher; the server
/// decides that on the mutation. Refusals keep the server's code.
final _directoryProvider = FutureProvider.autoDispose
    .family<PeopleSearchPage, String>((ref, query) {
      final q = query.trim();
      if (q.isEmpty) return Future.value(const PeopleSearchPage(items: []));
      return ref.watch(peopleRepositoryProvider).search(q);
    });

/// A short-lived link to one search result's picture, fetched once per display
/// and only for a person who has one. Null when there is no picture (or the
/// link cannot be read), so the avatar shows the default (initials).
final _personAvatarProvider = FutureProvider.autoDispose.family<Uri?, String>((
  ref,
  userId,
) async {
  try {
    return await ref.read(peopleRepositoryProvider).personAvatarUrl(userId);
  } on PeopleException {
    return null; // no picture, or not the caller's to read → initials
  }
}, retry: (_, _) => null);

/// The leading avatar for a result row: the person's picture when they have one
/// (resolved through the directory's own authorized link), their initials
/// otherwise — and on any load failure (AppAvatar's own fallback). No id is
/// ever shown in place of a name.
class _PersonAvatar extends ConsumerWidget {
  const _PersonAvatar({required this.person});

  final PersonSearchResult person;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final imageUrl = person.hasAvatar
        ? ref.watch(_personAvatarProvider(person.userId)).value
        : null;
    return AppAvatar(name: person.displayName, imageUrl: imageUrl, radius: 20);
  }
}

/// Opens the people picker and returns the chosen person, or null if dismissed.
/// The caller then performs the mutation (enrol / assign); selection is never
/// the authorization, and never proof of eligibility.
Future<PersonSearchResult?> showPersonPicker(
  BuildContext context, {
  required String title,
}) {
  return showModalBottomSheet<PersonSearchResult>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _PersonPicker(title: title),
  );
}

class _PersonPicker extends ConsumerStatefulWidget {
  const _PersonPicker({required this.title});

  final String title;

  @override
  ConsumerState<_PersonPicker> createState() => _PersonPickerState();
}

class _PersonPickerState extends ConsumerState<_PersonPicker> {
  final _field = TextEditingController();
  String _query = '';
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    _field.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) setState(() => _query = value.trim());
    });
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final results = ref.watch(_directoryProvider(_query));
    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          Insets.lg,
          0,
          Insets.lg,
          Insets.lg + bottomInset,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.8,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.title, style: context.text.titleMedium),
              const SizedBox(height: Insets.sm),
              Text(
                AcademicPeopleCopy.pickerHint,
                style: context.text.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: Insets.md),
              TextField(
                key: const Key('person-picker-search'),
                controller: _field,
                autofocus: true,
                textInputAction: TextInputAction.search,
                onChanged: _onChanged,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: AcademicPeopleCopy.searchHint,
                ),
              ),
              const SizedBox(height: Insets.md),
              Flexible(
                child: _query.isEmpty
                    ? const _Message(message: AcademicPeopleCopy.searchPrompt)
                    : results.when(
                        loading: () => const Padding(
                          padding: EdgeInsets.all(Insets.xl),
                          child: Center(child: CircularProgressIndicator()),
                        ),
                        error: (error, _) => _Message(
                          message: AcademicPeopleCopy.searchFailed(
                            error is PeopleException ? error.code : 'unknown',
                          ),
                        ),
                        data: (page) => page.items.isEmpty
                            ? const _Message(
                                message: AcademicPeopleCopy.noMatches,
                              )
                            : ListView.builder(
                                shrinkWrap: true,
                                itemCount: page.items.length,
                                itemBuilder: (context, index) {
                                  final person = page.items[index];
                                  return ListTile(
                                    leading: _PersonAvatar(person: person),
                                    title: Text(
                                      person.displayName ??
                                          AcademicPeopleCopy.unnamed,
                                    ),
                                    onTap: () =>
                                        Navigator.of(context).pop(person),
                                  );
                                },
                              ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Insets.xl),
      child: Text(
        message,
        textAlign: TextAlign.center,
        style: context.text.bodyMedium?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
      ),
    );
  }
}
