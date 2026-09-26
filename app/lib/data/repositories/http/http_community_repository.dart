import '../../api/api_client.dart';
import '../../models/communities.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [CommunityRepository] against the real backend (`/communities`).
///
/// No page size is sent — the server's defaults (30 communities, 50 members,
/// links or grants) are the pages the screens are built for, and a roster is
/// walked only as far as someone scrolls. Every id in a path goes through
/// [Uri.encodeComponent].
///
/// Writes send exactly what their route takes: no body at all where it takes
/// none (the server refuses unknown keys), `{}` for a new link (the server's
/// default terms), and a token only ever in the body of a join.
class HttpCommunityRepository implements CommunityRepository {
  HttpCommunityRepository(this._api);

  final ApiClient _api;

  static String _community(String id) =>
      '/communities/${Uri.encodeComponent(id)}';

  static String _segment(String id) => Uri.encodeComponent(id);

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

  @override
  Future<CreatedInvitation> createInvitation(String communityId) => _call(
    () async => CreatedInvitation.fromJson(
      await _api.post(
        '${_community(communityId)}/invitations',
        body: const <String, Object?>{},
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<InvitationPage> invitations(String communityId, {String? cursor}) =>
      _call(
        () async => InvitationPage.fromJson(
          await _api.get(
            '${_community(communityId)}/invitations',
            query: {'cursor': ?cursor},
          ),
          origin: DataOrigin.records,
        ),
      );

  @override
  Future<CommunityInvitation> revokeInvitation(
    String communityId,
    String invitationId,
  ) => _call(
    () async => CommunityInvitation.fromJson(
      await _api.post(
        '${_community(communityId)}/invitations/${_segment(invitationId)}/revoke',
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Community> join(String token) => _call(
    () async => Community.fromJson(
      await _api.post('/communities/join', body: {'token': token}),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<void> removeMember(String communityId, String userId) => _call(
    () => _api.delete('${_community(communityId)}/members/${_segment(userId)}'),
  );

  @override
  Future<void> leave(String communityId) =>
      _call(() => _api.post('${_community(communityId)}/leave'));

  @override
  Future<Community> lock(String communityId) => _call(
    () async => Community.fromJson(
      await _api.post('${_community(communityId)}/lock'),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Community> unlock(String communityId) => _call(
    () async => Community.fromJson(
      await _api.post('${_community(communityId)}/unlock'),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<GrantPage> grants(
    String communityId, {
    required String userId,
    String? cursor,
  }) => _call(
    () async => GrantPage.fromJson(
      await _api.get(
        '${_community(communityId)}/grants',
        query: {'userId': userId, 'cursor': ?cursor},
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<GrantChange> grant(
    String communityId, {
    required String userId,
    required Set<CommunityCapability> capabilities,
  }) => _call(
    () async => GrantChange.fromJson(
      await _api.post(
        '${_community(communityId)}/grants',
        body: {
          'userId': userId,
          // In the vocabulary's order, as the server lists them back.
          'capabilities': [
            for (final capability in CommunityCapability.values)
              if (capabilities.contains(capability)) capability.wire,
          ],
        },
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<void> revokeGrant(String communityId, String grantId) => _call(
    () => _api.delete('${_community(communityId)}/grants/${_segment(grantId)}'),
  );

  @override
  Future<Community> transferOwnership(String communityId, String userId) =>
      _call(
        () async => Community.fromJson(
          await _api.put(
            '${_community(communityId)}/owner',
            body: {'userId': userId},
          ),
          origin: DataOrigin.records,
        ),
      );

  static const _unreadable = CommunityException(
    'communities.unreadable',
    'The server sent something this app cannot read.',
  );

  /// Maps every transport and parsing failure to [CommunityException],
  /// keeping the server's details.
  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw CommunityException(
        error.code,
        error.message,
        details: error.details ?? const {},
      );
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}
