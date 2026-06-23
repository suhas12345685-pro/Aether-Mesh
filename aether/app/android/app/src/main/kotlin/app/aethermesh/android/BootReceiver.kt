package app.aethermesh.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Receives BOOT_COMPLETED and MY_PACKAGE_REPLACED to auto-start AetherService
 * when the device restarts or the app is updated.
 *
 * Only auto-starts if the user has previously configured Aether (vault has config).
 */
class BootReceiver : BroadcastReceiver() {

    private val TAG = "BootReceiver"

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return

        // Only start if the user has set up the app
        val hasConfig = VaultManager.has(context, "aether_config")
        val autoStart = VaultManager.load(context, "auto_start") != "false"

        if (!hasConfig || !autoStart) {
            Log.d(TAG, "Skipping auto-start: configured=$hasConfig autoStart=$autoStart")
            return
        }

        Log.i(TAG, "Boot received — starting AetherService")
        val svcIntent = AetherService.startIntent(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(svcIntent)
        } else {
            context.startService(svcIntent)
        }
    }
}
