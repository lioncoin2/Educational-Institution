import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/state/community_chat_opener.dart';
import 'package:quran_institution_app/features/communities/state/community_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_list_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_members_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// The community state against the mock server and a live connection the
/// test drives. What it must hold, whatever order frames and answers come
/// in: a frame is a reason to ask the server, never an answer; a repeated
/// or older frame changes nothing; what is shown in the end is what the
/// server says.
void main() {
  const open = MockCommunityRepository.openId;
  const owned = MockCommunityRepository.ownedId;
  const delegated = MockCommunityRepository.delegatedId;
  const lockedOne = MockCommunityRepository.lockedId;
  const large = MockCommunityRepository.largeId;

  late ScriptedCommunities repo;
  late ScriptedMessaging messaging;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  void boot({CurrentUser? signedIn}) {
    container = ProviderContainer(
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(messaging),
        realtimeConnectionProvider.overrideWithValue(realtime),
        if (signedIn != null)
          sessionUserProvider.overrideWith((ref) async => signedIn),
      ],
    );
    addTearDown(container.dispose);
  }

  setUp(() {
    repo = ScriptedCommunities();
    messaging = ScriptedMessaging();
    realtime = FakeRealtimeClient();
    boot();
  });

  group('the list', () {
    Future<CommunityListState> load() {
      final keepAlive = container.listen(communityListProvider, (_, _) {});
      addTearDown(keepAlive.close);
      return container.read(communityListProvider.future);
    }

    CommunityListState list() =>
        container.read(communityListProvider).requireValue;

    Community item(String id) => list().items.firstWhere((c) => c.id == id);

    test('loads the first page, most recently joined first', () async {
      final state = await load();
      expect(state.items.map((c) => c.id), seededIds);
      expect(state.hasMore, isFalse);
    });

    test('is empty when the viewer is in no community', () async {
      repo.leaveAll();
      expect((await load()).items, isEmpty);
    });

    test(
      'surfaces a failed first read as an error, not an empty list',
      () async {
        repo.failWith = 'network.unreachable';
        final keepAlive = container.listen(communityListProvider, (_, _) {});
        addTearDown(keepAlive.close);
        await expectLater(
          container.read(communityListProvider.future),
          throwsA(isA<CommunityException>()),
        );
      },
    );

    test('loads more on request, each community once', () async {
      repo = ScriptedCommunities(communityPageSize: 2);
      boot();
      await load();
      expect(list().items.map((c) => c.id), [open, owned]);
      expect(list().hasMore, isTrue);

      // Someone rejoins meanwhile: the next page shifts under the cursor,
      // and repeats a community already shown.
      repo.restoreMembership(large);
      await container.read(communityListProvider.notifier).loadMore();
      expect(list().items.map((c) => c.id), [
        open,
        owned,
        MockCommunityRepository.delegatedId,
      ]);

      await container.read(communityListProvider.notifier).loadMore();
      expect(list().items.map((c) => c.id), [
        open,
        owned,
        MockCommunityRepository.delegatedId,
        lockedOne,
      ]);
      expect(list().hasMore, isFalse);

      // The one that moved ahead of the cursor is on the first page again.
      await container.read(communityListProvider.notifier).refresh();
      expect(list().items.map((c) => c.id), [large, open]);
    });

    test(
      'keeps what is shown when a next page fails, and offers retry',
      () async {
        repo = ScriptedCommunities(communityPageSize: 2);
        boot();
        await load();
        repo.failWith = 'network.unreachable';
        await container.read(communityListProvider.notifier).loadMore();
        expect(list().items, hasLength(2));
        expect(list().loadMoreFailed, isTrue);
        repo.failWith = null;
        await container.read(communityListProvider.notifier).loadMore();
        expect(list().items, hasLength(4));
      },
    );

    test(
      'reads the first page once more for what came while it loaded',
      () async {
        // The first page takes its answer — with `open` in it...
        final hold = repo.holdList = Completer<void>();
        final loading = load();
        await pumpEventQueue();
        repo.holdList = null;
        // ...then the viewer is removed from it, and a lock and a reconnect
        // come too, all before that answer lands.
        repo.endMembership(open);
        realtime.emit(removed(open));
        realtime.emit(locked(owned, 9));
        realtime.setStatus(RealtimeStatus.reconnected);
        await pumpEventQueue();
        hold.complete();
        await loading;
        await pumpEventQueue();
        // One read more, however much came meanwhile.
        expect(repo.listRequests, 2);
        expect(repo.communityRequests, isEmpty);
        expect(list().items.map((c) => c.id), isNot(contains(open)));
      },
    );

    test(
      'reads the first page once more for what came during a refresh',
      () async {
        await load();
        final hold = repo.holdList = Completer<void>();
        final refreshing = container
            .read(communityListProvider.notifier)
            .refresh();
        await pumpEventQueue();
        repo.holdList = null;
        repo.endMembership(open);
        realtime.emit(removed(open));
        await pumpEventQueue();
        hold.complete();
        await refreshing;
        await pumpEventQueue();
        expect(repo.listRequests, 3);
        expect(list().items.map((c) => c.id), isNot(contains(open)));
      },
    );

    test(
      'drops a next page asked for before the first page was read again',
      () async {
        repo = ScriptedCommunities(communityPageSize: 2);
        repo.endMembership(large);
        boot();
        await load();
        final notifier = container.read(communityListProvider.notifier);
        expect(list().items.map((c) => c.id), [open, owned]);

        // The next page takes its answer, cut after `owned`...
        final hold = repo.holdList = Completer<void>();
        final more = notifier.loadMore();
        await pumpEventQueue();
        repo.holdList = null;
        // ...then the viewer joins a community: the first page again.
        repo.restoreMembership(large);
        realtime.emit(added(large));
        await pumpEventQueue();
        expect(list().items.map((c) => c.id), [large, open]);
        // The next page is still on its way: no second one starts.
        expect(list().loadingMore, isTrue);
        await notifier.loadMore();
        expect(repo.listRequests, 3);

        hold.complete();
        await more;
        await pumpEventQueue();
        // Cut from a list no longer shown, it is dropped, not spliced on.
        expect(list().items.map((c) => c.id), [large, open]);
        expect(list().loadingMore, isFalse);
        while (list().hasMore) {
          await notifier.loadMore();
        }
        expect(list().items.map((c) => c.id), [
          large,
          open,
          owned,
          delegated,
          lockedOne,
        ]);
      },
    );

    test(
      'loads no next page while a refresh’s first page is on its way',
      () async {
        repo = ScriptedCommunities(communityPageSize: 2);
        boot();
        await load();
        final hold = repo.holdList = Completer<void>();
        final refreshing = container
            .read(communityListProvider.notifier)
            .refresh();
        await pumpEventQueue();
        final more = container.read(communityListProvider.notifier).loadMore();
        await pumpEventQueue();
        expect(repo.listRequests, 2);
        hold.complete();
        await refreshing;
        await more;
        expect(list().items.map((c) => c.id), [open, owned]);
        expect(list().hasMore, isTrue);
      },
    );

    test(
      'never lets a next page asked for before a removal bring it back',
      () async {
        repo = ScriptedCommunities(communityPageSize: 2);
        boot();
        await load();
        // The next page takes its answer — with `delegated` in it...
        final hold = repo.holdList = Completer<void>();
        final more = container.read(communityListProvider.notifier).loadMore();
        await pumpEventQueue();
        repo.holdList = null;
        // ...then the viewer is removed from it before that answer lands.
        repo.endMembership(delegated);
        realtime.emit(removed(delegated));
        await pumpEventQueue();
        hold.complete();
        await more;
        await pumpEventQueue();
        expect(list().items.map((c) => c.id), isNot(contains(delegated)));
      },
    );

    test(
      'never lets an older first page undo a newer read of one community',
      () async {
        await load();
        expect(item(open).canViewMembers, isFalse);
        // A reconnect read takes its answer...
        final hold = repo.holdList = Completer<void>();
        realtime.setStatus(RealtimeStatus.reconnected);
        await pumpEventQueue();
        repo.holdList = null;
        // ...then the viewer's access changes, and that community is read
        // again — answered first.
        repo.delegate(open, {CommunityCapability.membersView});
        realtime.emit(accessChanged(open));
        await pumpEventQueue();
        expect(item(open).canViewMembers, isTrue);
        hold.complete();
        await pumpEventQueue();
        expect(item(open).canViewMembers, isTrue);
      },
    );

    test(
      'never lets an older first page drop a community a newer read kept',
      () async {
        await load();
        // A reconnect read takes its answer while the viewer is out...
        repo.endMembership(owned);
        final hold = repo.holdList = Completer<void>();
        realtime.setStatus(RealtimeStatus.reconnected);
        await pumpEventQueue();
        repo.holdList = null;
        // ...then they are back, and that community, read again, says so.
        repo.restoreMembership(owned);
        realtime.emit(accessChanged(owned));
        await pumpEventQueue();
        hold.complete();
        await pumpEventQueue();
        expect(list().items.map((c) => c.id), contains(owned));
        expect(list().items.map((c) => c.id).toSet(), hasLength(5));
      },
    );

    test(
      'never lets an older "not found" drop a community the viewer rejoined',
      () async {
        await load();
        final version = repo.changeStatus(open, CommunityStatus.locked);
        repo.endMembership(open);
        // The re-read for the lock is refused — and the refusal is slow.
        final hold = repo.holdCommunity = Completer<void>();
        realtime.emit(locked(open, version));
        await pumpEventQueue();
        repo.holdCommunity = null;
        realtime.emit(removed(open));
        await pumpEventQueue();
        // Added back meanwhile: the first page, read after, has it.
        repo.restoreMembership(open);
        realtime.emit(added(open));
        await pumpEventQueue();
        expect(list().items.first.id, open);
        hold.complete();
        await pumpEventQueue();
        expect(list().items.first.id, open);
      },
    );

    test('asks the server again when the viewer is added somewhere', () async {
      repo.endMembership(open);
      await load();
      expect(list().items.map((c) => c.id), isNot(contains(open)));

      repo.restoreMembership(open);
      realtime.emit(added(open));
      await pumpEventQueue();
      expect(repo.listRequests, 2);
      expect(list().items.first.id, open);
    });

    test('puts a community away at once when the viewer is removed', () async {
      await load();
      repo.endMembership(open);
      repo.holdList = Completer<void>();
      realtime.emit(removed(open));
      await pumpEventQueue();
      // Gone before the server has answered.
      expect(list().items.map((c) => c.id), isNot(contains(open)));
      repo.holdList!.complete();
      await pumpEventQueue();
      expect(repo.listRequests, 2);
      expect(list().items.map((c) => c.id), isNot(contains(open)));
    });

    test(
      'converges on the server when a removal frame was overtaken',
      () async {
        await load();
        // The frame says removed; the server (the truth) still lists it.
        realtime.emit(removed(open, reason: CommunityRemovalReason.left));
        await pumpEventQueue();
        expect(list().items.map((c) => c.id), contains(open));
        expect(repo.listRequests, 2);
      },
    );

    test('never lets a read answered before a removal bring it back', () async {
      await load();
      // A reconnect read takes its answer — with the community in it...
      repo.holdList = Completer<void>();
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      // ...then the viewer is removed, and told so, before it lands.
      repo.endMembership(open);
      realtime.emit(removed(open));
      await pumpEventQueue();
      final hold = repo.holdList!;
      repo.holdList = null;
      hold.complete();
      await pumpEventQueue();
      // The stale answer landed, and the read asked for after the frame
      // replaced it.
      expect(repo.listRequests, 3);
      expect(list().items.map((c) => c.id), isNot(contains(open)));
    });

    test(
      'reads a community again for a newer lock, once however often told',
      () async {
        await load();
        final version = repo.changeStatus(open, CommunityStatus.locked);
        realtime.emit(locked(open, version));
        realtime.emit(locked(open, version)); // the same frame, twice
        await pumpEventQueue();
        expect(repo.communityRequests, [open]);
        expect(item(open).isLocked, isTrue);
        expect(item(open).lifecycleVersion, version);

        // Old news: a version already held changes nothing.
        realtime.emit(unlocked(open, version - 1));
        await pumpEventQueue();
        expect(repo.communityRequests, [open]);
        expect(item(open).isLocked, isTrue);
      },
    );

    test(
      'ends on the newest state when lock frames arrive out of order',
      () async {
        await load();
        final lockedAt = repo.changeStatus(open, CommunityStatus.locked);
        final unlockedAt = repo.changeStatus(open, CommunityStatus.open);
        expect(unlockedAt, lockedAt + 1);
        // The unlock overtakes the lock on the way.
        realtime.emit(unlocked(open, unlockedAt));
        await pumpEventQueue();
        realtime.emit(locked(open, lockedAt));
        await pumpEventQueue();
        expect(repo.communityRequests, [open]);
        expect(item(open).isLocked, isFalse);
        expect(item(open).lifecycleVersion, unlockedAt);
      },
    );

    test('reads a community again when the viewer’s access changed', () async {
      await load();
      expect(item(open).canViewMembers, isFalse);
      repo.delegate(open, {CommunityCapability.membersView});
      realtime.emit(accessChanged(open));
      await pumpEventQueue();
      expect(item(open).canViewMembers, isTrue);
    });

    test('drops a community whose re-read says it is gone', () async {
      await load();
      final version = repo.changeStatus(open, CommunityStatus.locked);
      repo.endMembership(open);
      realtime.emit(locked(open, version));
      await pumpEventQueue();
      expect(list().items.map((c) => c.id), isNot(contains(open)));
    });

    test('catches up over HTTP with what it missed while offline', () async {
      await load();
      realtime.setStatus(RealtimeStatus.reconnecting);
      // No frame reaches a dropped connection.
      final version = repo.changeStatus(open, CommunityStatus.locked);
      repo.endMembership(owned);
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      expect(item(open).isLocked, isTrue);
      expect(item(open).lifecycleVersion, version);
      expect(list().items.map((c) => c.id), isNot(contains(owned)));
    });

    test(
      'ignores a frame about someone else once it knows the viewer',
      () async {
        repo.endMembership(open);
        boot(
          signedIn: const CurrentUser(
            id: viewer,
            displayName: 'x',
            status: AccountStatus.active,
            roles: [],
            permissions: {},
          ),
        );
        await container.read(sessionUserProvider.future);
        await load();
        realtime.emit(added(open, userId: 'someone-else'));
        realtime.emit(removed(owned, userId: 'someone-else'));
        await pumpEventQueue();
        expect(repo.listRequests, 1);
        expect(list().items.map((c) => c.id), contains(owned));
      },
    );

    test('ignores lock frames for communities it does not show', () async {
      await load();
      realtime.emit(locked('mock-community-elsewhere', 5));
      realtime.emit(accessChanged('mock-community-elsewhere'));
      await pumpEventQueue();
      expect(repo.communityRequests, isEmpty);
    });
  });

  group('one community', () {
    Future<CommunityDetailState> load(String id) {
      final keepAlive = container.listen(communityProvider(id), (_, _) {});
      addTearDown(keepAlive.close);
      return container.read(communityProvider(id).future);
    }

    CommunityDetailState detail(String id) =>
        container.read(communityProvider(id)).requireValue;

    test('loads what the server says the viewer may do', () async {
      final state = await load(owned);
      expect(state.removed, isFalse);
      expect(state.community!.me.standing, CommunityStanding.owner);
      expect(state.community!.canViewMembers, isTrue);
    });

    test('shows "not found" as removed, not as an error', () async {
      final state = await load('mock-community-nowhere');
      expect(state.removed, isTrue);
      expect(state.community, isNull);
    });

    test('surfaces any other failure as an error to retry', () async {
      repo.failWith = 'network.unreachable';
      final keepAlive = container.listen(communityProvider(open), (_, _) {});
      addTearDown(keepAlive.close);
      await expectLater(
        container.read(communityProvider(open).future),
        throwsA(isA<CommunityException>()),
      );
    });

    test(
      'reads again for a newer lock — once, and never for an older one',
      () async {
        await load(open);
        final version = repo.changeStatus(open, CommunityStatus.locked);
        realtime.emit(locked(open, version));
        realtime.emit(locked(open, version));
        await pumpEventQueue();
        expect(repo.communityRequests, [open, open]);
        expect(detail(open).community!.isLocked, isTrue);

        realtime.emit(unlocked(open, version - 1));
        await pumpEventQueue();
        expect(repo.communityRequests, hasLength(2));
      },
    );

    test(
      'ends on the newest state when lock frames arrive out of order',
      () async {
        await load(lockedOne);
        final unlockedAt = repo.changeStatus(lockedOne, CommunityStatus.open);
        final lockedAt = repo.changeStatus(lockedOne, CommunityStatus.locked);
        final reopenedAt = repo.changeStatus(lockedOne, CommunityStatus.open);
        realtime.emit(unlocked(lockedOne, reopenedAt));
        await pumpEventQueue();
        realtime.emit(locked(lockedOne, lockedAt));
        realtime.emit(unlocked(lockedOne, unlockedAt));
        await pumpEventQueue();
        expect(repo.communityRequests, [lockedOne, lockedOne]);
        expect(detail(lockedOne).community!.isLocked, isFalse);
        expect(detail(lockedOne).community!.lifecycleVersion, reopenedAt);
      },
    );

    test(
      'reads again when access changed — capabilities come from the server',
      () async {
        await load(open);
        expect(detail(open).community!.canViewMembers, isFalse);
        repo.delegate(open, {CommunityCapability.membersView});
        realtime.emit(accessChanged(open));
        await pumpEventQueue();
        expect(detail(open).community!.canViewMembers, isTrue);
      },
    );

    test(
      'shows a removal at once, and keeps it when the server confirms',
      () async {
        await load(open);
        repo.endMembership(open);
        repo.holdCommunity = Completer<void>();
        realtime.emit(removed(open));
        await pumpEventQueue();
        expect(detail(open).removed, isTrue);
        expect(detail(open).community!.title, isNotEmpty); // still says which
        repo.holdCommunity!.complete();
        await pumpEventQueue();
        expect(detail(open).removed, isTrue);
      },
    );

    test(
      'restores a community when the server overrules a removal frame',
      () async {
        await load(open);
        realtime.emit(removed(open));
        await pumpEventQueue();
        expect(detail(open).removed, isFalse);
        expect(repo.communityRequests, [open, open]);
      },
    );

    test('comes back when the viewer is added again', () async {
      repo.endMembership(open);
      expect((await load(open)).removed, isTrue);
      repo.restoreMembership(open);
      realtime.emit(added(open));
      await pumpEventQueue();
      expect(detail(open).removed, isFalse);
      expect(detail(open).community!.canOpenChat, isTrue);
    });

    test('catches up on reconnect with a lock it never heard of', () async {
      await load(open);
      realtime.setStatus(RealtimeStatus.reconnecting);
      repo.changeStatus(open, CommunityStatus.locked);
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      expect(detail(open).community!.isLocked, isTrue);
    });

    test('reads the server again on refresh', () async {
      await load(open);
      repo.changeStatus(open, CommunityStatus.locked);
      await container.read(communityProvider(open).notifier).refresh();
      expect(detail(open).community!.isLocked, isTrue);
    });

    test(
      'reads once more after loading, for a lock that came meanwhile',
      () async {
        // The first read takes its answer: open...
        final hold = repo.holdCommunity = Completer<void>();
        final loading = load(open);
        await pumpEventQueue();
        repo.holdCommunity = null;
        // ...then it is locked, and told so, before that answer lands.
        final version = repo.changeStatus(open, CommunityStatus.locked);
        realtime.emit(locked(open, version));
        await pumpEventQueue();
        hold.complete();
        await loading;
        await pumpEventQueue();
        expect(detail(open).community!.isLocked, isTrue);
        expect(detail(open).community!.lifecycleVersion, version);
        expect(repo.communityRequests, [open, open]);
      },
    );

    test(
      'reads once more after a refresh, for a lock that came during it',
      () async {
        await load(open);
        final hold = repo.holdCommunity = Completer<void>();
        final refreshing = container
            .read(communityProvider(open).notifier)
            .refresh();
        await pumpEventQueue();
        repo.holdCommunity = null;
        final version = repo.changeStatus(open, CommunityStatus.locked);
        realtime.emit(locked(open, version));
        await pumpEventQueue();
        hold.complete();
        await refreshing;
        await pumpEventQueue();
        expect(detail(open).community!.isLocked, isTrue);
        expect(repo.communityRequests, [open, open, open]);
      },
    );

    test('keeps what is shown when a re-read fails', () async {
      await load(open);
      repo.failWith = 'network.unreachable';
      realtime.emit(accessChanged(open));
      await pumpEventQueue();
      expect(detail(open).removed, isFalse);
      expect(detail(open).community!.id, open);
    });

    test('listens only to its own community', () async {
      await load(open);
      realtime.emit(locked(owned, 99));
      realtime.emit(removed(owned));
      realtime.emit(accessChanged(owned));
      await pumpEventQueue();
      expect(repo.communityRequests, [open]);
      expect(detail(open).removed, isFalse);
    });
  });

  group('the roster', () {
    Future<CommunityMembersState> load(String id) {
      final keepAlive = container.listen(
        communityMembersProvider(id),
        (_, _) {},
      );
      addTearDown(keepAlive.close);
      return container.read(communityMembersProvider(id).future);
    }

    CommunityMembersState roster(String id) =>
        container.read(communityMembersProvider(id)).requireValue;

    CommunityMembersController controller(String id) =>
        container.read(communityMembersProvider(id).notifier);

    test('loads 50 at a time, and only as far as asked', () async {
      final state = await load(large);
      expect(state.items, hasLength(50));
      expect(state.hasMore, isTrue);
      await controller(large).loadMore();
      expect(roster(large).items, hasLength(100));
      expect(roster(large).items.map((m) => m.userId).toSet(), hasLength(100));
      await pumpEventQueue();
      // Nothing walked ahead on its own.
      expect(repo.memberCursors, hasLength(2));
      expect(repo.membersBuilt, 100);
    });

    test('says "not yours to see" for a plain member', () async {
      final state = await load(open);
      expect(state.forbidden, isTrue);
      expect(state.items, isEmpty);
      expect(state.hasMore, isFalse);
    });

    test('follows access granted and taken back', () async {
      expect((await load(open)).forbidden, isTrue);

      repo.delegate(open, {CommunityCapability.membersView});
      realtime.emit(accessChanged(open));
      await pumpEventQueue();
      expect(roster(open).forbidden, isFalse);
      expect(roster(open).items, isNotEmpty);

      repo.delegate(open, {});
      realtime.emit(accessChanged(open));
      await pumpEventQueue();
      expect(roster(open).forbidden, isTrue);
      expect(roster(open).items, isEmpty);
    });

    test('starts over from the first page on refresh', () async {
      await load(large);
      await controller(large).loadMore();
      await controller(large).refresh();
      expect(roster(large).items, hasLength(50));
      expect(repo.memberCursors.last, isNull);
    });

    test('closes when the viewer is removed', () async {
      await load(owned);
      repo.endMembership(owned);
      realtime.emit(removed(owned));
      await pumpEventQueue();
      expect(roster(owned).gone, isTrue);
      expect(roster(owned).removed, isTrue);
      expect(roster(owned).items, isEmpty);
    });

    test('says "not yours", not "removed", for a first "not found"', () async {
      final never = await load('mock-community-nowhere');
      expect(never.gone, isTrue);
      expect(never.removed, isFalse);
      // Asked again, it is still only "not yours".
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      expect(roster('mock-community-nowhere').removed, isFalse);

      // A refusal to show the roster says the community was theirs.
      await load(open);
      repo.endMembership(open);
      realtime.emit(removed(open));
      await pumpEventQueue();
      expect(roster(open).gone, isTrue);
      expect(roster(open).removed, isTrue);
    });

    test(
      'goes back to the first page on reconnect, never walking on',
      () async {
        await load(large);
        await controller(large).loadMore();
        realtime.setStatus(RealtimeStatus.reconnected);
        await pumpEventQueue();
        expect(roster(large).items, hasLength(50));
        expect(repo.memberCursors.last, isNull);
        expect(repo.memberCursors, hasLength(3));
      },
    );

    test('keeps what is shown when a next page fails', () async {
      await load(large);
      repo.failWith = 'network.unreachable';
      await controller(large).loadMore();
      expect(roster(large).items, hasLength(50));
      expect(roster(large).loadMoreFailed, isTrue);
    });

    test(
      'reads the first page once more for a change that came while it loaded',
      () async {
        // The first page takes its answer: members shown...
        final hold = repo.holdMembers = Completer<void>();
        final loading = load(delegated);
        await pumpEventQueue();
        repo.holdMembers = null;
        // ...then the roster is taken back before that answer lands.
        repo.delegate(delegated, {});
        realtime.emit(accessChanged(delegated));
        await pumpEventQueue();
        hold.complete();
        await loading;
        await pumpEventQueue();
        expect(roster(delegated).forbidden, isTrue);
        expect(roster(delegated).items, isEmpty);
        expect(repo.memberCursors, [null, null]);
      },
    );

    test(
      'keeps a roster taken back closed when an older next page lands',
      () async {
        await load(delegated);
        // The next page takes its answer while the roster is still theirs...
        final hold = repo.holdMembers = Completer<void>();
        final more = controller(delegated).loadMore();
        await pumpEventQueue();
        repo.holdMembers = null;
        // ...then it is taken back, before that answer lands.
        repo.delegate(delegated, {});
        realtime.emit(accessChanged(delegated));
        await pumpEventQueue();
        expect(roster(delegated).forbidden, isTrue);
        hold.complete();
        await more;
        await pumpEventQueue();
        expect(roster(delegated).forbidden, isTrue);
        expect(roster(delegated).items, isEmpty);
        expect(roster(delegated).loadingMore, isFalse);
      },
    );

    test(
      'stays closed after a removal when an older next page lands',
      () async {
        await load(large);
        final hold = repo.holdMembers = Completer<void>();
        final more = controller(large).loadMore();
        await pumpEventQueue();
        repo.holdMembers = null;
        repo.endMembership(large);
        realtime.emit(removed(large));
        await pumpEventQueue();
        expect(roster(large).gone, isTrue);
        hold.complete();
        await more;
        await pumpEventQueue();
        expect(roster(large).gone, isTrue);
        expect(roster(large).items, isEmpty);
      },
    );

    test(
      'drops a next page asked for before a reconnect read the first again',
      () async {
        await load(large);
        await controller(large).loadMore();
        expect(roster(large).items, hasLength(100));
        // The third page takes its answer...
        final hold = repo.holdMembers = Completer<void>();
        final more = controller(large).loadMore();
        await pumpEventQueue();
        repo.holdMembers = null;
        // ...then a reconnect puts the first page back, before it lands.
        realtime.setStatus(RealtimeStatus.reconnected);
        await pumpEventQueue();
        expect(roster(large).items, hasLength(50));
        // Still on its way: no second next page starts meanwhile.
        expect(roster(large).loadingMore, isTrue);
        hold.complete();
        await more;
        await pumpEventQueue();
        expect(roster(large).items, hasLength(50));
        expect(roster(large).loadingMore, isFalse);
        // Walking on goes on from the first page, skipping nobody.
        await controller(large).loadMore();
        final ids = roster(large).items.map((m) => m.userId).toList();
        expect(ids, hasLength(100));
        expect(ids.toSet(), hasLength(100));
        expect(ids, contains('$large-member-50'));
        expect(ids, isNot(contains('$large-member-100')));
      },
    );
  });

  group('opening the community’s chat', () {
    Future<ChatOpening> openChat(String communityId) =>
        container.read(communityChatOpenerProvider).open(communityId);

    test('goes to the chat the server resolved, by its own id', () async {
      final opening = await openChat(open);
      expect(opening, isA<OpenChat>());
      expect((opening as OpenChat).location, '/messages/${chatOf(open)}');
    });

    test('says why when it cannot open', () async {
      messaging.leftCommunities.add(open);
      final gone = await openChat(open);
      expect(
        (gone as CannotOpenChat).message,
        CommunityCopy.chatUnavailable('messaging.conversation_not_found'),
      );

      for (final code in [
        'messaging.too_many_community_chat_lookups',
        'unavailable',
        'network.unreachable',
      ]) {
        messaging.chatLookupFailure = code;
        final refused = await openChat(owned);
        expect(
          (refused as CannotOpenChat).message,
          CommunityCopy.chatUnavailable(code),
          reason: code,
        );
      }
      expect(
        CommunityCopy.chatUnavailable(
          'messaging.too_many_community_chat_lookups',
        ),
        isNot(
          CommunityCopy.chatUnavailable('messaging.conversation_not_found'),
        ),
      );
    });

    test('says it cannot when the answer is not a conversation', () async {
      for (final garbled in <Object>[
        const FormatException('not JSON'),
        TypeError(),
      ]) {
        messaging.chatLookupGarbled = garbled;
        final opening = await openChat(open);
        expect(
          (opening as CannotOpenChat).message,
          CommunityCopy.chatUnavailable(null),
          reason: '$garbled',
        );
      }
      // Readable again: it opens.
      messaging.chatLookupGarbled = null;
      expect(await openChat(open), isA<OpenChat>());
    });
  });
}
