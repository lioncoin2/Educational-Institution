import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../app/backend_config.dart';
import '../app/invite_link.dart';
import '../data/api/api_client.dart';
import '../data/api/secure_token_store.dart';
import '../data/api/token_store.dart';
import '../data/media/live_media_seams.dart';
import '../data/media/livekit/livekit_live_media_client.dart';
import '../data/media/media_seams.dart';
import '../data/media/pickers/file_picker_attachment_picker.dart';
import '../data/media/voice/just_audio_voice_player.dart';
import '../data/media/voice/record_voice_recorder.dart';
import '../data/models/auth.dart';

import '../data/models/certificate.dart';
import '../data/models/communities.dart';
import '../data/models/feed.dart';
import '../data/models/institution.dart';
import '../data/models/learning.dart';
import '../data/models/progress.dart';
import '../data/models/program.dart';
import '../data/models/student.dart';
import '../data/push/push_seams.dart';
import '../data/realtime/realtime_client.dart';
import '../data/realtime/websocket_realtime_client.dart';
import '../data/repositories/academic/academic_catalog_repository.dart';
import '../data/repositories/academic/academic_learning_repository.dart';
import '../data/repositories/academic/academic_profile_repositories.dart';
import '../data/repositories/http/http_academic_repository.dart';
import '../data/repositories/http/http_admin_repository.dart';
import '../data/repositories/http/http_attendance_repository.dart';
import '../data/repositories/http/http_auth_repository.dart';
import '../data/repositories/http/http_community_repository.dart';
import '../data/repositories/http/http_files_repository.dart';
import '../data/repositories/http/http_live_repository.dart';
import '../data/repositories/http/http_messaging_repository.dart';
import '../data/repositories/http/http_notifications_repository.dart';
import '../data/repositories/http/http_people_repository.dart';
import '../data/repositories/mock/mock_academic_repository.dart';
import '../data/repositories/mock/mock_admin_repository.dart';
import '../data/repositories/mock/mock_attendance_repository.dart';
import '../data/repositories/mock/mock_auth_repository.dart';
import '../data/repositories/mock/mock_community_repository.dart';
import '../data/repositories/mock/mock_files_repository.dart';
import '../data/repositories/mock/mock_live_repository.dart';
import '../data/repositories/mock/mock_messaging_repository.dart';
import '../data/repositories/mock/mock_notifications_repository.dart';
import '../data/repositories/mock/mock_people_repository.dart';
import '../data/repositories/mock/mock_repositories.dart';
import '../data/repositories/repositories.dart';

// ── Repository wiring ──────────────────────────────────────────────────────

/// The real backend when API_BASE_URL is set at build time; the in-memory
/// demo otherwise (the GitHub Pages build, widget tests). A provider, so a
/// test can run the app in either mode.
final backendModeProvider = Provider<bool>((ref) => BackendConfig.isConfigured);

/// The institution's academic structure and the signed-in person's place in
/// it: `/academic` against the backend, the profile's structure in the demo.
final Provider<AcademicRepository> academicRepositoryProvider =
    Provider<AcademicRepository>(
      (ref) => ref.watch(backendModeProvider)
          ? HttpAcademicRepository(ref.watch(apiClientProvider))
          : MockAcademicRepository(),
    );

/// The institution is described by its profile in both modes; the person is
/// the signed-in account and its academic record against the backend, and
/// the demo's placeholder learner otherwise.
/// Against the backend, the person described is the signed-in account — so
/// the repository is per account: rebuilt when the account changes, and with
/// it every learner provider that reads it (they are kept alive on tabs that
/// stay mounted; without this, the next person on a shared device would see
/// the last one's name and record).
final Provider<InstitutionRepository> institutionRepositoryProvider =
    Provider<InstitutionRepository>((ref) {
      if (!ref.watch(backendModeProvider)) {
        return const MockInstitutionRepository();
      }
      ref.watch(sessionUserProvider.select((session) => session.value?.id));
      return AcademicInstitutionRepository(
        ref.watch(academicRepositoryProvider),
        ref.watch(authRepositoryProvider),
      );
    });

/// Always read through an academic repository. Against the backend, the
/// structure is the institution's records for whoever is signed in; to a
/// visitor who is not (the server answers nobody), it is the printed
/// profile's — the structure the demo shows, marked with its pages — so the
/// home and programs screens still say what the institution offers.
final catalogRepositoryProvider = Provider<CatalogRepository>((ref) {
  final signedIn =
      ref.watch(backendModeProvider) &&
      ref.watch(sessionUserProvider.select((session) => session.value != null));
  return AcademicCatalogRepository(
    signedIn ? ref.watch(academicRepositoryProvider) : MockAcademicRepository(),
  );
});

/// Against the backend: the learner's real enrollments and no progress (none
/// is recorded) — the signed-in learner's, so rebuilt when the account
/// changes (see [institutionRepositoryProvider]). In the demo: the
/// placeholder path, lessons and progress.
final learningRepositoryProvider = Provider<LearningRepository>((ref) {
  if (!ref.watch(backendModeProvider)) return const MockLearningRepository();
  ref.watch(sessionUserProvider.select((session) => session.value?.id));
  return AcademicLearningRepository(ref.watch(academicRepositoryProvider));
});
final progressRepositoryProvider = Provider<ProgressRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? const UnrecordedProgressRepository()
      : const MockProgressRepository(),
);
final certificateRepositoryProvider = Provider<CertificateRepository>(
  (ref) => const MockCertificateRepository(),
);
final feedRepositoryProvider = Provider<FeedRepository>(
  (ref) => const MockFeedRepository(),
);

final Provider<AuthRepository> authRepositoryProvider =
    Provider<AuthRepository>(
      (ref) => ref.watch(backendModeProvider)
          ? HttpAuthRepository(ref.watch(apiClientProvider))
          : MockAuthRepository(),
    );

/// The signed-in user's own files — profile picture and owned uploads.
final Provider<FilesRepository> filesRepositoryProvider =
    Provider<FilesRepository>(
      (ref) => ref.watch(backendModeProvider)
          ? HttpFilesRepository(ref.watch(apiClientProvider))
          : const MockFilesRepository(),
    );

// ── Backend access ─────────────────────────────────────────────────────────
// Overridden in tests with package:http's MockClient.

final httpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

/// Secure, persistent token storage against the real backend — iOS Keychain /
/// Android Keystore, so a signed-in device survives a restart. The demo build
/// has no server session to keep, so it stays in memory. Tests override this.
final tokenStoreProvider = Provider<TokenStore>(
  (ref) => ref.watch(backendModeProvider)
      ? SecureTokenStore()
      : InMemoryTokenStore(),
);

final Provider<ApiClient> apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(
    baseUri: BackendConfig.baseUri,
    httpClient: ref.watch(httpClientProvider),
    tokenStore: ref.watch(tokenStoreProvider),
    // Through the container: the session is read through this very client,
    // and a debug build refuses a provider invalidating one that depends on
    // it (a CircularDependencyError in place of the sign-out).
    onSignedOut: () => ref.container.invalidate(sessionUserProvider),
  ),
);

/// Who is signed in on this device, if anyone.
final FutureProvider<CurrentUser?> sessionUserProvider =
    FutureProvider<CurrentUser?>(
      (ref) => ref.watch(authRepositoryProvider).currentUser(),
      retry: (_, _) => null,
    );

/// A short-lived link to the signed-in user's own profile picture, or null
/// when they have none. Resolved from their `avatarFileAssetId`; a failure
/// degrades to null so the UI simply shows initials.
final FutureProvider<Uri?> ownAvatarUrlProvider = FutureProvider<Uri?>((
  ref,
) async {
  final user = await ref.watch(sessionUserProvider.future);
  final assetId = user?.avatarFileAssetId;
  if (assetId == null) return null;
  try {
    return await ref.watch(filesRepositoryProvider).ownAssetLink(assetId);
  } on Object {
    return null;
  }
});

// ── Messaging ──────────────────────────────────────────────────────────────

final messagingRepositoryProvider = Provider<MessagingRepository>((ref) {
  if (ref.watch(backendModeProvider)) {
    return HttpMessagingRepository(
      ref.watch(apiClientProvider),
      ref.watch(authRepositoryProvider),
    );
  }
  // The demo's two mocks tell one story, as the server's modules do: a
  // community's chat is read, and posted in, as that community's `me` says
  // now — joined, left, locked or handed over.
  final communities = ref.watch(communityRepositoryProvider);
  if (communities is! MockCommunityRepository) return MockMessagingRepository();
  return MockMessagingRepository(
    mayReadIn: (id) =>
        communities.meIn(id)?.takesPart(CommunityParticipation.chatRead) ??
        false,
    // Posting is mode-aware now (ADR 0039): an open group's member posts on
    // membership, a restricted group's or a channel's only with the publisher
    // capability. The community's `me.canPost` already resolves this; the two
    // mocks tell one story, so the chat's composer follows it.
    mayPostIn: (id) => communities.meIn(id)?.canPost ?? false,
  );
});

// ── Communities ────────────────────────────────────────────────────────────
// The lists, the open community and its roster live in
// features/communities/state; this is the seam under them.

final communityRepositoryProvider = Provider<CommunityRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpCommunityRepository(ref.watch(apiClientProvider))
      : MockCommunityRepository(),
);

/// People discovery — the OWNER/ADMIN institution-wide directory (`GET /people`,
/// `people.read`) and the student-facing teacher directory (`GET /people/teachers`).
/// Community add-member discovery is NOT here (it is the community-scoped
/// `CommunityRepository.memberCandidates`). HTTP against the backend, the
/// invented set in the demo.
final peopleRepositoryProvider = Provider<PeopleRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpPeopleRepository(ref.watch(apiClientProvider))
      : MockPeopleRepository(),
);

// ── Admin (account provisioning) ─────────────────────────────────────────────
// Staff-only account directory + provisioning (`/admin/users`); the list lives
// in features/admin/state. The server gates list on users.read and create on
// users.manage and re-authorises every request.

final adminRepositoryProvider = Provider<AdminRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpAdminRepository(ref.watch(apiClientProvider))
      : MockAdminRepository(),
);

/// Writes the link to an invitation, given its token; null while nothing can.
typedef InviteLinkBuilder = Uri? Function(String token);

/// How an invitation's link is written: at the web app's own address. The
/// native apps have none that a link could open, so there they write none
/// (null). A provider, so a test can stand in for a browser.
final inviteLinkBuilderProvider = Provider<InviteLinkBuilder?>(
  (ref) => kIsWeb ? inviteLinkFor : null,
);

// ── Live ─────────────────────────────────────────────────────────────────────
// A community's live session, read-only (the state in features/live reads
// this). Media participation is the separate seam below
// (liveMediaClientProvider), activated on web in backend mode behind an
// explicit flag (Sprint 20) and Unavailable everywhere else.

final liveRepositoryProvider = Provider<LiveRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpLiveRepository(ref.watch(apiClientProvider))
      : MockLiveRepository(),
);

// ── Attendance ───────────────────────────────────────────────────────────────
// Recording a live session's attendance snapshot (the record state in
// features/attendance reads this). Record-only in this foundation
// (attendance.md §17); viewing past snapshots is a later slice.

final attendanceRepositoryProvider = Provider<AttendanceRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpAttendanceRepository(ref.watch(apiClientProvider))
      : MockAttendanceRepository(),
);

// ── Realtime ───────────────────────────────────────────────────────────────

/// The live connection: a WebSocket to the backend when one is configured,
/// nothing at all in the demo build.
final Provider<RealtimeClient> realtimeClientProvider =
    Provider<RealtimeClient>((ref) {
      if (!ref.watch(backendModeProvider)) {
        return const DisabledRealtimeClient();
      }
      final api = ref.watch(apiClientProvider);
      final client = WebSocketRealtimeClient(
        endpoint: realtimeEndpoint(BackendConfig.baseUri),
        accessToken: api.accessToken,
      );
      ref.onDispose(() => unawaited(client.dispose()));
      return client;
    });

/// The connection the messaging state listens to — open while someone is
/// signed in, closed when they sign out.
final Provider<RealtimeClient> realtimeConnectionProvider =
    Provider<RealtimeClient>((ref) {
      final client = ref.watch(realtimeClientProvider);
      if (!client.isAvailable) return client;
      ref.listen<AsyncValue<CurrentUser?>>(sessionUserProvider, (_, next) {
        if (!next.hasValue) return;
        unawaited(next.value == null ? client.disconnect() : client.connect());
      }, fireImmediately: true);
      // Back from the background, the network may have changed underneath:
      // a fresh connection now beats waiting for a heartbeat to notice.
      final lifecycle = AppLifecycleListener(
        onResume: () {
          if (client.status != RealtimeStatus.disconnected) {
            unawaited(client.reconnect());
          }
        },
      );
      ref.onDispose(lifecycle.dispose);
      return client;
    });

/// Where the live connection stands, for the screens that show it.
final StreamProvider<RealtimeStatus> realtimeStatusProvider =
    StreamProvider<RealtimeStatus>((ref) async* {
      final client = ref.watch(realtimeConnectionProvider);
      yield client.status;
      yield* client.statuses;
    });

// ── Notifications ──────────────────────────────────────────────────────────
// The inbox, its badge and its preferences live in
// features/notifications/state; these are the seams under them.

final notificationsRepositoryProvider = Provider<NotificationsRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpNotificationsRepository(ref.watch(apiClientProvider))
      : MockNotificationsRepository(),
);

/// Where this device's push token comes from — nowhere yet (see
/// push_seams.dart): no push plugin is installed.
final pushTokenSourceProvider = Provider<PushTokenSource>(
  (ref) => const UnavailablePushTokenSource(),
);

/// "Now", for relative times ("قبل 5 دقائق") — a provider so tests can fix it.
final clockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// Whether this target supports the device-media capabilities — picking a
/// file, recording a voice note, playing one back. Web-first (Sprint 21): the
/// `file_picker` / `record` / `just_audio` plugins ship a web implementation
/// and web is the shipped, CI-verified target; native iOS/Android stays a
/// separate slice (as live media does, ADR 0030). A provider, so a test
/// exercises both the supported and the unsupported policy without a device.
final deviceMediaSupportedProvider = Provider<bool>((ref) => kIsWeb);

/// Device capabilities (Sprint 21). The real, plugin-backed implementations are
/// bound only where [deviceMediaSupportedProvider] holds; everywhere else — a
/// non-web target, and every VM widget test — they fall closed to the
/// Unavailable defaults, so the composer shows a disabled, explained affordance.
/// Each real implementation confines its plugin import to one adapter file; the
/// upload, send and authorization all stay the HTTP repository's and the
/// server's. The recorder and player own a device resource and are released
/// with the provider.
final attachmentPickerProvider = Provider<AttachmentPicker>(
  (ref) => ref.watch(deviceMediaSupportedProvider)
      ? const FilePickerAttachmentPicker()
      : const UnavailableAttachmentPicker(),
);
final voiceRecorderProvider = Provider<VoiceRecorder>((ref) {
  if (!ref.watch(deviceMediaSupportedProvider)) {
    return const UnavailableVoiceRecorder();
  }
  final recorder = RecordVoiceRecorder();
  ref.onDispose(() => unawaited(recorder.dispose()));
  return recorder;
});
final voicePlayerProvider = Provider<VoicePlayer>((ref) {
  if (!ref.watch(deviceMediaSupportedProvider)) {
    return const UnavailableVoicePlayer();
  }
  final player = JustAudioVoicePlayer();
  ref.onDispose(() => unawaited(player.dispose()));
  return player;
});

/// Whether the build explicitly enabled live media (`LIVE_MEDIA_ENABLED`). A
/// provider — mirroring [backendModeProvider] — so a test exercises both the
/// enabled and the disabled policy without a build-time define.
final liveMediaConfigEnabledProvider = Provider<bool>(
  (ref) => BackendConfig.liveMediaEnabled,
);

/// Whether this target supports the real live-media client. The LiveKit adapter
/// is web-first (ADR 0030); native iOS/Android media is a separate slice, so
/// the real client never activates off the web. A provider, so a test can
/// simulate a supported or unsupported platform without a device.
final liveMediaPlatformSupportedProvider = Provider<bool>((ref) => kIsWeb);

/// Live-session media (audio). The real [LiveKitLiveMediaClient] is bound ONLY
/// when a backend is configured, the build explicitly enables live media, AND
/// the platform is the supported web target; anything else — the demo build,
/// an absent/false flag, an unsupported platform, or a widget test — falls
/// closed to [UnavailableLiveMediaClient], and the live screen says audio is
/// unavailable. This is the one place the real client is constructed (one room
/// owner); it owns an SDK room and listeners, released with the provider.
final liveMediaClientProvider = Provider<LiveMediaClient>((ref) {
  final activate =
      ref.watch(backendModeProvider) &&
      ref.watch(liveMediaConfigEnabledProvider) &&
      ref.watch(liveMediaPlatformSupportedProvider);
  if (!activate) return const UnavailableLiveMediaClient();
  final client = LiveKitLiveMediaClient();
  // The client holds the SDK room, its event subscription and the state
  // streams; dispose it with the provider so no room, listener or stream
  // outlives the binding (e.g. when backend mode is toggled off in a test).
  ref.onDispose(() => unawaited(client.dispose()));
  return client;
});

/// Academic reads may now be answered by the server, and a refusal (sign in,
/// no access) is not something to try again silently: the error reaches the
/// screen, which offers the retry — as for messaging and notifications.
Duration? _noRetry(int _, Object _) => null;

// ── Institution & learner ──────────────────────────────────────────────────

final institutionProvider = FutureProvider<Institution>(
  (ref) => ref.watch(institutionRepositoryProvider).getInstitution(),
  retry: _noRetry,
);

final studentProvider = FutureProvider<StudentProfile>(
  (ref) => ref.watch(institutionRepositoryProvider).getStudent(),
  retry: _noRetry,
);

// ── Catalog ────────────────────────────────────────────────────────────────

final departmentsProvider = FutureProvider<List<Program>>(
  (ref) => ref.watch(catalogRepositoryProvider).getDepartments(),
  retry: _noRetry,
);

final specialSectionsProvider = FutureProvider<List<Program>>(
  (ref) => ref.watch(catalogRepositoryProvider).getSpecialSections(),
  retry: _noRetry,
);

final companionProgramsProvider = FutureProvider<List<Program>>(
  (ref) => ref.watch(catalogRepositoryProvider).getCompanionPrograms(),
  retry: _noRetry,
);

final programProvider = FutureProvider.family<Program?, String>(
  (ref, id) => ref.watch(catalogRepositoryProvider).getProgram(id),
  retry: _noRetry,
);

// ── Learning ───────────────────────────────────────────────────────────────

final pathProvider = FutureProvider<List<PathStep>>(
  (ref) => ref.watch(learningRepositoryProvider).getPath(),
  retry: _noRetry,
);

final halaqatProvider = FutureProvider.family<List<Halaqa>, String>(
  (ref, programId) =>
      ref.watch(learningRepositoryProvider).getHalaqat(programId),
  retry: _noRetry,
);

final halaqaProvider = FutureProvider.family<Halaqa?, String>(
  (ref, halaqaId) => ref.watch(learningRepositoryProvider).getHalaqa(halaqaId),
  retry: _noRetry,
);

/// Keyed by "halaqaId/lessonId".
final lessonProvider =
    FutureProvider.family<Lesson?, ({String halaqaId, String lessonId})>(
      (ref, key) => ref
          .watch(learningRepositoryProvider)
          .getLesson(key.halaqaId, key.lessonId),
      retry: _noRetry,
    );

final currentHalaqaProvider = FutureProvider<Halaqa?>(
  (ref) => ref.watch(learningRepositoryProvider).getCurrentHalaqa(),
  retry: _noRetry,
);

// ── Progress & certificates ────────────────────────────────────────────────

/// Null when no progress is recorded (always, against the backend — for now).
final progressProvider = FutureProvider<ProgressSummary?>(
  (ref) => ref.watch(progressRepositoryProvider).getProgress(),
  retry: _noRetry,
);

final certificatesProvider = FutureProvider<List<Certificate>>(
  (ref) => ref.watch(certificateRepositoryProvider).getCertificates(),
);

final certificateProvider = FutureProvider.family<Certificate?, String>(
  (ref, id) => ref.watch(certificateRepositoryProvider).getCertificate(id),
);

// ── Feed ───────────────────────────────────────────────────────────────────

final announcementsProvider = FutureProvider<List<Announcement>>(
  (ref) => ref.watch(feedRepositoryProvider).getAnnouncements(),
);

// ── Appearance ─────────────────────────────────────────────────────────────

class ThemeModeNotifier extends Notifier<ThemeMode> {
  @override
  ThemeMode build() => ThemeMode.light;

  void toggle() =>
      state = state == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
}

final themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(
  ThemeModeNotifier.new,
);

/// Text scale, exposed in Profile. The profile's audiences include كبار السن
/// and محو الأمية, so a larger type option is a requirement, not a nicety.
class TextScaleNotifier extends Notifier<double> {
  @override
  double build() => 1.0;

  void set(double value) => state = value;
}

final textScaleProvider = NotifierProvider<TextScaleNotifier, double>(
  TextScaleNotifier.new,
);
