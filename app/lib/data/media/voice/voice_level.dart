/// Turns a recorder's raw loudness reading into the 0..1 level the recording
/// waveform draws. Kept as a pure function in its own file so it is unit-tested
/// without a microphone or the `record` plugin — the adapter that owns the
/// plugin ([RecordVoiceRecorder]) is the only caller.
library;

/// The quietest loudness drawn as a non-zero bar. `record` reports loudness in
/// dBFS (decibels relative to full scale): 0 is the loudest the microphone can
/// capture and quieter sound is more negative. Speech sits roughly within the
/// last 50 dB, so −50 dBFS is a sensible floor for a voice-note meter.
const double kVoiceLevelFloorDb = -50;

/// Maps a dBFS loudness to a 0..1 level: [kVoiceLevelFloorDb] (or quieter, and
/// any non-finite reading such as −∞ for silence) is 0, and 0 dBFS is 1.
///
/// Pure and total: it never throws and always returns a value in [0, 1], so the
/// painter can trust it for every frame.
double normalizeDbfs(double dbfs, {double floorDb = kVoiceLevelFloorDb}) {
  if (floorDb >= 0) return 1;
  if (dbfs.isNaN || dbfs == double.negativeInfinity) return 0;
  final clamped = dbfs.clamp(floorDb, 0.0);
  return (clamped - floorDb) / -floorDb;
}
