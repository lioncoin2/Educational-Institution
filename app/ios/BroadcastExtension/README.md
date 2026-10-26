# iOS live screen share — ReplayKit broadcast upload extension (ADR 0051)

> **STATUS: scaffolding, UNVERIFIED.** These steps need a Mac with Xcode to build
> and sign, and a real iPhone/iPad to validate. They cannot be built or verified
> on the Linux CI/build host used so far. Do **not** treat iOS screen share as
> complete until the real-device checks in the task's acceptance matrix pass.

Native live **audio** on iOS already works through the existing LiveKit
integration (the microphone usage string is in `ios/Runner/Info.plist`). Screen
**sharing** on iOS is different: iOS only lets another process (a ReplayKit
*broadcast upload extension*) capture the screen, and that extension hands frames
to the host app through an **App Group** shared container. LiveKit publishes those
frames when the room is created with
`ScreenShareCaptureOptions(useiOSBroadcastExtension: true)` — which this app
already does on iOS (`lib/data/media/livekit/livekit_room_port.dart`).

What remains is the native target + glue, which only Xcode can produce.

## Dart wiring already in place (no Xcode needed)
- The room is created with `useiOSBroadcastExtension: true` on iOS.
- `IosScreenCaptureController` (`lib/data/media/livekit/screen_capture_controllers.dart`)
  calls the method channel `com.quraninstitution.quran_institution_app/screen_capture`
  with `presentBroadcastPicker` (on share start) and `stopBroadcast` (on stop).
  Until the native handler below is registered, those calls fail safely (the UI
  shows a screen-share error) — they never pretend success.

## Xcode steps (do on a Mac)

### 1. App Group
Create one App Group, enabled on **both** the Runner target and the new extension
target (Signing & Capabilities → App Groups). Pick a real id for this app, e.g.
`group.com.quraninstitution.quran_institution_app`. The same string must appear
in three places: both targets' entitlements, the host Info.plist
(`RTCAppGroupIdentifier`), and `SampleHandler.swift`'s `appGroupIdentifier`.

### 2. Broadcast Upload Extension target
File → New → Target → **Broadcast Upload Extension** (do NOT include a UI
extension). Name it e.g. `ScreenBroadcast`; its bundle id will be something like
`com.quraninstitution.quran_institution_app.ScreenBroadcast`. Set its deployment
target to match Runner. Then:
- Replace the generated `SampleHandler.swift` with this folder's `SampleHandler.swift`
  (set `appGroupIdentifier` to the App Group from step 1).
- Copy these files **verbatim** from the pinned SDK example into the extension
  target — they are the socket/uploader/notification plumbing the handler needs:
  - `SampleUploader.swift`
  - `SocketConnection.swift`
  - `DarwinNotificationCenter.swift`
  - `Atomic.swift` (if present)

  Source (pinned SDK 2.13.0):
  `~/.pub-cache/hosted/pub.dev/livekit_client-2.13.0/example/ios/LiveKit Broadcast Extension/`

### 3. Host app Info.plist keys
Add to `ios/Runner/Info.plist` (replace with the real ids from steps 1–2):
```xml
<key>RTCAppGroupIdentifier</key>
<string>group.com.quraninstitution.quran_institution_app</string>
<key>RTCScreenSharingExtension</key>
<string>com.quraninstitution.quran_institution_app.ScreenBroadcast</string>
```
These tell LiveKit which App Group and which extension to read frames from.

### 4. Register the native method-channel handler
Add `ios/Runner/ScreenBroadcastChannelHandler.swift` (in this commit) to the
Runner target, then register it from `AppDelegate.didInitializeImplicitFlutterEngine`
(or `application(_:didFinishLaunchingWithOptions:)` on the classic embedding):

```swift
// after GeneratedPluginRegistrant.register(...)
if let messenger = (window?.rootViewController as? FlutterViewController)?.binaryMessenger {
  ScreenBroadcastChannelHandler.register(with: messenger)
}
```
(The exact `messenger` accessor depends on the Flutter embedding in use; the
handler itself is embedding-agnostic.) It presents `RPSystemBroadcastPickerView`
on `presentBroadcastPicker` and requests stop on `stopBroadcast`.

### 5. Dependencies (SPM)
This project uses Swift Package Manager (empty `Podfile`). The broadcast extension
needs the WebRTC/LiveKit broadcast reader on the **host** side — it is already
pulled in by `livekit_client`. The extension target itself only needs the copied
plumbing files (step 2); it does not link LiveKit. If the project is migrated to
CocoaPods, add a `pod 'flutter_webrtc'` entry under the extension target per the
flutter-webrtc iOS screen-sharing wiki.

## Real-device acceptance (cannot be automated here)
- iOS teacher taps share → the system broadcast picker appears → selecting the
  extension starts the broadcast → a student (web/Android) sees the screen.
- Ending the broadcast from Control Center / the red status bar stops it and the
  app reflects "not sharing".
- Backgrounding keeps or stops the broadcast as the OS dictates; the app never
  shows a stale "sharing" state.

Until all of the above pass on a real device, iOS screen share is **not**
complete.
