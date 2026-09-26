import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override, ProviderListenable;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/state/community_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_invitations_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_list_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_members_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_write.dart';
import 'package:quran_institution_app/features/communities/state/invitation_join_controller.dart';
import 'package:quran_institution_app/features/communities/state/member_grants_controller.dart';
import 'package:quran_institution_app/features/communities/state/pending_invitation.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// The viewer's own changes, against the mock server and a live connection
/// the test drives. Whatever order answers and frames come in:
///
///   - a change is one request: a second tap while it is on its way sends
///     nothing, and nothing is ever sent again on its own;
///   - nothing shown changes before the server has answered;
///   - an answer to a read sent before the server confirmed a change is
///     never shown after it — it is dropped, and read again;
///   - what a change touched is read again once it is answered (a refusal
///     included), so what is offered follows the server's `me`.
void main() {
  const open = MockCommunityRepository.openId;
  const owned = MockCommunityRepository.ownedId;
  const delegated = MockCommunityRepository.delegatedId;
  const invited = MockCommunityRepository.invitedId;
  const founder = MockCommunityRepository.founder;

  /// Row 2 of the owned community: one of the mock's teachers, whom it lets
  /// hold capabilities and own a community.
  const teacher = '$founder-2';

  /// Row 3: a student, whom it lets do neither.
  const student = '$owned-member-3';

  late ScriptedCommunities repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  void boot({List<Override> extra = const [], bool demo = true}) {
    container = ProviderContainer(
      overrides: [
        if (demo) communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        realtimeConnectionProvider.overrideWithValue(realtime),
        ...extra,
      ],
    );
    addTearDown(container.dispose);
  }

  setUp(() {
    repo = ScriptedCommunities();
    realtime = FakeRealtimeClient();
    boot();
  });

  /// Keeps [provider] alive for the test, as a screen watching it would.
  void keep(ProviderListenable<Object?> provider) {
    final subscription = container.listen(provider, (_, _) {});
    addTearDown(subscription.close);
  }

  Future<CommunityDetailState> loadCommunity(String id) {
    keep(communityProvider(id));
    return container.read(communityProvider(id).future);
  }

  Future<CommunityListState> loadList() {
    keep(communityListProvider);
    return container.read(communityListProvider.future);
  }

  CommunityDetailState detail(String id) =>
      container.read(communityProvider(id)).requireValue;

  CommunityController detailOf(String id) =>
      container.read(communityProvider(id).notifier);

  Community item(String id) => container
      .read(communityListProvider)
      .requireValue
      .items
      .firstWhere((c) => c.id == id);

  List<String> listed() => [
    for (final c in container.read(communityListProvider).requireValue.items)
      c.id,
  ];

  /// Every state [provider] shows from now on — settled ones, not those
  /// kept on screen while it loads.
  List<T> record<T>(ProviderListenable<AsyncValue<T>> provider) {
    final shown = <T>[];
    final subscription = container.listen(provider, (_, next) {
      if (next case AsyncData(:final value) when !next.isLoading) {
        shown.add(value);
      }
    });
    addTearDown(subscription.close);
    return shown;
  }

  group('one community: lock, unlock, leave', () {
    test('locks with one request — shown only once answered, then read '
        'again with its row in the list', () async {
      await loadCommunity(owned);
      await loadList();
      final hold = repo.holdWrites = Completer<void>();
      final locking = detailOf(owned).lock();
      await pumpEventQueue();
      // Done by the server, not yet answered: nothing shown has moved.
      expect(repo.writes, ['lock $owned']);
      expect(detail(owned).writing, CommunityWrite.lock);
      expect(detail(owned).community!.isLocked, isFalse);
      expect(item(owned).isLocked, isFalse);

      hold.complete();
      expect(await locking, isA<WriteDone<void>>());
      expect(detail(owned).writing, isNull);
      expect(detail(owned).community!.isLocked, isTrue);
      expect(item(owned).isLocked, isTrue);
      // The build's read, then the community and its row read again.
      expect(repo.communityRequests, [owned, owned, owned]);
      expect(repo.writes, ['lock $owned']);
    });

    test('unlocks the same way', () async {
      repo.changeStatus(owned, CommunityStatus.locked);
      await loadCommunity(owned);
      expect(detail(owned).community!.isLocked, isTrue);
      expect(await detailOf(owned).unlock(), isA<WriteDone<void>>());
      expect(detail(owned).community!.isLocked, isFalse);
      expect(repo.writes, ['unlock $owned']);
    });

    test('sends one change at a time, however often tapped', () async {
      await loadCommunity(owned);
      final hold = repo.holdWrites = Completer<void>();
      final first = detailOf(owned).lock();
      for (final again in [
        detailOf(owned).lock,
        detailOf(owned).unlock,
        detailOf(owned).leave,
      ]) {
        expect(await again(), isA<WriteNotSent<void>>());
      }
      hold.complete();
      expect(await first, isA<WriteDone<void>>());
      expect(repo.writes, ['lock $owned']);
    });

    test('sends nothing before the community is shown', () async {
      final hold = repo.holdCommunity = Completer<void>();
      keep(communityProvider(owned));
      expect(await detailOf(owned).lock(), isA<WriteNotSent<void>>());
      hold.complete();
      await container.read(communityProvider(owned).future);
      repo.endMembership(owned);
      realtime.emit(removed(owned));
      await pumpEventQueue();
      expect(detail(owned).removed, isTrue);
      expect(await detailOf(owned).lock(), isA<WriteNotSent<void>>());
      expect(repo.writes, isEmpty);
    });

    test('a refusal reads the community again — the button goes with the '
        'right', () async {
      repo.delegate(delegated, {
        CommunityCapability.membersView,
        CommunityCapability.lock,
      });
      await loadCommunity(delegated);
      expect(
        detail(delegated).community!.me.has(CommunityCapability.lock),
        isTrue,
      );
      // Taken back, and no frame said so.
      repo.delegate(delegated, {CommunityCapability.membersView});
      final outcome = await detailOf(delegated).lock();
      expect(
        (outcome as WriteFailed<void>).error.code,
        'communities.capability_required',
      );
      expect(repo.communityRequests, [delegated, delegated]);
      expect(
        detail(delegated).community!.me.has(CommunityCapability.lock),
        isFalse,
      );
      expect(detail(delegated).writing, isNull);
    });

    test('with no answer, or none to act on, sends nothing again and reads '
        'nothing', () async {
      await loadCommunity(owned);
      for (final code in [
        'network.unreachable',
        'unavailable',
        'communities.too_many_attempts',
        'identity.authentication_required',
      ]) {
        repo.failWritesWith = code;
        final outcome = await detailOf(owned).lock();
        expect((outcome as WriteFailed<void>).error.code, code);
      }
      expect(repo.writes, List.filled(4, 'lock $owned'));
      expect(repo.communityRequests, [owned]);
      expect(detail(owned).writing, isNull);
    });

    test('never shows an answer read before the lock was confirmed', () async {
      await loadCommunity(owned);
      final shown = record(communityProvider(owned));
      // A read takes its answer — open — and is slow to hand it over...
      final stale = repo.holdCommunity = Completer<void>();
      realtime.emit(accessChanged(owned));
      await pumpEventQueue();
      final fresh = repo.holdCommunity = Completer<void>();
      // ...while the viewer locks the community, and the server confirms.
      final locking = detailOf(owned).lock();
      await pumpEventQueue();
      expect(repo.writes, ['lock $owned']);
      final before = shown.length;

      stale.complete();
      await pumpEventQueue();
      // Landed after the confirmation: not shown — and read again.
      expect(shown, hasLength(before));
      expect(repo.communityRequests, [owned, owned, owned]);
      fresh.complete();
      expect(await locking, isA<WriteDone<void>>());
      expect(detail(owned).community!.isLocked, isTrue);
      expect(shown.last.community!.isLocked, isTrue);
    });

    test('never lets a refresh answered before the lock was done undo '
        'it', () async {
      final gated = _GatedWrites();
      repo = gated;
      boot();
      await loadCommunity(owned);
      final shown = record(communityProvider(owned));
      final gate = gated.gate = Completer<void>();
      final locking = detailOf(owned).lock();
      await pumpEventQueue();
      // A refresh reads the community — open — before the lock is done...
      final stale = repo.holdCommunity = Completer<void>();
      final refreshing = detailOf(owned).refresh();
      await pumpEventQueue();
      repo.holdCommunity = null;
      // ...and hands its answer over once the lock was confirmed.
      gate.complete();
      await pumpEventQueue();
      final confirmedAt = shown.length;
      stale.complete();
      await refreshing;
      await locking;
      expect(shown.skip(confirmedAt), isNotEmpty);
      expect(
        shown.skip(confirmedAt).map((s) => s.community!.isLocked),
        everyElement(isTrue),
      );
      expect(repo.writes, ['lock $owned']);
    });

    test('takes the echo of its own lock as a hint, and reads nothing for it '
        'once the version is shown', () async {
      await loadCommunity(owned);
      final hold = repo.holdWrites = Completer<void>();
      final locking = detailOf(owned).lock();
      await pumpEventQueue();
      // The frame for this very lock overtakes its answer: a read, which
      // already sees it.
      final version = repo.changeStatus(owned, CommunityStatus.locked);
      realtime.emit(locked(owned, version));
      await pumpEventQueue();
      expect(detail(owned).community!.isLocked, isTrue);
      hold.complete();
      await locking;
      expect(repo.communityRequests, [owned, owned, owned]);
      realtime.emit(locked(owned, version)); // told twice
      await pumpEventQueue();
      expect(repo.communityRequests, hasLength(3));
      expect(repo.writes, ['lock $owned']);
    });

    test('leaves: gone at once, out of the list at once, and no answer read '
        'before brings it back', () async {
      await loadCommunity(open);
      await loadList();
      // A read of the community and one of the list take their answers —
      // still a member — and are slow to hand them over...
      final staleCommunity = repo.holdCommunity = Completer<void>();
      realtime.emit(accessChanged(open));
      final staleList = repo.holdList = Completer<void>();
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      final freshCommunity = repo.holdCommunity = Completer<void>();
      final freshList = repo.holdList = Completer<void>();
      // ...while the viewer leaves, and the server confirms.
      expect(await detailOf(open).leave(), isA<WriteDone<void>>());
      expect(repo.writes, ['leave $open']);
      expect(detail(open).removed, isTrue);
      expect(detail(open).community!.title, isNotEmpty); // still says which
      expect(listed(), isNot(contains(open)));

      staleCommunity.complete();
      staleList.complete();
      await pumpEventQueue();
      // Landed after the leave was confirmed: shown nowhere.
      expect(detail(open).removed, isTrue);
      expect(listed(), isNot(contains(open)));

      freshCommunity.complete();
      freshList.complete();
      await pumpEventQueue();
      expect(detail(open).removed, isTrue);
      expect(listed(), isNot(contains(open)));
      expect(listed(), hasLength(seededIds.length - 1));
    });

    test('a refused leave reads the community again', () async {
      await loadCommunity(owned);
      final outcome = await detailOf(owned).leave();
      expect(
        (outcome as WriteFailed<void>).error.code,
        'communities.owner_cannot_leave',
      );
      expect(repo.communityRequests, [owned, owned]);
      expect(detail(owned).removed, isFalse);
    });

    test('catches up on reconnect after a change it never heard of', () async {
      await loadCommunity(owned);
      realtime.setStatus(RealtimeStatus.reconnecting);
      repo.changeStatus(owned, CommunityStatus.locked);
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      expect(detail(owned).community!.isLocked, isTrue);
    });
  });

  group('the roster: removing, handing over', () {
    Future<CommunityMembersState> loadRoster(String id) {
      keep(communityMembersProvider(id));
      return container.read(communityMembersProvider(id).future);
    }

    CommunityMembersState roster(String id) =>
        container.read(communityMembersProvider(id)).requireValue;

    CommunityMembersController rosterOf(String id) =>
        container.read(communityMembersProvider(id).notifier);

    List<String> ids(String id) => [for (final m in roster(id).items) m.userId];

    test('removes with one request; the roster, the count and the row in '
        'the list are read again', () async {
      await loadCommunity(owned);
      await loadList();
      await loadRoster(owned);
      expect(ids(owned), contains(student));
      final hold = repo.holdWrites = Completer<void>();
      final removing = rosterOf(owned).remove(student);
      await pumpEventQueue();
      expect(roster(owned).writing, {student: MemberWrite.remove});
      expect(ids(owned), contains(student)); // not before the answer
      hold.complete();
      expect(await removing, isA<WriteDone<void>>());
      expect(ids(owned), isNot(contains(student)));
      expect(roster(owned).writing, isEmpty);
      expect(detail(owned).community!.memberCount, 11);
      expect(item(owned).memberCount, 11);
      expect(repo.writes, ['removeMember $owned $student']);
      expect(repo.memberCursors, [null, null]);
    });

    test('one request per member, however often tapped — another member is '
        'another request', () async {
      await loadRoster(owned);
      final hold = repo.holdWrites = Completer<void>();
      final first = rosterOf(owned).remove(student);
      expect(await rosterOf(owned).remove(student), isA<WriteNotSent<void>>());
      expect(
        await rosterOf(owned).transferOwnership(student),
        isA<WriteNotSent<void>>(),
      );
      final other = rosterOf(owned).remove('$owned-member-4');
      expect(roster(owned).writing.keys, {student, '$owned-member-4'});
      hold.complete();
      await Future.wait([first, other]);
      expect(repo.writes, [
        'removeMember $owned $student',
        'removeMember $owned $owned-member-4',
      ]);
    });

    test('never brings a removed member back with a page asked for before '
        'the removal was confirmed', () async {
      repo = ScriptedCommunities(memberPageSize: 5);
      boot();
      await loadRoster(owned);
      const later = '$owned-member-6'; // on the second page
      expect(ids(owned), isNot(contains(later)));
      // The next page takes its answer — with the member on it...
      final stalePage = repo.holdMembers = Completer<void>();
      final more = rosterOf(owned).loadMore();
      await pumpEventQueue();
      final fresh = repo.holdMembers = Completer<void>();
      // ...then they are removed, and the server confirms, before it lands.
      final removing = rosterOf(owned).remove(later);
      await pumpEventQueue();
      expect(repo.writes, ['removeMember $owned $later']);
      stalePage.complete();
      await more;
      expect(ids(owned), isNot(contains(later)));
      expect(roster(owned).loadingMore, isFalse);

      fresh.complete();
      expect(await removing, isA<WriteDone<void>>());
      while (roster(owned).hasMore) {
        await rosterOf(owned).loadMore();
      }
      expect(ids(owned), hasLength(11));
      expect(ids(owned), isNot(contains(later)));
    });

    test('never shows a first page asked for before the removal was '
        'confirmed', () async {
      await loadRoster(owned);
      final shown = record(communityMembersProvider(owned));
      // A reload takes its answer — with the member in it...
      final stale = repo.holdMembers = Completer<void>();
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      final fresh = repo.holdMembers = Completer<void>();
      // ...then they are removed, and the server confirms, before it lands.
      final removing = rosterOf(owned).remove(student);
      await pumpEventQueue();
      final before = shown.length;
      stale.complete();
      await pumpEventQueue();
      expect(shown, hasLength(before)); // dropped, not shown
      expect(repo.memberCursors, [null, null, null]); // and asked again
      fresh.complete();
      expect(await removing, isA<WriteDone<void>>());
      expect(ids(owned), isNot(contains(student)));
    });

    test('never lets a refresh answered before the removal was done undo '
        'it', () async {
      final gated = _GatedWrites();
      repo = gated;
      boot();
      await loadRoster(owned);
      final shown = record(communityMembersProvider(owned));
      final gate = gated.gate = Completer<void>();
      final removing = rosterOf(owned).remove(student);
      await pumpEventQueue();
      // A refresh reads the first page — with the member — before the
      // removal is done...
      final stale = repo.holdMembers = Completer<void>();
      final refreshing = rosterOf(owned).refresh();
      await pumpEventQueue();
      repo.holdMembers = null;
      // ...and hands it over once the removal was confirmed.
      gate.complete();
      await pumpEventQueue();
      final confirmedAt = shown.length;
      stale.complete();
      await refreshing;
      await removing;
      expect(shown.skip(confirmedAt), isNotEmpty);
      for (final state in shown.skip(confirmedAt)) {
        expect(state.items.map((m) => m.userId), isNot(contains(student)));
      }
    });

    test('reads the roster again for a frame during a removal, and once '
        'more after it', () async {
      await loadRoster(owned);
      final hold = repo.holdWrites = Completer<void>();
      final removing = rosterOf(owned).remove(student);
      await pumpEventQueue();
      realtime.emit(accessChanged(owned));
      await pumpEventQueue();
      hold.complete();
      await removing;
      expect(repo.memberCursors, [null, null, null]);
      expect(ids(owned), isNot(contains(student)));
      expect(repo.writes, hasLength(1));
    });

    test('a refusal reads the roster and the community again', () async {
      repo.delegate(delegated, {
        CommunityCapability.membersView,
        CommunityCapability.membersRemove,
      });
      await loadCommunity(delegated);
      await loadRoster(delegated);
      // Rows carry no standing: the owner's is offered like any other, and
      // the server refuses.
      final outcome = await rosterOf(delegated).remove(founder);
      expect(
        (outcome as WriteFailed<void>).error.code,
        'communities.owner_not_removable',
      );
      expect(repo.memberCursors, [null, null]);
      expect(repo.communityRequests, [delegated, delegated]);
      expect(ids(delegated), contains(founder));
    });

    test('hands the community over: the viewer’s standing, the roster and '
        'the list follow the server', () async {
      await loadCommunity(owned);
      await loadList();
      await loadRoster(owned);
      final outcome = await rosterOf(owned).transferOwnership(teacher);
      expect(outcome, isA<WriteDone<void>>());
      expect(repo.writes, ['transferOwnership $owned $teacher']);
      final me = detail(owned).community!.me;
      expect(me.standing, CommunityStanding.member);
      expect(me.operations, {CommunityOperation.leave});
      expect(item(owned).me.standing, CommunityStanding.member);
      // No longer theirs to see.
      expect(roster(owned).forbidden, isTrue);
    });

    test('a refused hand-over reads again, and changes nothing', () async {
      await loadCommunity(owned);
      await loadRoster(owned);
      final outcome = await rosterOf(owned).transferOwnership(student);
      expect(
        (outcome as WriteFailed<void>).error.code,
        'communities.owner_ineligible',
      );
      expect(detail(owned).community!.me.standing, CommunityStanding.owner);
      expect(repo.communityRequests, [owned, owned]);
      expect(repo.memberCursors, [null, null]);
    });
  });

  group('invitation links', () {
    Future<CommunityInvitationsState> loadLinks(String id) {
      keep(communityInvitationsProvider(id));
      return container.read(communityInvitationsProvider(id).future);
    }

    CommunityInvitationsState links(String id) =>
        container.read(communityInvitationsProvider(id)).requireValue;

    CommunityInvitationsController linksOf(String id) =>
        container.read(communityInvitationsProvider(id).notifier);

    test('lists the links newest first, a page at a time', () async {
      repo = ScriptedCommunities(invitationPageSize: 1);
      boot();
      final first = await loadLinks(owned);
      expect(first.items.map((i) => i.state), [InvitationState.active]);
      expect(first.hasMore, isTrue);
      await linksOf(owned).loadMore();
      expect(links(owned).items.map((i) => i.state), [
        InvitationState.active,
        InvitationState.expired,
      ]);
      expect(links(owned).hasMore, isFalse);
      expect(repo.invitationCursors, hasLength(2));
    });

    test('says "not yours" to a plain member, and "gone" for a community '
        'not theirs', () async {
      expect((await loadLinks(open)).forbidden, isTrue);
      expect((await loadLinks('mock-community-nowhere')).gone, isTrue);
    });

    test('makes a link with one request, hands its token over once, and '
        'reads the list again', () async {
      await loadLinks(owned);
      final outcome = await linksOf(owned).create();
      final created = (outcome as WriteDone<CreatedInvitation>).value;
      expect(isInvitationTokenShaped(created.token), isTrue);
      expect(repo.writes, ['createInvitation $owned']);
      expect(links(owned).items.first.id, created.invitation.id);
      expect(links(owned).items, hasLength(3));
      expect(links(owned).creating, isFalse);
      expect(repo.invitationCursors, [null, null]);
    });

    test('never makes a link again on its own — not after a lost answer, '
        'not for a second tap', () async {
      await loadLinks(owned);
      repo.failWritesWith = 'network.unreachable';
      final lost = await linksOf(owned).create();
      expect((lost as WriteFailed<CreatedInvitation>).error.isNetwork, isTrue);
      expect(repo.writes, ['createInvitation $owned']);
      expect(repo.invitationCursors, [null]); // nothing read for it either

      repo.failWritesWith = null;
      final hold = repo.holdWrites = Completer<void>();
      final first = linksOf(owned).create();
      expect(links(owned).creating, isTrue);
      expect(
        await linksOf(owned).create(),
        isA<WriteNotSent<CreatedInvitation>>(),
      );
      hold.complete();
      await first;
      expect(repo.writes, hasLength(2));
    });

    test('revokes with one request per link, and reads the list '
        'again', () async {
      await loadLinks(owned);
      final active = links(owned).items.first;
      expect(active.state, InvitationState.active);
      final hold = repo.holdWrites = Completer<void>();
      final revoking = linksOf(owned).revoke(active.id);
      expect(links(owned).revoking, {active.id});
      expect(await linksOf(owned).revoke(active.id), isA<WriteNotSent<void>>());
      hold.complete();
      expect(await revoking, isA<WriteDone<void>>());
      expect(links(owned).items.first.state, InvitationState.revoked);
      expect(links(owned).revoking, isEmpty);
      expect(repo.writes, ['revokeInvitation $owned ${active.id}']);
    });

    test('a refusal reads the community and the list again', () async {
      await loadCommunity(owned);
      await loadLinks(owned);
      // Locked meanwhile, and not yet told: a new link is refused.
      repo.changeStatus(owned, CommunityStatus.locked);
      final outcome = await linksOf(owned).create();
      expect(
        (outcome as WriteFailed<CreatedInvitation>).error.isLocked,
        isTrue,
      );
      expect(repo.communityRequests, [owned, owned]);
      expect(detail(owned).community!.isLocked, isTrue);
      expect(
        detail(owned).community!.me.has(CommunityCapability.membersInvite),
        isFalse,
      );
      expect(repo.invitationCursors, [null, null]);
    });

    test('never shows a list read before a new link was confirmed', () async {
      await loadLinks(owned);
      final shown = record(communityInvitationsProvider(owned));
      final stale = repo.holdInvitations = Completer<void>();
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      final fresh = repo.holdInvitations = Completer<void>();
      final creating = linksOf(owned).create();
      await pumpEventQueue();
      expect(repo.writes, ['createInvitation $owned']);
      final before = shown.length;
      stale.complete();
      await pumpEventQueue();
      expect(shown, hasLength(before));
      fresh.complete();
      final created = (await creating) as WriteDone<CreatedInvitation>;
      expect(links(owned).items.first.id, created.value.invitation.id);
    });

    test('drops a next page asked for before a change was answered', () async {
      repo = ScriptedCommunities(invitationPageSize: 1);
      boot();
      await loadLinks(owned);
      final stalePage = repo.holdInvitations = Completer<void>();
      final more = linksOf(owned).loadMore();
      await pumpEventQueue();
      repo.holdInvitations = null;
      await linksOf(owned).create();
      stalePage.complete();
      await more;
      // The first page, read after the new link: that link, and more.
      expect(links(owned).items, hasLength(1));
      expect(links(owned).items.single.state, InvitationState.active);
      expect(links(owned).hasMore, isTrue);
      expect(links(owned).loadingMore, isFalse);
    });

    test('reads the list again when the viewer’s access changes, and on '
        'reconnect', () async {
      repo.delegate(open, {
        CommunityCapability.membersView,
        CommunityCapability.membersInvite,
      });
      await loadLinks(open);
      expect(links(open).forbidden, isFalse);
      repo.delegate(open, {CommunityCapability.membersView});
      realtime.emit(accessChanged(open));
      await pumpEventQueue();
      expect(links(open).forbidden, isTrue);
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      expect(repo.invitationCursors, [null, null, null]);
    });
  });

  group('a member’s grants', () {
    const key = (communityId: owned, userId: teacher);

    Future<MemberGrantsState> loadGrants(MemberKey member) {
      keep(memberGrantsProvider(member));
      return container.read(memberGrantsProvider(member).future);
    }

    MemberGrantsState grants(MemberKey member) =>
        container.read(memberGrantsProvider(member)).requireValue;

    MemberGrantsController grantsOf(MemberKey member) =>
        container.read(memberGrantsProvider(member).notifier);

    Set<CommunityCapability> held(MemberKey member) => {
      for (final g in grants(member).grants) g.capability,
    };

    test('lists what the server lists for the member', () async {
      await loadGrants(key);
      expect(held(key), {CommunityCapability.membersView});
      expect(repo.grantRequests, [teacher]);
    });

    test('grants the chosen capabilities in one request, and reads the '
        'grants again', () async {
      await loadGrants(key);
      final hold = repo.holdWrites = Completer<void>();
      final granting = grantsOf(key)
          .grant({CommunityCapability.membersInvite, CommunityCapability.lock});
      expect(grants(key).writing, isA<Granting>());
      expect(held(key), {CommunityCapability.membersView});
      hold.complete();
      final change = (await granting) as WriteDone<GrantChange>;
      expect(change.value.created, hasLength(2));
      expect(held(key), {
        CommunityCapability.membersView,
        CommunityCapability.membersInvite,
        CommunityCapability.lock,
      });
      expect(repo.writes, ['grant $owned $teacher']);
      expect(repo.grantRequests, [teacher, teacher]);
      expect(grants(key).writing, isNull);
    });

    test('revokes one grant with one request', () async {
      await loadGrants(key);
      final grant = grants(key).grantOf(CommunityCapability.membersView)!;
      expect(await grantsOf(key).revoke(grant.grantId), isA<WriteDone<void>>());
      expect(held(key), isEmpty);
      expect(repo.writes, ['revokeGrant $owned ${grant.grantId}']);
    });

    test('one change at a time for the member; nothing chosen sends '
        'nothing', () async {
      await loadGrants(key);
      expect(await grantsOf(key).grant({}), isA<WriteNotSent<GrantChange>>());
      final hold = repo.holdWrites = Completer<void>();
      final first = grantsOf(key).grant({CommunityCapability.lock});
      expect(
        await grantsOf(key).grant({CommunityCapability.lock}),
        isA<WriteNotSent<GrantChange>>(),
      );
      expect(
        await grantsOf(key).revoke('any-grant'),
        isA<WriteNotSent<void>>(),
      );
      hold.complete();
      await first;
      expect(repo.writes, ['grant $owned $teacher']);
    });

    test('a refusal reads the grants and the community again', () async {
      const other = (communityId: owned, userId: student);
      await loadCommunity(owned);
      await loadGrants(other);
      final outcome = await grantsOf(other).grant({CommunityCapability.lock});
      expect(
        (outcome as WriteFailed<GrantChange>).error.code,
        'communities.grantee_ineligible',
      );
      expect(repo.grantRequests, [student, student]);
      expect(repo.communityRequests, [owned, owned]);
    });

    test('shows none of another member’s grants to a viewer the server does '
        'not let manage them', () async {
      final member = (communityId: delegated, userId: founder);
      expect((await loadGrants(member)).grants, isEmpty);
    });

    test('never shows grants read before a change was confirmed', () async {
      await loadGrants(key);
      final shown = record(memberGrantsProvider(key));
      final stale = repo.holdGrants = Completer<void>();
      realtime.emit(accessChanged(owned));
      await pumpEventQueue();
      final fresh = repo.holdGrants = Completer<void>();
      final granting = grantsOf(key).grant({CommunityCapability.lock});
      await pumpEventQueue();
      final before = shown.length;
      stale.complete();
      await pumpEventQueue();
      expect(shown, hasLength(before));
      fresh.complete();
      await granting;
      expect(held(key), contains(CommunityCapability.lock));
    });

    test('reads the grants again when access changes, and on '
        'reconnect', () async {
      await loadGrants(key);
      realtime.emit(accessChanged(owned));
      await pumpEventQueue();
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      expect(repo.grantRequests, [teacher, teacher, teacher]);
    });
  });

  group('the list, reconciled from a community’s screens', () {
    test('drops an older answer about a changed community, and reads it '
        'again', () async {
      await loadList();
      final shown = record(communityListProvider);
      // Someone locks it; the read for that takes its answer — locked...
      final stale = repo.holdCommunity = Completer<void>();
      final version = repo.changeStatus(owned, CommunityStatus.locked);
      realtime.emit(locked(owned, version));
      await pumpEventQueue();
      final fresh = repo.holdCommunity = Completer<void>();
      // ...then the viewer unlocks it on its own screen, and the server
      // confirms, before that answer lands.
      repo.changeStatus(owned, CommunityStatus.open);
      final reconciling = container
          .read(communityListProvider.notifier)
          .reconcileCommunity(owned);
      final before = shown.length;
      stale.complete();
      await pumpEventQueue();
      expect(shown, hasLength(before));
      expect(item(owned).isLocked, isFalse);
      fresh.complete();
      await reconciling;
      expect(item(owned).isLocked, isFalse);
      expect(item(owned).lifecycleVersion, version + 1);
    });

    test('reads the first page again for a community joined', () async {
      await loadList();
      await repo.join(MockCommunityRepository.demoActiveToken);
      await container
          .read(communityListProvider.notifier)
          .reconcileJoined(invited);
      expect(listed().first, invited);
    });
  });

  group('against the backend', () {
    test('signed out meanwhile: a change sends nothing, and reads '
        'nothing', () async {
      final server = CommunityServer({
        'GET /communities/c-1': (_) => jsonResponse(
          200,
          communityJson(id: 'c-1', capabilities: ['community.lock']),
        ),
      });
      final tokens = InMemoryTokenStore();
      boot(
        demo: false,
        extra: backendOverrides(server, signedIn: true, tokens: tokens),
      );
      await loadCommunity('c-1');
      await tokens.clear();
      final outcome = await detailOf('c-1').lock();
      expect((outcome as WriteFailed<void>).error.needsSignIn, isTrue);
      expect(server.calls, ['GET /communities/c-1']);
      expect(detail('c-1').writing, isNull);
    });
  });

  group('joining by link', () {
    const token = MockCommunityRepository.demoActiveToken;

    void start(String? atStartup) => boot(
      extra: [startupInvitationTokenProvider.overrideWithValue(atStartup)],
    );

    InvitationJoinState state() {
      keep(invitationJoinProvider);
      return container.read(invitationJoinProvider);
    }

    InvitationJoinController join() =>
        container.read(invitationJoinProvider.notifier);

    PendingInvitation? pending() => container.read(pendingInvitationProvider);

    test('has nothing to open without a link', () {
      start(null);
      expect(state(), isA<NoInvitation>());
    });

    test('closes at once on something with no token’s shape: sends nothing, '
        'and forgets it', () async {
      start('not-a-token');
      expect(state(), isA<ClosedInvitation>());
      expect((state() as ClosedInvitation).code, isNull);
      expect(await join().join(), isA<WriteNotSent<Community>>());
      await pumpEventQueue();
      expect(pending(), isNull);
      expect(repo.writes, isEmpty);
    });

    test('joins with one request: the link is forgotten, the list read '
        'again', () async {
      start(token);
      await loadList();
      expect(listed(), isNot(contains(invited)));
      expect(state(), isA<OpenInvitation>());
      final outcome = await join().join();
      expect((outcome as WriteDone<Community>).value.id, invited);
      expect(state(), isA<JoinedInvitation>());
      expect(pending(), isNull);
      expect(repo.writes, ['join']);
      await pumpEventQueue();
      expect(listed().first, invited);
    });

    test('sends one request however often tapped', () async {
      start(token);
      state();
      final hold = repo.holdWrites = Completer<void>();
      final first = join().join();
      expect((state() as OpenInvitation).joining, isTrue);
      for (var i = 0; i < 3; i++) {
        expect(await join().join(), isA<WriteNotSent<Community>>());
      }
      hold.complete();
      await first;
      expect(repo.writes, ['join']);
    });

    test('forgets a link refused for good, and says so', () async {
      for (final (link, code) in [
        (MockCommunityRepository.demoExpiredToken, 'invitation_expired'),
        (MockCommunityRepository.demoRevokedToken, 'invitation_revoked'),
        (MockCommunityRepository.demoExhaustedToken, 'invitation_exhausted'),
        ('Z' * 43, 'invitation_invalid'),
      ]) {
        start(link);
        state();
        final outcome = await join().join();
        expect(
          (outcome as WriteFailed<Community>).error.code,
          'communities.$code',
        );
        expect((state() as ClosedInvitation).code, 'communities.$code');
        expect(pending(), isNull, reason: code);
      }
      expect(repo.writes, List.filled(4, 'join'));
    });

    test('forgets it too when the way back is not by link, or the community '
        'takes nobody now', () async {
      start(token);
      state();
      await join().join();
      repo.endMembership(invited, removed: true);
      container.read(pendingInvitationProvider.notifier).offer(token);
      expect(
        ((await join().join()) as WriteFailed<Community>).error.code,
        'communities.rejoin_requires_manager',
      );
      expect(pending(), isNull);

      repo.restoreMembership(invited);
      repo.endMembership(invited);
      repo.changeStatus(invited, CommunityStatus.locked);
      container.read(pendingInvitationProvider.notifier).offer(token);
      expect(
        ((await join().join()) as WriteFailed<Community>).error.isLocked,
        isTrue,
      );
      expect(state(), isA<ClosedInvitation>());
      expect(pending(), isNull);
    });

    test('keeps the link through anything passing, for an explicit '
        'retry', () async {
      start(token);
      state();
      for (final code in [
        'network.unreachable',
        'unavailable',
        'communities.conflict',
        'communities.too_many_attempts',
      ]) {
        repo.failWritesWith = code;
        await join().join();
        final shown = state() as OpenInvitation;
        expect(shown.failure?.code, code);
        expect(shown.joining, isFalse);
        expect(pending()?.token, token);
      }
      repo.failWritesWith = null;
      expect(await join().join(), isA<WriteDone<Community>>());
      expect(repo.writes, List.filled(5, 'join'));
      expect(pending(), isNull);
    });

    test('keeps the link across a sign-in the server asked for', () async {
      start(token);
      state();
      repo.failWritesWith = 'identity.authentication_required';
      await join().join();
      expect((state() as OpenInvitation).signInNeeded, isTrue);
      expect(pending()?.token, token);
      join().backFromSignIn();
      final shown = state() as OpenInvitation;
      expect(shown.signInNeeded, isFalse);
      expect(shown.failure, isNull);
      repo.failWritesWith = null;
      expect(await join().join(), isA<WriteDone<Community>>());
    });

    test('starts over with a link opened while it shows another', () async {
      start(MockCommunityRepository.demoExpiredToken);
      state();
      await join().join();
      expect(state(), isA<ClosedInvitation>());
      container.read(pendingInvitationProvider.notifier).offer(token);
      expect(state(), isA<OpenInvitation>());
      expect(await join().join(), isA<WriteDone<Community>>());
    });

    test('lets a link opened during a join stand: its answer neither '
        'forgets nor replaces it', () async {
      start(token);
      state();
      final hold = repo.holdWrites = Completer<void>();
      final joining = join().join();
      await pumpEventQueue();
      final second = 'B' * 43;
      container.read(pendingInvitationProvider.notifier).offer(second);
      final shown = state() as OpenInvitation;
      expect(shown.joining, isFalse);
      hold.complete();
      expect(await joining, isA<WriteDone<Community>>());
      expect(pending()?.token, second);
      expect((state() as OpenInvitation).serial, shown.serial);
    });

    test('lives as long as its screen: back after the link was used, there '
        'is nothing to open', () async {
      start(token);
      final subscription = container.listen(invitationJoinProvider, (_, _) {});
      await container.read(invitationJoinProvider.notifier).join();
      subscription.close();
      await pumpEventQueue();
      expect(state(), isA<NoInvitation>());
    });
  });
}

/// The scripted server, but a lock or a removal is done only once [gate]
/// opens — so a read can be answered after the request was sent, and before
/// it was done.
class _GatedWrites extends ScriptedCommunities {
  Completer<void>? gate;

  @override
  Future<Community> lock(String communityId) async {
    await gate?.future;
    return super.lock(communityId);
  }

  @override
  Future<void> removeMember(String communityId, String userId) async {
    await gate?.future;
    return super.removeMember(communityId, userId);
  }
}
