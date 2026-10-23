import '../models/certificate.dart';
import '../models/feed.dart';
import 'repositories.dart';

/// Server-mode stand-ins for features the backend does not provide yet.
///
/// There is no announcements/feed service and no certificates service on the
/// server — no such module exists (see the backend module list). So against a
/// real backend there is nothing to show, and nothing is invented: these return
/// an empty result. They are deliberately NOT the demo's
/// [MockFeedRepository]/[MockCertificateRepository]: the demo's placeholder data
/// must never reach a connected (Trial/production) build. When a real
/// announcements/certificates backend exists, replace these with HTTP-backed
/// implementations of the same contracts — no screen change needed, the screens
/// already render the empty state.
class EmptyFeedRepository implements FeedRepository {
  const EmptyFeedRepository();

  @override
  Future<List<Announcement>> getAnnouncements() async => const <Announcement>[];
}

class EmptyCertificateRepository implements CertificateRepository {
  const EmptyCertificateRepository();

  @override
  Future<List<Certificate>> getCertificates() async => const <Certificate>[];

  @override
  Future<Certificate?> getCertificate(String id) async => null;
}
