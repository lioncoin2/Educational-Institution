import '../../api/api_client.dart';
import '../../models/communities.dart';
import '../../models/data_origin.dart';
import '../../models/people.dart';
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
  Future<Community> create(String title, {CommunityKind kind = CommunityKind.group}) => _call(
    () async => Community.fromJson(
      await _api.post('/communities', body: {'title': title, 'kind': kind.wire}),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Community> setChatMode(String communityId, {required bool membersMayPost}) => _call(
    () async => Community.fromJson(
      await _api.put(
        '${_community(communityId)}/chat-mode',
        body: {'membersMayPost': membersMayPost},
      ),
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
  Future<PeopleSearchPage> memberCandidates(
    String communityId,
    String query, {
    String? cursor,
  }) async {
    // A refusal here is said as a [PeopleException] (as the add-member picker's
    // error handling expects), keeping the server's code — a caller without
    // invite authority in this community sees `identity.permission_denied`.
    try {
      return PeopleSearchPage.fromJson(
        await _api.get(
          '${_community(communityId)}/member-candidates',
          query: {'q': query, 'cursor': ?cursor},
        ),
        origin: DataOrigin.records,
      );
    } on ApiException catch (error) {
      throw PeopleException(error.code, error.message);
    } on FormatException {
      throw _peopleUnreadable;
    } on TypeError {
      throw _peopleUnreadable;
    }
  }

  static const _peopleUnreadable = PeopleException(
    'people.unreadable',
    'The server sent something this app cannot read.',
  );

  @override
  Future<void> addMembers(String communityId, List<String> userIds) => _call(
    () => _api.post(
      '${_community(communityId)}/members',
      body: {'userIds': userIds},
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
  Future<Community> updateProfile(
    String communityId, {
    required String title,
    String? description,
    String? avatarFileAssetId,
  }) => _call(
    () async => Community.fromJson(
      await _api.put(
        '${_community(communityId)}/profile',
        body: {
          'title': title,
          // Explicit nulls: a full replace, so omitting one clears it.
          'description': description,
          'avatarFileAssetId': avatarFileAssetId,
        },
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Uri> communityAvatarUrl(String communityId) => _call(
    () async => _api.resolve(
      (await _api.get('${_community(communityId)}/avatar'))['url']! as String,
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

  @override
  Future<Community> linkHalaqa(String communityId, String halaqaId) => _call(
    () async => Community.fromJson(
      await _api.put(
        '${_community(communityId)}/halaqa',
        body: {'halaqaId': halaqaId},
      ),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<Community> unlinkHalaqa(String communityId) => _call(
    () async => Community.fromJson(
      await _api.delete('${_community(communityId)}/halaqa'),
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
