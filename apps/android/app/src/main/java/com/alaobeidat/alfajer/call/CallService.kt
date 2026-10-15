package com.alaobeidat.alfajer.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.alaobeidat.alfajer.R
import com.alaobeidat.alfajer.ui.MainActivity

/**
 * Foreground service that keeps the microphone (and camera) alive while the
 * call runs in the background. It owns no call state — the call lives in
 * [CallSession]; this only holds the ongoing-call notification.
 */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HANG_UP) {
            CallSession.active.value?.hangUp()
            stopSelf()
            return START_NOT_STICKY
        }
        val withMic = intent?.getBooleanExtra(EXTRA_MIC, false) == true
        val withCamera = intent?.getBooleanExtra(EXTRA_CAMERA, false) == true
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Each type requires its runtime permission, so only claim
                // the devices this call actually captures.
                var types = 0
                if (withMic) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (withCamera) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                startForeground(NOTIFICATION_ID, buildNotification(), types)
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }
        } catch (e: Exception) {
            // e.g. started while not in the foreground on Android 14+. The call
            // still works while the app is visible; it just won't survive in
            // the background.
            Log.w("AlfajerCall", "could not enter foreground", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm?.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel_call), NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val hangUp = PendingIntent.getService(
            this, 1,
            Intent(this, CallService::class.java).setAction(ACTION_HANG_UP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notif_call_title))
            .setContentText(getString(R.string.notif_call_text))
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, getString(R.string.end_call), hangUp).build())
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "alfajer.call"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_MIC = "mic"
        private const val EXTRA_CAMERA = "camera"
        private const val ACTION_HANG_UP = "com.alaobeidat.alfajer.HANG_UP"

        fun start(context: Context, withMic: Boolean, withCamera: Boolean) {
            if (!withMic && !withCamera) return
            val i = Intent(context, CallService::class.java)
                .putExtra(EXTRA_MIC, withMic)
                .putExtra(EXTRA_CAMERA, withCamera)
            try {
                context.startForegroundService(i)
            } catch (e: Exception) {
                Log.w("AlfajerCall", "could not start call service", e)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }
}
