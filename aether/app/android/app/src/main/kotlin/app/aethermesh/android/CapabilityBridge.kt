package app.aethermesh.android

import android.webkit.JavascriptInterface
import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * JavaScript bridge exposed to the WebView dashboard.
 * All @JavascriptInterface methods are callable from JS as:
 *   Android.getConfig(), Android.saveConfig(...), etc.
 */
@Suppress("unused")
class CapabilityBridge(private val context: Context) {

    private val TAG = "CapabilityBridge"
    private val scope = CoroutineScope(Dispatchers.Main)

    /** Returns the current BYOB/agent config as a JSON string. */
    @JavascriptInterface
    fun getConfig(): String {
        return VaultManager.load(context, "aether_config") ?: "{}"
    }

    /** Persists a JSON config string into the encrypted vault. */
    @JavascriptInterface
    fun saveConfig(json: String) {
        try {
            // Validate it's real JSON before persisting
            JSONObject(json)
            VaultManager.save(context, "aether_config", json)
            Log.d(TAG, "Config saved via JS bridge")
        } catch (e: Exception) {
            Log.e(TAG, "saveConfig failed: invalid JSON", e)
        }
    }

    /** Starts the Alpine sandbox asynchronously. */
    @JavascriptInterface
    fun startSandbox() {
        scope.launch(Dispatchers.IO) {
            try {
                SandboxManager.start(context)
                Log.i(TAG, "Sandbox started from JS bridge")
            } catch (e: Exception) {
                Log.e(TAG, "startSandbox failed", e)
            }
        }
    }

    /** Stops the sandbox asynchronously. */
    @JavascriptInterface
    fun stopSandbox() {
        scope.launch(Dispatchers.IO) {
            try {
                SandboxManager.stop()
                Log.i(TAG, "Sandbox stopped from JS bridge")
            } catch (e: Exception) {
                Log.e(TAG, "stopSandbox failed", e)
            }
        }
    }

    /** Returns true if the sandbox process is currently alive. */
    @JavascriptInterface
    fun isSandboxRunning(): Boolean = SandboxManager.isRunning()

    /**
     * Returns a JSON object with runtime status:
     * { "running": bool, "uptimeSec": int, "tasksToday": int }
     */
    @JavascriptInterface
    fun getSandboxStatus(): String {
        val tasksToday = VaultManager.load(context, "tasks_today")?.toIntOrNull() ?: 0
        val uptimeSec = (SandboxManager.uptimeMs() / 1000).toInt()
        return JSONObject().apply {
            put("running", SandboxManager.isRunning())
            put("uptimeSec", uptimeSec)
            put("tasksToday", tasksToday)
        }.toString()
    }

    /** Returns recent log lines as a JSON array string. */
    @JavascriptInterface
    fun getRecentLogs(): String {
        var logLines = emptyList<String>()
        // Blocking read — fine from a JS interface (runs on background thread)
        val job = scope.launch(Dispatchers.IO) {
            logLines = SandboxManager.getLogs(context, 100)
        }
        // Spin briefly to collect
        runCatching { Thread.sleep(200) }
        return org.json.JSONArray(logLines).toString()
    }

    /** Returns the installed vault keys (non-sensitive, for debug). */
    @JavascriptInterface
    fun getVaultKeys(): String {
        return org.json.JSONArray(VaultManager.keys(context).toList()).toString()
    }
}
