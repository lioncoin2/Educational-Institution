package com.quraninstitution.quran_institution_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
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
        // Push (ADR 0058), called only by a build with push enabled: its
        // channels, created when push starts; on sign-out the tray cleared, so
        // the next person on this phone sees none of the last one's
        // notifications; and whether the app has offered push yet. The channel
        // name must match `pushChannel` in lib/data/push/firebase_push.dart.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, PUSH_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "createChannels" -> {
                        createNotificationChannels()
                        result.success(null)
                    }
                    "clearNotifications" -> {
                        notificationManager().cancelAll()
                        result.success(null)
                    }
                    // The app's own offer to turn notifications on, made once.
                    "wasOffered" -> result.success(pushPreferences().getBoolean(KEY_OFFERED, false))
                    "markOffered" -> {
                        pushPreferences().edit().putBoolean(KEY_OFFERED, true).apply()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    /**
     * One channel per notification category (ADR 0058), by the id the server
     * puts in each push — so a person can silence one kind in the system
     * settings. Creating an existing channel changes nothing; Android 8+ only.
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = notificationManager()
        for ((id, name, importance) in NOTIFICATION_CHANNELS) {
            manager.createNotificationChannel(NotificationChannel(id, getString(name), importance))
        }
    }

    private fun notificationManager(): NotificationManager =
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun pushPreferences() = getSharedPreferences(PUSH_PREFERENCES, Context.MODE_PRIVATE)

    companion object {
        private const val SCREEN_CAPTURE_CHANNEL =
            "com.quraninstitution.quran_institution_app/screen_capture"
        private const val PUSH_CHANNEL = "com.quraninstitution.quran_institution_app/push"
        private const val PUSH_PREFERENCES = "push"
        private const val KEY_OFFERED = "offered"

        /** id (the server's category, lower-case), name, importance. */
        private val NOTIFICATION_CHANNELS = listOf(
            Triple("messages", R.string.notification_channel_messages, NotificationManager.IMPORTANCE_HIGH),
            Triple("community", R.string.notification_channel_community, NotificationManager.IMPORTANCE_DEFAULT),
            Triple("live", R.string.notification_channel_live, NotificationManager.IMPORTANCE_HIGH),
            Triple("attendance", R.string.notification_channel_attendance, NotificationManager.IMPORTANCE_DEFAULT),
            Triple("tasks", R.string.notification_channel_tasks, NotificationManager.IMPORTANCE_HIGH),
        )
    }
}
