package app.aethermesh.android

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps the Alpine sandbox alive when the app is backgrounded.
 *
 * - Starts the sandbox on service start
 * - Polls every 30 s to check health; restarts if the process has died
 * - Shows a persistent notification with task count
 * - Accepts ACTION_STOP intent to shut down cleanly
 */
class AetherService : Service() {

    private val TAG = "AetherService"
    private val NOTIF_ID = 1001
    private val HEARTBEAT_INTERVAL_MS = 30_000L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeatJob: Job? = null
    private var tasksToday = 0

    companion object {
        const val ACTION_STOP = "app.aethermesh.android.STOP_SERVICE"
        const val ACTION_HEARTBEAT = "app.aethermesh.android.HEARTBEAT"
        const val EXTRA_TASKS_TODAY = "tasks_today"

        fun startIntent(ctx: Context) = Intent(ctx, AetherService::class.java)
        fun stopIntent(ctx: Context) =
            Intent(ctx, AetherService::class.java).apply { action = ACTION_STOP }
    }

    // ── BroadcastReceiver for heartbeat updates from the sandbox ────────────
    private val heartbeatReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            tasksToday = intent?.getIntExtra(EXTRA_TASKS_TODAY, tasksToday) ?: tasksToday
            updateNotification()
        }
    }

    override fun onCreate() {
        super.onCreate()
        registerReceiver(
            heartbeatReceiver,
            IntentFilter(ACTION_HEARTBEAT),
            RECEIVER_NOT_EXPORTED
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "Stop requested via intent")
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIF_ID, buildNotification())
        Log.i(TAG, "AetherService started")

        heartbeatJob = scope.launch {
            // Ensure sandbox is running
            ensureSandboxRunning()
            // Heartbeat loop
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                ensureSandboxRunning()
            }
        }

        return START_STICKY  // restart if killed by OS
    }

    override fun onDestroy() {
        Log.i(TAG, "AetherService destroying — stopping sandbox")
        heartbeatJob?.cancel()
        scope.launch { SandboxManager.stop() }
        runCatching { unregisterReceiver(heartbeatReceiver) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Private helpers ─────────────────────────────────────────────────────

    private suspend fun ensureSandboxRunning() {
        if (!SandboxManager.isRunning()) {
            Log.w(TAG, "Sandbox not running — attempting restart")
            try {
                if (SandboxManager.isInstalled(this)) {
                    SandboxManager.start(this)
                    Log.i(TAG, "Sandbox restarted successfully")
                } else {
                    Log.e(TAG, "Sandbox not installed; cannot restart")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Sandbox restart failed", e)
            }
        }
        updateNotification()
    }

    private fun updateNotification() {
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.notify(NOTIF_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stopIntent = PendingIntent.getService(
            this, 0,
            stopIntent(this),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val running = SandboxManager.isRunning()
        val statusText = if (running)
            "Working… $tasksToday tasks completed today"
        else
            "Sandbox stopped — tap to restart"

        return NotificationCompat.Builder(this, AetherApplication.CHANNEL_PERSISTENT)
            .setContentTitle("Aether is ${if (running) "working" else "idle"}")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                android.R.drawable.ic_media_pause,
                "Stop",
                stopIntent
            )
            .build()
    }
}
