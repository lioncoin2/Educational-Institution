import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/models/publication.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/publish/state/publish_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Records each publish call so the test can assert the batch id, the targets,
/// and the attachment reference the controller sent.
class _Call {
  _Call(
    this.batchId,
    this.communityIds,
    this.kind,
    this.body,
    this.fileAssetId,
  );
  final String batchId;
  final List<String> communityIds;
  final String kind;
  final String? body;
  final String? fileAssetId;
}

class _FakeMessaging implements MessagingRepository {
  _FakeMessaging(this._scripted);
  final List<_Call> calls = [];
  final PublicationReport Function(_Call call, int index) _scripted;

  @override
  Future<PublicationReport> publishToCommunities({
    required String clientBatchId,
    required List<String> communityIds,
    required String kind,
    String? body,
    String? fileAssetId,
  }) async {
    final call = _Call(clientBatchId, communityIds, kind, body, fileAssetId);
    calls.add(call);
    return _scripted(call, calls.length - 1);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _FakeFiles implements FilesRepository {
  int uploads = 0;

  @override
  Future<String> upload(OutgoingFile file) async {
    uploads += 1;
    return 'asset-$uploads';
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

PublicationReport _report(
  String batchId,
  Map<String, PublicationStatus> byId,
) => PublicationReport(
  batchId: batchId,
  results: [
    for (final entry in byId.entries)
      PublicationOutcome(
        communityId: entry.key,
        status: entry.value,
        retryable: entry.value == PublicationStatus.unavailable,
        messageId: entry.value.isSuccess ? 'm-${entry.key}' : null,
      ),
  ],
);

OutgoingFile _image() => OutgoingFile(
  bytes: Uint8List.fromList([1, 2, 3]),
  fileName: 'x.png',
  contentType: 'image/png',
  kind: AttachmentKind.image,
);

ProviderContainer _container(_FakeMessaging messaging, _FakeFiles files) {
  final container = ProviderContainer(
    overrides: [
      messagingRepositoryProvider.overrideWithValue(messaging),
      filesRepositoryProvider.overrideWithValue(files),
    ],
  );
  addTearDown(container.dispose);
  // Keep the autoDispose notifier alive for the test.
  container.listen(publishControllerProvider, (_, _) {});
  return container;
}

void main() {
  test('a text publish sends TEXT with the body and no upload', () async {
    final messaging = _FakeMessaging(
      (call, _) => _report(call.batchId, {'c1': PublicationStatus.posted}),
    );
    final files = _FakeFiles();
    final container = _container(messaging, files);
    final controller = container.read(publishControllerProvider.notifier);

    controller.toggleTarget('c1');
    controller.setText('تذكير');
    await controller.publish();

    expect(files.uploads, 0);
    expect(messaging.calls.single.kind, 'TEXT');
    expect(messaging.calls.single.body, 'تذكير');
    expect(messaging.calls.single.communityIds, ['c1']);
    expect(container.read(publishControllerProvider).report!.posted, 1);
  });

  test(
    'a media publish uploads once and sends the asset id with the IMAGE kind',
    () async {
      final messaging = _FakeMessaging(
        (call, _) => _report(call.batchId, {'c1': PublicationStatus.posted}),
      );
      final files = _FakeFiles();
      final container = _container(messaging, files);
      final controller = container.read(publishControllerProvider.notifier);

      controller.toggleTarget('c1');
      controller.attach(_image());
      await controller.publish();

      expect(files.uploads, 1);
      expect(messaging.calls.single.kind, 'IMAGE');
      expect(messaging.calls.single.fileAssetId, 'asset-1');
    },
  );

  test('retry reuses the same batch id, resends only the retryable, and does not re-upload', () async {
    final messaging = _FakeMessaging((call, index) {
      if (index == 0) {
        return _report(call.batchId, {
          'c1': PublicationStatus.posted,
          'c2': PublicationStatus.unavailable, // retryable
          'c3': PublicationStatus.forbidden, // not retryable
        });
      }
      return _report(call.batchId, {'c2': PublicationStatus.posted});
    });
    final files = _FakeFiles();
    final container = _container(messaging, files);
    final controller = container.read(publishControllerProvider.notifier);

    controller.toggleTarget('c1');
    controller.toggleTarget('c2');
    controller.toggleTarget('c3');
    controller.attach(_image());
    await controller.publish();

    final firstBatch = messaging.calls.first.batchId;
    expect(files.uploads, 1);

    await controller.retryFailed();

    expect(messaging.calls.length, 2);
    // Same batch id → the server dedups the ones already delivered.
    expect(messaging.calls[1].batchId, firstBatch);
    // Only the retryable community is resent.
    expect(messaging.calls[1].communityIds, ['c2']);
    // The attachment is not uploaded again.
    expect(files.uploads, 1);
    // The latest report is the retry's.
    expect(container.read(publishControllerProvider).report!.posted, 1);
  });

  test('editing the text after a publish starts a new batch', () async {
    final messaging = _FakeMessaging(
      (call, _) => _report(call.batchId, {'c1': PublicationStatus.posted}),
    );
    final container = _container(messaging, _FakeFiles());
    final controller = container.read(publishControllerProvider.notifier);

    controller.toggleTarget('c1');
    controller.setText('first');
    await controller.publish();
    final firstBatch = messaging.calls.first.batchId;

    controller.setText('second');
    await controller.publish();

    expect(messaging.calls.length, 2);
    expect(messaging.calls[1].batchId, isNot(firstBatch));
    expect(messaging.calls[1].body, 'second');
  });
}
