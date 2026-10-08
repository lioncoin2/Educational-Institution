import 'package:flutter_test/flutter_test.dart';
import 'package:livekit_client/livekit_client.dart' show DisconnectReason;
import 'package:quran_institution_app/data/media/livekit/livekit_room_port.dart';
import 'package:quran_institution_app/data/models/live_media.dart';

/// The LiveKit → app disconnect-reason translation, verified against the
/// installed `livekit_client` 2.13.0 `DisconnectReason` enum. (Importing the
/// SDK is allowed in tests — the architecture guard only scans lib/.)
void main() {
  test('maps the three meaningful reasons', () {
    expect(
      liveKitDisconnectReason(DisconnectReason.duplicateIdentity),
      LiveMediaDisconnectReason.duplicateIdentity,
    );
    expect(
      liveKitDisconnectReason(DisconnectReason.roomDeleted),
      LiveMediaDisconnectReason.roomDeleted,
    );
    expect(
      liveKitDisconnectReason(DisconnectReason.participantRemoved),
      LiveMediaDisconnectReason.participantRemoved,
    );
  });

  test('collapses every other SDK reason (and null) to other', () {
    for (final reason in <DisconnectReason?>[
      DisconnectReason.unknown,
      DisconnectReason.serverShutdown,
      DisconnectReason.stateMismatch,
      DisconnectReason.joinFailure,
      DisconnectReason.disconnected,
      null,
    ]) {
      expect(
        liveKitDisconnectReason(reason),
        LiveMediaDisconnectReason.other,
        reason: '$reason',
      );
    }
  });

  test('a local disconnect (clientInitiated) is NOT a remote kick', () {
    final mapped = liveKitDisconnectReason(DisconnectReason.clientInitiated);
    expect(mapped, isNot(LiveMediaDisconnectReason.participantRemoved));
    expect(mapped, LiveMediaDisconnectReason.other);
  });

  test('maps every DisconnectReason the installed SDK declares', () {
    // Non-vacuous: iterate the SDK's actual values, so a future member that is
    // not handled would surface here. The meaningful three stay distinct; all
    // others collapse to `other`.
    final mapped = {
      for (final r in DisconnectReason.values) r: liveKitDisconnectReason(r),
    };
    expect(
      mapped[DisconnectReason.duplicateIdentity],
      LiveMediaDisconnectReason.duplicateIdentity,
    );
    expect(
      mapped[DisconnectReason.roomDeleted],
      LiveMediaDisconnectReason.roomDeleted,
    );
    expect(
      mapped[DisconnectReason.participantRemoved],
      LiveMediaDisconnectReason.participantRemoved,
    );
    final others = DisconnectReason.values.where(
      (r) => !const {
        DisconnectReason.duplicateIdentity,
        DisconnectReason.roomDeleted,
        DisconnectReason.participantRemoved,
      }.contains(r),
    );
    for (final r in others) {
      expect(mapped[r], LiveMediaDisconnectReason.other, reason: '$r');
    }
  });
}
