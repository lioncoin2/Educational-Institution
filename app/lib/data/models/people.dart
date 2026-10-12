/// People discovery — the display-name search results, shared by the owner/admin
/// institution-wide directory (`GET /people`, Owner Decision A1/A4) and the
/// community-scoped add-member candidate search
/// (`GET /communities/:id/member-candidates`); the server decides who may search.
///
/// Parsed defensively, as communities are: an id that cannot be read fails the
/// parse; a missing name is simply absent (a neutral fallback is shown). The
/// server discloses only {userId, displayName} — never an email, a role or any
/// security state — so nothing richer is modelled here.
library;

import 'data_origin.dart';

/// One match on the people search: an id to act on (add, message) and a name to
/// show. Nothing more — the server's privacy-safe projection.
class PersonSearchResult {
  const PersonSearchResult({required this.userId, this.displayName});

  /// Throws [FormatException] when it cannot be identified.
  factory PersonSearchResult.fromJson(Map<String, Object?> json) => PersonSearchResult(
    userId: _required(json, 'userId'),
    displayName: json['displayName'] is String ? json['displayName']! as String : null,
  );

  /// For acting on — never shown in place of a name.
  final String userId;

  /// The name to show; null when the server resolved none (a neutral fallback
  /// is shown in its place, never an account id).
  final String? displayName;
}

/// A keyset page of matches (`{items, nextCursor}`). `nextCursor` is opaque —
/// pass it back for the next page; null on the last.
class PeopleSearchPage implements Sourced {
  const PeopleSearchPage({
    required this.items,
    this.nextCursor,
    this.origin = DataOrigin.records,
  });

  factory PeopleSearchPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) {
    final items = json['items'];
    return PeopleSearchPage(
      items: items is List
          ? [
              for (final item in items)
                if (item is Map) PersonSearchResult.fromJson(item.cast<String, Object?>()),
            ]
          : const [],
      nextCursor: json['nextCursor'] is String ? json['nextCursor']! as String : null,
      origin: origin,
    );
  }

  final List<PersonSearchResult> items;

  /// Opaque; null on the last page.
  final String? nextCursor;

  @override
  final DataOrigin origin;
}

/// A refusal from `/people`, with the server's stable code.
class PeopleException implements Exception {
  const PeopleException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  /// Not the viewer's to search — a member without `people.read`.
  bool get isForbidden => code == 'identity.permission_denied';

  @override
  String toString() => 'PeopleException($code): $message';
}

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('people: missing "$key"');
}
