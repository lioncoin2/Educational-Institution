/// The live room's four reactions (ADR 0049) — the four the room's reactions
/// strip shows (❤️ 👍 👏 😊). A reaction is an ephemeral gesture in a running
/// session: the server keeps none, and the realtime frame says only which kind,
/// never who. Not a chat message, and unrelated to messaging (whose message
/// reactions stay excluded).
enum LiveReactionKind {
  heart('heart'),
  thumbsUp('thumbs_up'),
  clap('clap'),
  smile('smile');

  const LiveReactionKind(this.wire);

  final String wire;

  /// The kind a frame names, or null for one this version does not know — a
  /// newer server's kind is dropped, never guessed.
  static LiveReactionKind? fromWire(Object? value) {
    for (final kind in values) {
      if (kind.wire == value) return kind;
    }
    return null;
  }
}
