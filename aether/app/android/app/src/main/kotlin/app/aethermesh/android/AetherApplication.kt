package app.aethermesh.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class AetherApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)

            // Persistent foreground-service channel
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_PERSISTENT,
                    "Aether Running",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Shows while Aether is actively processing tasks"
                    setShowBadge(false)
                }
            )

            // Status / alert channel
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ALERTS,
                    "Aether Alerts",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Important events from the Aether agent"
                }
            )
        }
    }

    companion object {
        const val CHANNEL_PERSISTENT = "aether_persistent"
        const val CHANNEL_ALERTS = "aether_alerts"
    }
}
