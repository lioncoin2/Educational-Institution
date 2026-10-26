package com.quraninstitution.quran_institution_app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Screen-share foreground service control (ADR 0051). The Dart
        // AndroidScreenCaptureController calls these after MediaProjection
        // consent and on every end-of-share path. The channel name must match
        // `screenCaptureChannel` in lib/data/media/livekit/screen_capture_controllers.dart.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SCREEN_CAPTURE_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "startService" -> {
                        ScreenCaptureService.start(this)
                        result.success(null)
                    }
                    "stopService" -> {
                        ScreenCaptureService.stop(this)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    companion object {
        private const val SCREEN_CAPTURE_CHANNEL =
            "com.quraninstitution.quran_institution_app/screen_capture"
    }
}
