import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/app_avatar.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/academic_admin/widgets/person_picker_sheet.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The people picker shows each person's picture beside their name — resolved
/// through the directory's own authorized link — and falls back to initials for
/// a person who has none, without ever asking for a link in that case.
class _AvatarPeople implements PeopleRepository {
  final List<String> avatarCalls = [];

  @override
  Future<PeopleSearchPage> search(String query, {String? cursor}) async => const PeopleSearchPage(
    items: [
      PersonSearchResult(userId: 'u-pic', displayName: 'ليلى', avatarFileAssetId: 'asset-1'),
      PersonSearchResult(userId: 'u-nopic', displayName: 'لمياء'),
    ],
    origin: DataOrigin.records,
  );

  @override
  Future<PeopleSearchPage> searchTeachers(String query, {String? cursor}) =>
      throw UnimplementedError();

  @override
  Future<Uri> personAvatarUrl(String userId) async {
    avatarCalls.add(userId);
    return Uri.parse('mock://person-avatar/$userId');
  }
}

void main() {
  testWidgets('shows an avatar per row and fetches a link only for people who have a picture', (
    tester,
  ) async {
    final people = _AvatarPeople();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [peopleRepositoryProvider.overrideWithValue(people)],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showPersonPicker(context, title: 'اختر'),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'ل');
    await tester.pump(const Duration(milliseconds: 400)); // past the 300ms search debounce
    await tester.pumpAndSettle();

    // Both rows render an avatar (picture-or-initials), never a bare icon.
    expect(find.byType(AppAvatar), findsNWidgets(2));
    // A link is resolved only for the person who has a picture.
    expect(people.avatarCalls, contains('u-pic'));
    expect(people.avatarCalls, isNot(contains('u-nopic')));
  });
}
