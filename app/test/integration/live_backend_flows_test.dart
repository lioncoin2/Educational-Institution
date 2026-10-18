import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/realtime/websocket_realtime_client.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_auth_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_messaging_repository.dart';

/// The ACTUAL Flutter client code — the same `ApiClient`, HTTP repositories,
/// models and realtime client the app composes in backend mode — exercised
/// against a LIVE backend, to prove the user flows work end to end rather than
/// against hand-written fixtures. The web app differs only in its HTTP/WS
/// transport (BrowserClient / HTML socket); the repository, parsing and event
/// logic asserted here is identical.
///
/// It is skipped unless a running backend's fixture is supplied, so a plain
/// `flutter test` (and CI) stays green and offline:
///
///   flutter test test/integration/live_backend_flows_test.dart \
///     --dart-define-from-file=/path/to/fixture.json
///
/// The fixture (produced by seeding a throwaway backend) carries: apiBaseUrl,
/// teacher/student/outsider credentials, the seeded halaqa, a direct
/// conversation with a text and an image message, and the image's asset id.
const _base = String.fromEnvironment('apiBaseUrl');
const _teacherEmail = String.fromEnvironment('teacherEmail');
const _teacherPassword = String.fromEnvironment('teacherPassword');
const _studentEmail = String.fromEnvironment('studentEmail');
const _studentPassword = String.fromEnvironment('studentPassword');
const _outsiderEmail = String.fromEnvironment('outsiderEmail');
const _outsiderPassword = String.fromEnvironment('outsiderPassword');
const _studentId = String.fromEnvironment('studentId');
const _halaqaId = String.fromEnvironment('halaqaId');
const _halaqaName = String.fromEnvironment('halaqaName');
const _dm = String.fromEnvironment('dmConversationId');
const _imageMessageId = String.fromEnvironment('imageMessageId');
const _assetId = String.fromEnvironment('assetId');

const _pngHead = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

void main() {
  if (_base.isEmpty) {
    test(
      'live backend flows',
      () {},
      skip: 'no live backend: pass --dart-define-from-file=fixture.json',
    );
    return;
  }

  final baseUri = Uri.parse(_base);
  final closers = <http.Client>[];
  ApiClient apiWith(TokenStore store) {
    final client = http.Client();
    closers.add(client);
    return ApiClient(baseUri: baseUri, httpClient: client, tokenStore: store);
  }

  late TokenStore teacherStore;
  late ApiClient teacherApi;
  late CurrentUser teacher;
  late HttpAcademicRepository teacherAcademic;
  late HttpMessagingRepository teacherMessaging;
  late ApiClient studentApi;
  late HttpMessagingRepository studentMessaging;
  late HttpMessagingRepository outsiderMessaging;

  setUpAll(() async {
    teacherStore = InMemoryTokenStore();
    teacherApi = apiWith(teacherStore);
    final teacherAuth = HttpAuthRepository(teacherApi);
    teacher = await teacherAuth.signIn(
      identifier: _teacherEmail,
      password: _teacherPassword,
    );
    teacherAcademic = HttpAcademicRepository(teacherApi);
    teacherMessaging = HttpMessagingRepository(teacherApi, teacherAuth);

    studentApi = apiWith(InMemoryTokenStore());
    final studentAuth = HttpAuthRepository(studentApi);
    await studentAuth.signIn(
      identifier: _studentEmail,
      password: _studentPassword,
    );
    studentMessaging = HttpMessagingRepository(studentApi, studentAuth);

    final outsiderApi = apiWith(InMemoryTokenStore());
    final outsiderAuth = HttpAuthRepository(outsiderApi);
    await outsiderAuth.signIn(
      identifier: _outsiderEmail,
      password: _outsiderPassword,
    );
    outsiderMessaging = HttpMessagingRepository(outsiderApi, outsiderAuth);
  });

  tearDownAll(() {
    for (final client in closers) {
      client.close();
    }
  });

  test(
    '1. teacher sign-in, session restore, and sign-out — the full lifecycle',
    () async {
      expect(teacher.roles, contains('TEACHER'));
      expect(teacher.status, AccountStatus.active);
      // Relaunch: a fresh ApiClient over the same persisted tokens restores the user.
      final restored = await HttpAuthRepository(apiWith(teacherStore))
          .currentUser();
      expect(restored, isNotNull);
      expect(restored!.id, teacher.id);

      // Sign-out ends the session — the behaviour the profile's account surface
      // invokes. Run on a dedicated session so the shared ones the other flows
      // use are untouched: sign in, confirm, sign out, confirm it is gone.
      final auth = HttpAuthRepository(apiWith(InMemoryTokenStore()));
      await auth.signIn(identifier: _teacherEmail, password: _teacherPassword);
      expect(await auth.currentUser(), isNotNull);
      await auth.signOut();
      expect(await auth.currentUser(), isNull);
    },
  );

  test(
    '2. shows the real academic structure — the teacher’s assigned halaqa',
    () async {
      final me = await teacherAcademic.me();
      expect(me.activeTeaching, isNotEmpty);
      final placement = me.activeTeaching.firstWhere(
        (t) => t.placement.halaqa.id == _halaqaId,
      );
      expect(placement.placement.halaqa.name, _halaqaName);
      expect(placement.assignment.role, TeachingRole.teacher);
      expect(placement.assignment.status, AssignmentStatus.active);
    },
  );

  test(
    '3. the teacher reads the halaqa roster and finds the enrolled student',
    () async {
      final roster = await teacherAcademic.halaqaStudents(_halaqaId);
      final entry = roster.items.firstWhere(
        (e) => e.student.userId == _studentId,
      );
      expect(entry.student.displayName, isNotNull);
      expect(entry.student.active, isTrue);
    },
  );

  test(
    '4. the student opens the conversation, reads the messages, and sends one',
    () async {
      final conversations = await studentMessaging.conversations();
      expect(conversations.items.map((c) => c.id), contains(_dm));

      final page = await studentMessaging.messages(_dm, limit: 100);
      expect(
        page.items.any(
          (m) => m.type == MessageType.text && m.body == 'سلام من المعلّم',
        ),
        isTrue,
        reason:
            'the seeded text message should be readable from the other side',
      );
      expect(
        page.items.any(
          (m) => m.id == _imageMessageId && m.attachments.length == 1,
        ),
        isTrue,
      );

      final sent = await studentMessaging.sendText(
        _dm,
        clientMessageId: 'it-live-${DateTime.now().microsecondsSinceEpoch}',
        body: 'رد من الطالب',
      );
      expect(sent.body, 'رد من الطالب');
      final after = await studentMessaging.messages(_dm, limit: 100);
      expect(after.items.any((m) => m.id == sent.id), isTrue);
    },
  );

  test('5. an attachment downloads to a member with the exact bytes; an outsider is refused', () async {
    final page = await studentMessaging.messages(_dm, limit: 100);
    final image = page.items.firstWhere((m) => m.id == _imageMessageId);
    final attachment = image.attachments.single;
    expect(attachment.fileAssetId, _assetId);

    final url = await studentMessaging.attachmentUrl(
      _dm,
      _imageMessageId,
      _assetId,
    );
    final downloader = http.Client();
    closers.add(downloader);
    final response = await downloader.get(url);
    expect(response.statusCode, 200);
    expect(response.bodyBytes.length, 256);
    expect(response.bodyBytes.sublist(0, _pngHead.length), _pngHead);

    // A non-member cannot even obtain the download link.
    await expectLater(
      outsiderMessaging.attachmentUrl(_dm, _imageMessageId, _assetId),
      throwsA(isA<MessagingException>()),
    );
  });

  test(
    '6. the student receives a realtime message.sent frame over the WebSocket',
    () async {
      final realtime = WebSocketRealtimeClient(
        endpoint: realtimeEndpoint(baseUri),
        accessToken: studentApi.accessToken,
      );
      addTearDown(() => realtime.dispose());

      // connect() returns once the auth frame is sent; the connection becomes
      // live only when the server's handshake lands. Watch for that first so
      // the subscribe below is not raced against the still-connecting socket.
      final becameLive = realtime.statuses
          .firstWhere((s) => s.isLive)
          .timeout(const Duration(seconds: 10));
      await realtime.connect();
      await becameLive;
      final subscription = await realtime.subscribe(_dm);
      expect(subscription, isA<Subscribed>());

      final body = 'بث لحظي ${DateTime.now().microsecondsSinceEpoch}';
      final awaited = realtime.events
          .where(
            (e) =>
                e is MessageSentEvent &&
                e.conversationId == _dm &&
                e.message.body == body,
          )
          .cast<MessageSentEvent>()
          .first
          .timeout(const Duration(seconds: 10));

      // The teacher sends over HTTP; the student's socket must deliver it.
      await teacherMessaging.sendText(
        _dm,
        clientMessageId: 'it-rt-${DateTime.now().microsecondsSinceEpoch}',
        body: body,
      );

      final event = await awaited;
      expect(event.message.body, body);
      expect(event.sequence, greaterThan(0));
    },
    timeout: const Timeout(Duration(seconds: 30)),
  );
}
