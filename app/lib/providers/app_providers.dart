import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/models/certificate.dart';
import '../data/models/feed.dart';
import '../data/models/institution.dart';
import '../data/models/learning.dart';
import '../data/models/progress.dart';
import '../data/models/program.dart';
import '../data/models/student.dart';
import '../data/repositories/mock/mock_auth_repository.dart';
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

/// Not yet read by any screen: the seam the sign-in flow will build on.
final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => MockAuthRepository(),
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

/// Notifications keep a little local state so "mark as read" feels real in the
/// prototype. Nothing is persisted — a reload restores the seeded list.
class NotificationsNotifier extends AsyncNotifier<List<AppNotification>> {
  @override
  Future<List<AppNotification>> build() =>
      ref.watch(feedRepositoryProvider).getNotifications();

  void markAllRead() {
    final current = state.value;
    if (current == null) return;
    state = AsyncData([
      for (final n in current) n.copyWith(isRead: true),
    ]);
  }

  void markRead(String id) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData([
      for (final n in current) n.id == id ? n.copyWith(isRead: true) : n,
    ]);
  }
}

final notificationsProvider =
    AsyncNotifierProvider<NotificationsNotifier, List<AppNotification>>(
  NotificationsNotifier.new,
);

final unreadNotificationCountProvider = Provider<int>((ref) {
  final list = ref.watch(notificationsProvider).value ?? const [];
  return list.where((n) => !n.isRead).length;
});

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
