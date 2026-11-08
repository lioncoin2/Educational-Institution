import 'dart:io' show Platform;

/// Native (non-web) device-media capability: Android only (ADR 0059).
///
/// Decided on the host's real [operatingSystem] (`Platform.operatingSystem`
/// unless a test passes one), so a widget test on the VM — a Linux or macOS
/// host — reads false and keeps the Unavailable defaults, whatever
/// `defaultTargetPlatform` reports.
bool deviceMediaSupported({String? operatingSystem}) =>
    (operatingSystem ?? Platform.operatingSystem) == 'android';
