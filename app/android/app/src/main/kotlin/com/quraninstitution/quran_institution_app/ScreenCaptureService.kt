package com.quraninstitution.quran_institution_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * The `mediaProjection` foreground service that a live screen share needs on
 * Android (ADR 0051).
 *
 * Neither `livekit_client` nor `flutter_webrtc` starts one, yet Android 10+
 * (strictly enforced on 14+) refuses `MediaProjection.getMediaProjection()`
 * unless a foreground service of type `mediaProjection` is already running. So
 * the app owns it: the Dart [AndroidScreenCaptureController] starts it (after the
 * user grants the MediaProjection consent) and stops it on every end-of-share
 * path, through the method channel wired in [MainActivity].
 *
 * The service does nothing but hold a persistent notification for the lifetime of
 * the capture — the actual screen frames are captured by flutter_webrtc using the
 * projection token. Stopping it removes the notification and lets the system
 * reclaim the projection.
 */
class ScreenCaptureService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        return START_NOT_STICKY
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // The type is what lets MediaProjection run; required from API 29,
            // and the FOREGROUND_SERVICE_MEDIA_PROJECTION permission from API 34.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(NOTIFICATION_TITLE)
            .setContentText(NOTIFICATION_TEXT)
            // The app's own launcher icon — no new drawable resource needed.
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "live_screen_share"
        private const val NOTIFICATION_CHANNEL_NAME = "مشاركة الشاشة المباشرة"
        private const val NOTIFICATION_TITLE = "مشاركة الشاشة نشطة"
        private const val NOTIFICATION_TEXT = "تتم مشاركة شاشتك في الجلسة المباشرة."
        private const val NOTIFICATION_ID = 0x5CE3 // arbitrary, stable
        private const val ACTION_STOP = "com.quraninstitution.quran_institution_app.STOP_SCREEN_CAPTURE"

        /** Start the foreground service (after MediaProjection consent). */
        fun start(context: Context) {
            val intent = Intent(context, ScreenCaptureService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Stop the foreground service and clear its notification. */
        fun stop(context: Context) {
            val intent = Intent(context, ScreenCaptureService::class.java)
            intent.action = ACTION_STOP
            // Deliver the stop action; the service tears itself down.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
