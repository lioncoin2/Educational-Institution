import '../../../app/app_config.dart';
import '../../models/data_origin.dart';
import '../../models/people.dart';
import '../repositories.dart';

/// In-memory stand-in for `GET /people`, for the demo build and widget tests.
///
/// A small, fixed set of invented people, filtered by display-name prefix —
/// enough to drive the add-member picker without a backend. Everything it
/// returns is marked [DataOrigin.mock]; it discloses only {userId, displayName},
/// exactly as the server does.
class MockPeopleRepository implements PeopleRepository {
  MockPeopleRepository({this.latency = AppConfig.fakeLatency});

  final Duration latency;

  static const List<PersonSearchResult> _people = [
    PersonSearchResult(userId: 'mock-teacher', displayName: 'الأستاذ عبدالله'),
    PersonSearchResult(userId: 'mock-peer-1', displayName: 'أحمد'),
    PersonSearchResult(userId: 'mock-peer-2', displayName: 'يوسف'),
    PersonSearchResult(userId: 'mock-person-sara', displayName: 'سارة'),
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
