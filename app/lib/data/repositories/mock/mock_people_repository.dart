import '../../../app/app_config.dart';
import '../../models/data_origin.dart';
import '../../models/people.dart';
import '../repositories.dart';

/// In-memory stand-in for `GET /people`, for the demo build and widget tests.
///
/// A small, fixed set of invented people, filtered by display-name prefix —
/// enough to drive the add-member picker without a backend. Everything it
/// returns is marked [DataOrigin.mock]; it discloses only
/// {userId, displayName, avatarFileAssetId}, exactly as the server does — some
/// demo people carry a picture reference, others none (the initials view).
class MockPeopleRepository implements PeopleRepository {
  MockPeopleRepository({this.latency = AppConfig.fakeLatency});

  final Duration latency;

  static const List<PersonSearchResult> _people = [
    PersonSearchResult(
      userId: 'mock-teacher',
      displayName: 'الأستاذ عبدالله',
      avatarFileAssetId: 'mock-avatar-teacher',
    ),
    PersonSearchResult(userId: 'mock-peer-1', displayName: 'أحمد'),
    PersonSearchResult(userId: 'mock-peer-2', displayName: 'يوسف'),
    PersonSearchResult(
      userId: 'mock-person-sara',
      displayName: 'سارة',
      avatarFileAssetId: 'mock-avatar-sara',
    ),
    PersonSearchResult(userId: 'mock-person-salma', displayName: 'سلمى'),
  ];

  /// The eligible teachers among the demo people (mirrors the server's teacher
  /// directory: `academic.teach`, not an administrator). Only `mock-teacher`
  /// here; the peers and the admin are never teacher-search results.
  static const Set<String> _teacherIds = {'mock-teacher'};

  @override
  Future<PeopleSearchPage> search(String query, {String? cursor}) =>
      _matching(query, cursor, (_) => true);

  @override
  Future<PeopleSearchPage> searchTeachers(String query, {String? cursor}) =>
      _matching(query, cursor, (person) => _teacherIds.contains(person.userId));

  @override
  Future<Uri> personAvatarUrl(String userId) async {
    if (latency != Duration.zero) await Future<void>.delayed(latency);
    final asset = _people
        .where((p) => p.userId == userId)
        .map((p) => p.avatarFileAssetId)
        .firstWhere((_) => true, orElse: () => null);
    if (asset == null) {
      // No picture (or unknown person) — exactly as the server's 404 reads, so
      // the view falls back to initials.
      throw const PeopleException('people.person_avatar_not_found', 'No profile picture.');
    }
    // A stand-in link that does not resolve to bytes — the demo shows initials
    // (AppAvatar's error fallback); the real backend serves the image.
    return Uri.parse('mock://person-avatar/$userId/$asset');
  }

  Future<PeopleSearchPage> _matching(
    String query,
    String? cursor,
    bool Function(PersonSearchResult) keep,
  ) async {
    if (latency != Duration.zero) await Future<void>.delayed(latency);
    final needle = query.trim().toLowerCase();
    // A blank query is empty, and the demo is a single page: a cursor is spent.
    if (needle.isEmpty || cursor != null) {
      return const PeopleSearchPage(items: [], origin: DataOrigin.mock);
    }
    return PeopleSearchPage(
      items: [
        for (final person in _people)
          if (keep(person) && (person.displayName ?? '').toLowerCase().startsWith(needle)) person,
      ],
      origin: DataOrigin.mock,
    );
  }
}
