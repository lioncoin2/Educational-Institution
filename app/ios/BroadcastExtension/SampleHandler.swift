//
//  SampleHandler.swift
//  ScreenBroadcast (ReplayKit broadcast upload extension) — ADR 0051
//
//  UNVERIFIED scaffolding: builds and runs only inside an Xcode Broadcast Upload
//  Extension target, with the App Group and the supporting plumbing files copied
//  from the pinned SDK example (see ../BroadcastExtension/README.md). It is the
//  standard LiveKit/flutter-webrtc broadcast handler, adapted only in its App
//  Group identifier. It cannot be compiled or validated on the Linux build host.
//

import OSLog
import ReplayKit

private let broadcastLogger = OSLog(
    subsystem: "com.quraninstitution.quran_institution_app",
    category: "Broadcast"
)

private enum Constants {
    /// MUST equal the App Group enabled on both the Runner and this extension
    /// target, and the `RTCAppGroupIdentifier` value in the host Info.plist.
    static let appGroupIdentifier = "group.com.quraninstitution.quran_institution_app"
}

/// Receives the screen frames ReplayKit captures and forwards them, over the
/// App Group's shared socket, to the host app where LiveKit publishes them.
/// `SocketConnection`, `SampleUploader` and `DarwinNotificationCenter` are copied
/// verbatim from the SDK example into this target (README step 2).
class SampleHandler: RPBroadcastSampleHandler {
    private var clientConnection: SocketConnection?
    private var uploader: SampleUploader?

    private var socketFilePath: String {
        let shared = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Constants.appGroupIdentifier
        )
        return shared?.appendingPathComponent("rtc_SSFD").path ?? ""
    }

    override init() {
        super.init()
        if let connection = SocketConnection(filePath: socketFilePath) {
            clientConnection = connection
            setupConnection()
            uploader = SampleUploader(connection: connection)
        }
        os_log(.debug, log: broadcastLogger, "%{public}s", socketFilePath)
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        DarwinNotificationCenter.shared.postNotification(.broadcastStarted)
        openConnection()
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        DarwinNotificationCenter.shared.postNotification(.broadcastStopped)
        clientConnection?.close()
    }

    override func processSampleBuffer(
        _ sampleBuffer: CMSampleBuffer,
        with sampleBufferType: RPSampleBufferType
    ) {
        // Screen video only — screen AUDIO stays off (Q56).
        guard sampleBufferType == .video else { return }
        uploader?.send(sample: sampleBuffer)
    }
}

private extension SampleHandler {
    func setupConnection() {
        clientConnection?.didClose = { [weak self] error in
            if let error = error {
                self?.finishBroadcastWithError(error)
            } else {
                let stopped = 10001
                let customError = NSError(
                    domain: RPRecordingErrorDomain,
                    code: stopped,
                    userInfo: [NSLocalizedDescriptionKey: "Screen sharing stopped"]
                )
                self?.finishBroadcastWithError(customError)
            }
        }
    }

    func openConnection() {
        let queue = DispatchQueue(label: "broadcast.connectTimer")
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(500))
        timer.setEventHandler { [weak self] in
            guard self?.clientConnection?.open() == true else { return }
            timer.cancel()
        }
        timer.resume()
    }
}
