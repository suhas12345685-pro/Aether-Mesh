package app.aethermesh.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Internal broadcast receiver that receives heartbeat events from the sandbox
 * process and forwards them to AetherService to update the notification.
 *
 * Expected extras:
 *   - tasks_today (int) — number of tasks completed since midnight
 */
class HeartbeatReceiver : BroadcastReceiver() {

    private val TAG = "HeartbeatReceiver"

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AetherService.ACTION_HEARTBEAT) return

        val tasksToday = intent.getIntExtra(AetherService.EXTRA_TASKS_TODAY, 0)
        Log.d(TAG, "Heartbeat received: tasksToday=$tasksToday")

        // Persist latest count so CapabilityBridge can read it
        VaultManager.save(context, "tasks_today", tasksToday.toString())

        // Forward to AetherService so it can refresh the notification
        val svcIntent = AetherService.startIntent(context).apply {
            action = AetherService.ACTION_HEARTBEAT
            putExtra(AetherService.EXTRA_TASKS_TODAY, tasksToday)
        }
        context.startService(svcIntent)
    }
}
