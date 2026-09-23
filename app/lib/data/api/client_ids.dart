import 'dart:math';

/// A random (version 4) UUID, from the platform's secure generator.
///
/// Used as a message's `clientMessageId`: generated ONCE when the person taps
/// send, and resent verbatim on every retry — which is what lets the server
/// store the message exactly once however many times the network fails.
String newClientId([Random? random]) {
  final source = random ?? Random.secure();
  final bytes = List<int>.generate(16, (_) => source.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  String hex(int from, int to) => [
    for (final byte in bytes.sublist(from, to))
      byte.toRadixString(16).padLeft(2, '0'),
  ].join();
  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}
