//
//  ScreenBroadcastChannelHandler.swift
//  Runner — host side of live screen share (ADR 0051)
//
//  UNVERIFIED scaffolding: add this file to the Runner target and register it
//  from AppDelegate (see ../BroadcastExtension/README.md step 4). It presents the
//  system broadcast picker for the app's broadcast upload extension; the frames
//  then flow to LiveKit via the App Group. Cannot be compiled or validated on the
//  Linux build host.
//

import Flutter
import ReplayKit

/// Handles the `com.quraninstitution.quran_institution_app/screen_capture` method
/// channel on iOS — the same channel the Android foreground service uses, but
/// with iOS-only methods. Matches `screenCaptureChannel` in
/// `lib/data/media/livekit/screen_capture_controllers.dart`.
enum ScreenBroadcastChannelHandler {
    private static let channelName =
        "com.quraninstitution.quran_institution_app/screen_capture"

    /// The broadcast extension bundle id — MUST equal `RTCScreenSharingExtension`
    /// in the host Info.plist and the extension target's bundle id.
    private static let preferredExtension =
        "com.quraninstitution.quran_institution_app.ScreenBroadcast"

    static func register(with messenger: FlutterBinaryMessenger) {
        let channel = FlutterMethodChannel(name: channelName, binaryMessenger: messenger)
        channel.setMethodCallHandler { call, result in
            switch call.method {
            case "presentBroadcastPicker":
                presentPicker()
                result(nil)
            case "stopBroadcast":
                // The user stops a broadcast from Control Center / the status bar;
                // there is no public API to stop it programmatically, so this is a
                // best-effort no-op. LiveKit unpublishes when the broadcast ends.
                result(nil)
            default:
                result(FlutterMethodNotImplemented)
            }
        }
    }

    @MainActor private static func presentPicker() {
        let picker = RPSystemBroadcastPickerView(
            frame: CGRect(x: 0, y: 0, width: 1, height: 1)
        )
        picker.preferredExtension = preferredExtension
        picker.showsMicrophoneButton = false
        // Programmatically tap the hidden picker's button to show the system
        // broadcast sheet (the documented workaround).
        for subview in picker.subviews {
            if let button = subview as? UIButton {
                button.sendActions(for: .touchUpInside)
            }
        }
    }
}
