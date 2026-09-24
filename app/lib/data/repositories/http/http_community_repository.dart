import '../../api/api_client.dart';
import '../../models/communities.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [CommunityRepository] against the real backend (`/communities`).
///
/// Three reads: the viewer's communities, one community, and a roster page.
/// No page size is sent — the server's defaults (30 communities, 50 members)
/// are the pages the screens are built for, and a roster is walked only as
/// far as someone scrolls.
class HttpCommunityRepository implements CommunityRepository {
  HttpCommunityRepository(this._api);

  final ApiClient _api;

  static String _community(String id) =>
      '/communities/${Uri.encodeComponent(id)}';

  @override
  Future<CommunityPage> communities({String? cursor}) => _call(
    () async => CommunityPage.fromJson(
      await _api.get(
        '/communities',
        query: {'scope': 'mine', 'cursor': ?cursor},
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Community> community(String communityId) => _call(
    () async => Community.fromJson(
      await _api.get(_community(communityId)),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<CommunityMemberPage> members(String communityId, {String? cursor}) =>
      _call(
        () async => CommunityMemberPage.fromJson(
          await _api.get(
            '${_community(communityId)}/members',
            query: {'cursor': ?cursor},
          ),
          origin: DataOrigin.records,
        ),
      );

  static const _unreadable = CommunityException(
    'communities.unreadable',
    'The server sent something this app cannot read.',
  );

  /// Maps every transport and parsing failure to [CommunityException].
  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw CommunityException(error.code, error.message);
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}
