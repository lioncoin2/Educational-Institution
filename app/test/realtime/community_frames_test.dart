import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';

/// The community frames, read from the golden fixtures the backend's frame
/// builders are tested against (backend/test/fixtures/realtime-frames): one
/// set of files, two parsers — a field renamed on one side fails the other.
void main() {
  final directory = Directory('../backend/test/fixtures/realtime-frames');
  final fixtures = {
    for (final file in directory.listSync().whereType<File>().where(
      (f) => f.path.endsWith('.json'),
    ))
      file.uri.pathSegments.last: file.readAsStringSync(),
  };

  // The community frames among them — the directory is shared, and a later
  // phase's frames will sit beside these.
  final community = [
    for (final name in fixtures.keys)
      if (name.startsWith('community.')) name,
  ];

  Map<String, Object?> fixture(String name) =>
      (jsonDecode(fixtures[name]!) as Map).cast<String, Object?>();

  ServerFrame? parse(Map<String, Object?> json) =>
      ServerFrame.parse(jsonEncode(json));

  test('reads the shared fixtures (so the checks below are not vacuous)', () {
    expect(
      fixtures.keys,
      containsAll([
        'community.member.added.json',
        'community.member.removed.left.json',
        'community.member.removed.removed.json',
        'community.locked.json',
        'community.unlocked.json',
        'community.access.changed.json',
      ]),
    );
    expect(community, hasLength(greaterThanOrEqualTo(6)));
  });

  test('parses every fixture of the directory — none is dropped', () {
    for (final MapEntry(key: name, value: text) in fixtures.entries) {
      final frame = ServerFrame.parse(text);
      expect(frame, isA<RealtimeEvent>(), reason: name);
      final event = frame! as RealtimeEvent;
      final json = fixture(name);
      expect(event.eventId, json['eventId'], reason: name);
      expect(
        event.occurredAt,
        DateTime.parse(json['occurredAt']! as String),
        reason: name,
      );
    }
  });

  test('reads every community fixture as a community event of its type', () {
    for (final name in community) {
      final event = ServerFrame.parse(fixtures[name]!);
      expect(event, isA<CommunityEvent>(), reason: name);
      expect(
        (event! as CommunityEvent).communityId,
        fixture(name)['communityId'],
        reason: name,
      );
      final type = fixture(name)['type'];
      expect(event, switch (type) {
        'community.member.added' => isA<CommunityMemberAddedEvent>(),
        'community.member.removed' => isA<CommunityMemberRemovedEvent>(),
        'community.locked' => isA<CommunityLockedEvent>(),
        'community.unlocked' => isA<CommunityUnlockedEvent>(),
        'community.access.changed' => isA<CommunityAccessChangedEvent>(),
        _ => fail('$name: a community frame this app does not know: $type'),
      }, reason: name);
    }
  });

  test('community.member.added', () {
    final event =
        ServerFrame.parse(fixtures['community.member.added.json']!)!
            as CommunityMemberAddedEvent;
    expect(event.eventId, 'community.member.added:community-1:user-2:7');
    expect(event.occurredAt, DateTime.utc(2026, 9, 24, 10));
    expect(event.communityId, 'community-1');
    expect(event.userId, 'user-2');
  });

  test('community.member.removed, left and removed', () {
    final left =
        ServerFrame.parse(fixtures['community.member.removed.left.json']!)!
            as CommunityMemberRemovedEvent;
    expect(left.userId, 'user-2');
    expect(left.communityId, 'community-1');
    expect(left.reason, CommunityRemovalReason.left);
    expect(left.eventId, 'community.member.removed:community-1:user-2:8');

    final removed =
        ServerFrame.parse(fixtures['community.member.removed.removed.json']!)!
            as CommunityMemberRemovedEvent;
    expect(removed.reason, CommunityRemovalReason.removed);
    expect(removed.eventId, isNot(left.eventId));
  });

  test('community.locked and community.unlocked carry their version only', () {
    final locked =
        ServerFrame.parse(fixtures['community.locked.json']!)!
            as CommunityLockedEvent;
    expect(locked.lifecycleVersion, 2);
    expect(locked.eventId, 'community.locked:community-1:2');

    final unlocked =
        ServerFrame.parse(fixtures['community.unlocked.json']!)!
            as CommunityUnlockedEvent;
    expect(unlocked.lifecycleVersion, 3);
    expect(unlocked, isA<CommunityLifecycleEvent>());
  });

  test('community.access.changed names the community and nothing else', () {
    final json = fixture('community.access.changed.json');
    expect(json.keys.toSet(), {
      'type',
      'eventId',
      'occurredAt',
      'communityId',
      'version',
    });
    final event = parse(json)! as CommunityAccessChangedEvent;
    expect(event.communityId, 'community-1');
  });

  test('no fixture carries a name, a title, a count or a capability', () {
    const allowed = {
      'type',
      'eventId',
      'occurredAt',
      'communityId',
      'userId',
      'reason',
      'lifecycleVersion',
      'version',
    };
    for (final name in community) {
      expect(
        fixture(name).keys.toSet().difference(allowed),
        isEmpty,
        reason: name,
      );
    }
  });

  test('drops a fixture from another protocol version', () {
    for (final name in community) {
      expect(parse(fixture(name)..['version'] = 2), isNull, reason: name);
    }
  });

  test('drops a fixture missing any of its fields — never half-applied', () {
    for (final name in community) {
      for (final key in fixture(name).keys) {
        if (key == 'type') continue;
        expect(
          parse(fixture(name)..remove(key)),
          isNull,
          reason: '$name without $key',
        );
      }
    }
  });

  test('drops a field of the wrong type', () {
    expect(
      parse(fixture('community.locked.json')..['lifecycleVersion'] = '2'),
      isNull,
    );
    expect(
      parse(fixture('community.member.added.json')..['userId'] = 2),
      isNull,
    );
    expect(
      parse(fixture('community.access.changed.json')..['occurredAt'] = 'soon'),
      isNull,
    );
  });

  test('reads what a newer server adds: extra fields ignored, a new reason unknown', () {
    final extra = parse(
      fixture('community.member.added.json')..['membershipVersion'] = 7,
    );
    expect(extra, isA<CommunityMemberAddedEvent>());

    final newer =
        parse(
              fixture('community.member.removed.left.json')
                ..['reason'] = 'expired',
            )!
            as CommunityMemberRemovedEvent;
    expect(newer.reason, CommunityRemovalReason.unknown);
  });
}
