import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../app/backend_config.dart';
import '../data/api/api_client.dart';
import '../data/api/token_store.dart';
import '../data/media/media_seams.dart';
import '../data/models/auth.dart';

import '../data/models/certificate.dart';
import '../data/models/feed.dart';
import '../data/models/institution.dart';
import '../data/models/learning.dart';
import '../data/models/progress.dart';
import '../data/models/program.dart';
import '../data/models/student.dart';
import '../data/push/push_seams.dart';
import '../data/realtime/realtime_client.dart';
import '../data/realtime/websocket_realtime_client.dart';
import '../data/repositories/http/http_auth_repository.dart';
import '../data/repositories/http/http_messaging_repository.dart';
import '../data/repositories/http/http_notifications_repository.dart';
import '../data/repositories/mock/mock_auth_repository.dart';
import '../data/repositories/mock/mock_messaging_repository.dart';
import '../data/repositories/mock/mock_notifications_repository.dart';
import '../data/repositories/mock/mock_repositories.dart';
import '../data/repositories/repositories.dart';

// ── Repository wiring ──────────────────────────────────────────────────────
// Only these six lines change when a real backend arrives.

final institutionRepositoryProvider = Provider<InstitutionRepository>(
  (ref) => const MockInstitutionRepository(),
);
final catalogRepositoryProvider = Provider<CatalogRepository>(
  (ref) => const MockCatalogRepository(),
);
final learningRepositoryProvider = Provider<LearningRepository>(
  (ref) => const MockLearningRepository(),
);
final progressRepositoryProvider = Provider<ProgressRepository>(
  (ref) => const MockProgressRepository(),
);
final certificateRepositoryProvider = Provider<CertificateRepository>(
  (ref) => const MockCertificateRepository(),
);
final feedRepositoryProvider = Provider<FeedRepository>(
  (ref) => const MockFeedRepository(),
);

/// The real backend when API_BASE_URL is set at build time; the in-memory
/// mock otherwise (the demo build, widget tests).
final Provider<AuthRepository> authRepositoryProvider = Provider<AuthRepository>(
  (ref) => BackendConfig.isConfigured
      ? HttpAuthRepository(ref.watch(apiClientProvider))
      : MockAuthRepository(),
);

// ── Backend access ─────────────────────────────────────────────────────────
// Overridden in tests with package:http's MockClient.

final httpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

/// In memory until a secure-storage implementation is added (see TokenStore).
final tokenStoreProvider = Provider<TokenStore>((ref) => InMemoryTokenStore());

final Provider<ApiClient> apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(
    baseUri: BackendConfig.baseUri,
    httpClient: ref.watch(httpClientProvider),
    tokenStore: ref.watch(tokenStoreProvider),
    onSignedOut: () => ref.invalidate(sessionUserProvider),
  ),
);

/// Who is signed in on this device, if anyone.
final FutureProvider<CurrentUser?> sessionUserProvider =
    FutureProvider<CurrentUser?>(
  (ref) => ref.watch(authRepositoryProvider).currentUser(),
  retry: (_, _) => null,
);

// ── Messaging ──────────────────────────────────────────────────────────────

final messagingRepositoryProvider = Provider<MessagingRepository>(
  (ref) => BackendConfig.isConfigured
      ? HttpMessagingRepository(
          ref.watch(apiClientProvider),
          ref.watch(authRepositoryProvider),
        )
      : MockMessagingRepository(),
);

// ── Realtime ───────────────────────────────────────────────────────────────

/// The live connection: a WebSocket to the backend when one is configured,
/// nothing at all in the demo build.
final Provider<RealtimeClient> realtimeClientProvider =
    Provider<RealtimeClient>((ref) {
      if (!BackendConfig.isConfigured) return const DisabledRealtimeClient();
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
  (ref) => BackendConfig.isConfigured
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

/// Device capabilities, unbound in this milestone (see media_seams.dart).
final attachmentPickerProvider = Provider<AttachmentPicker>(
  (ref) => const UnavailableAttachmentPicker(),
);
final voiceRecorderProvider = Provider<VoiceRecorder>(
  (ref) => const UnavailableVoiceRecorder(),
);
final voicePlayerProvider = Provider<VoicePlayer>(
  (ref) => const UnavailableVoicePlayer(),
);

// ── Institution & learner ──────────────────────────────────────────────────

final institutionProvider = FutureProvider<Institution>(
  (ref) => ref.watch(institutionRepositoryProvider).getInstitution(),
);

final studentProvider = FutureProvider<StudentProfile>(
  (ref) => ref.watch(institutionRepositoryProvider).getStudent(),
);

// ── Catalog ────────────────────────────────────────────────────────────────

final departmentsProvider = FutureProvider<List<Program>>(
  (ref) => ref.watch(catalogRepositoryProvider).getDepartments(),
);

final specialSectionsProvider = FutureProvider<List<Program>>(
  (ref) => ref.watch(catalogRepositoryProvider).getSpecialSections(),
);

final companionProgramsProvider = FutureProvider<List<Program>>(
  (ref) => ref.watch(catalogRepositoryProvider).getCompanionPrograms(),
);

final programProvider = FutureProvider.family<Program?, String>(
  (ref, id) => ref.watch(catalogRepositoryProvider).getProgram(id),
);

// ── Learning ───────────────────────────────────────────────────────────────

final pathProvider = FutureProvider<List<PathStep>>(
  (ref) => ref.watch(learningRepositoryProvider).getPath(),
);

final halaqatProvider = FutureProvider.family<List<Halaqa>, String>(
  (ref, programId) =>
      ref.watch(learningRepositoryProvider).getHalaqat(programId),
);

final halaqaProvider = FutureProvider.family<Halaqa?, String>(
  (ref, halaqaId) => ref.watch(learningRepositoryProvider).getHalaqa(halaqaId),
);

/// Keyed by "halaqaId/lessonId".
final lessonProvider = FutureProvider.family<Lesson?, ({String halaqaId, String lessonId})>(
  (ref, key) => ref
      .watch(learningRepositoryProvider)
      .getLesson(key.halaqaId, key.lessonId),
);

final currentHalaqaProvider = FutureProvider<Halaqa?>(
  (ref) => ref.watch(learningRepositoryProvider).getCurrentHalaqa(),
);

// ── Progress & certificates ────────────────────────────────────────────────

final progressProvider = FutureProvider<ProgressSummary>(
  (ref) => ref.watch(progressRepositoryProvider).getProgress(),
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

  void toggle() => state =
      state == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
}

final themeModeProvider =
    NotifierProvider<ThemeModeNotifier, ThemeMode>(ThemeModeNotifier.new);

/// Text scale, exposed in Profile. The profile's audiences include كبار السن
/// and محو الأمية, so a larger type option is a requirement, not a nicety.
class TextScaleNotifier extends Notifier<double> {
  @override
  double build() => 1.0;

  void set(double value) => state = value;
}

final textScaleProvider =
    NotifierProvider<TextScaleNotifier, double>(TextScaleNotifier.new);
