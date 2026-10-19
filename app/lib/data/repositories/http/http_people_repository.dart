import '../../api/api_client.dart';
import '../../models/data_origin.dart';
import '../../models/people.dart';
import '../repositories.dart';

/// [PeopleRepository] against the real backend (`GET /people`).
///
/// No page size is sent — the server's default page is what the picker is
/// built for; `q` is the typed prefix and `cursor` the opaque keyset cursor.
/// Every transport and parsing failure becomes a [PeopleException], keeping the
/// server's code (so a 403 from a caller who may not search is told as such).
class HttpPeopleRepository implements PeopleRepository {
  HttpPeopleRepository(this._api);

  final ApiClient _api;

  @override
  Future<PeopleSearchPage> search(String query, {String? cursor}) => _call(
    () async => PeopleSearchPage.fromJson(
      await _api.get('/people', query: {'q': query, 'cursor': ?cursor}),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<PeopleSearchPage> searchTeachers(String query, {String? cursor}) => _call(
    () async => PeopleSearchPage.fromJson(
      await _api.get('/people/teachers', query: {'q': query, 'cursor': ?cursor}),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Uri> personAvatarUrl(String userId) => _call(
    () async => Uri.parse(
      (await _api.get('/people/${Uri.encodeComponent(userId)}/avatar'))['url']! as String,
    ),
  );

  static const _unreadable = PeopleException(
    'people.unreadable',
    'The server sent something this app cannot read.',
  );

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw PeopleException(error.code, error.message);
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}
