/// How a voice note is encoded — the contract between the recorder and the
/// server's VOICE upload policy (`backend/.../files/domain/file-policy.ts`),
/// which accepts both containers below and verifies their magic bytes on
/// completion (`content-signature.ts`).
///
/// SDK-free: the `record` adapter maps a format to its encoder
/// (`recordConfigFor`), and each platform's `RecordingStore` says which one it
/// records.
enum VoiceFormat {
  /// Opus in WebM — what the browsers' `MediaRecorder` produces.
  webm(contentType: 'audio/webm', fileExtension: 'webm'),

  /// AAC-LC in MP4 — Android's native encoder. Chosen over Opus/Ogg, which
  /// Android can also record, because MP4/AAC plays in every browser and on
  /// iOS, so a note from a phone is heard everywhere.
  m4a(contentType: 'audio/mp4', fileExtension: 'm4a');

  const VoiceFormat({required this.contentType, required this.fileExtension});

  final String contentType;
  final String fileExtension;

  /// The format a recording of [contentType] is in — MP4 for anything but
  /// WebM, as a recorder only ever produces these two.
  static VoiceFormat ofContentType(String contentType) =>
      contentType == webm.contentType ? webm : m4a;
}

/// The voice budget, shared by every format: 48 kbit/s, mono — clear speech in
/// Opus or AAC, and sized to the server's limits with room to spare. The
/// longest note the server accepts (10 minutes, `MAX_VOICE_DURATION_MS`) is
/// then ≈ 3.6 MB of audio, well inside the VOICE cap of 5 MiB even with the
/// container's index and an encoder running over its target; at the recorder's
/// default 128 kbit/s stereo, a note past ~5.5 minutes was refused.
const int voiceBitRate = 48000;
const int voiceChannels = 1;
