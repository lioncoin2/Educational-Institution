import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/voice/voice_level.dart';

/// The dBFS → 0..1 mapping the recording waveform draws. Pure, so it is tested
/// without a microphone.
void main() {
  group('normalizeDbfs', () {
    test('0 dBFS (loudest) is 1, the floor is 0', () {
      expect(normalizeDbfs(0), 1.0);
      expect(normalizeDbfs(kVoiceLevelFloorDb), 0.0);
    });

    test('the midpoint of the range is 0.5', () {
      expect(normalizeDbfs(kVoiceLevelFloorDb / 2), closeTo(0.5, 1e-9));
    });

    test('anything at or below the floor clamps to 0', () {
      expect(normalizeDbfs(kVoiceLevelFloorDb - 20), 0.0);
      expect(normalizeDbfs(-1000), 0.0);
    });

    test('silence and non-finite readings are 0, never a throw or NaN', () {
      expect(normalizeDbfs(double.negativeInfinity), 0.0);
      expect(normalizeDbfs(double.nan), 0.0);
    });

    test('always returns a value within 0..1', () {
      for (final db in [5.0, 0.0, -10.0, -50.0, -120.0]) {
        final v = normalizeDbfs(db);
        expect(v, inInclusiveRange(0.0, 1.0), reason: 'db=$db');
      }
    });
  });
}
