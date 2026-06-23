package app.aethermesh.android

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Manages the PRoot-based Alpine Linux sandbox that hosts all Aether services.
 *
 * Assets expected in app/src/main/assets/:
 *   - proot-aarch64  : statically compiled proot binary for arm64
 *   - alpine-rootfs.tar.gz : minimal Alpine Linux rootfs
 *   - start-aether.sh : service launch script (copied into rootfs)
 */
object SandboxManager {

    private const val TAG = "SandboxManager"
    private const val PROOT_ASSET = "proot-aarch64"
    private const val ROOTFS_ASSET = "alpine-rootfs.tar.gz"
    private const val ROOTFS_DIR = "alpine-rootfs"
    private const val LOG_FILE = "aether.log"
    private const val INSTALLED_MARKER = ".aether_installed"

    @Volatile private var sandboxProcess: Process? = null
    @Volatile private var startTime: Long = 0L

    // ── Installation check ──────────────────────────────────────────────────

    suspend fun isInstalled(context: Context): Boolean = withContext(Dispatchers.IO) {
        val marker = File(context.filesDir, INSTALLED_MARKER)
        marker.exists()
    }

    // ── Install (extract rootfs + bootstrap) ────────────────────────────────

    suspend fun install(context: Context, progressCallback: (Int) -> Unit) =
        withContext(Dispatchers.IO) {
            val filesDir = context.filesDir

            // 1. Extract proot binary
            progressCallback(5)
            val proofBin = File(filesDir, PROOT_ASSET)
            if (!proofBin.exists()) {
                context.assets.open(PROOT_ASSET).use { input ->
                    FileOutputStream(proofBin).use { out -> input.copyTo(out) }
                }
                proofBin.setExecutable(true, false)
            }

            // 2. Extract Alpine rootfs tarball
            progressCallback(15)
            val rootfsDir = File(filesDir, ROOTFS_DIR)
            rootfsDir.mkdirs()

            val tarGz = File(filesDir, ROOTFS_ASSET)
            context.assets.open(ROOTFS_ASSET).use { input ->
                FileOutputStream(tarGz).use { out -> input.copyTo(out) }
            }
            progressCallback(30)

            // 3. Untar the rootfs
            val tarProc = Runtime.getRuntime().exec(
                arrayOf("tar", "xzf", tarGz.absolutePath, "-C", rootfsDir.absolutePath)
            )
            val tarExit = tarProc.waitFor()
            if (tarExit != 0) {
                val err = tarProc.errorStream.bufferedReader().readText()
                throw RuntimeException("Failed to extract rootfs (exit $tarExit): $err")
            }
            tarGz.delete()
            progressCallback(55)

            // 4. Copy startup scripts into rootfs
            copyAssetToRootfs(context, rootfsDir, "start-aether.sh", "/aether/start-aether.sh")
            copyAssetToRootfs(context, rootfsDir, "install.sh", "/aether/install.sh")
            progressCallback(65)

            // 5. Run bootstrap inside proot: apk update + deps + npm install
            val proofBinPath = proofBin.absolutePath
            val rootfsPath = rootfsDir.absolutePath
            val bootstrap = Runtime.getRuntime().exec(
                arrayOf(
                    proofBinPath,
                    "--rootfs=$rootfsPath",
                    "--bind=/dev", "--bind=/proc", "--bind=/sys",
                    "--change-id=0:0",
                    "/bin/sh", "/aether/install.sh"
                ),
                buildEnvArray(context)
            )

            // Stream logs from bootstrap
            val logFile = File(context.filesDir, LOG_FILE)
            Thread {
                bootstrap.inputStream.bufferedReader().forEachLine { line ->
                    Log.d(TAG, "[install] $line")
                    logFile.appendText("$line\n")
                }
            }.start()
            Thread {
                bootstrap.errorStream.bufferedReader().forEachLine { line ->
                    Log.w(TAG, "[install:err] $line")
                    logFile.appendText("[ERR] $line\n")
                }
            }.start()

            val exitCode = bootstrap.waitFor()
            progressCallback(95)
            if (exitCode != 0) {
                throw RuntimeException("Bootstrap failed with exit code $exitCode — check logs")
            }

            // 6. Write installed marker
            File(context.filesDir, INSTALLED_MARKER).createNewFile()
            progressCallback(100)
            Log.i(TAG, "Sandbox installed successfully")
        }

    // ── Start ───────────────────────────────────────────────────────────────

    suspend fun start(context: Context): Process = withContext(Dispatchers.IO) {
        if (sandboxProcess?.isAlive == true) {
            return@withContext sandboxProcess!!
        }

        val filesDir = context.filesDir
        val proofBin = File(filesDir, PROOT_ASSET)
        val rootfsDir = File(filesDir, ROOTFS_DIR)

        if (!proofBin.exists() || !rootfsDir.exists()) {
            throw IllegalStateException("Sandbox not installed — call install() first")
        }

        val logFile = File(filesDir, LOG_FILE)
        logFile.delete()

        val proc = Runtime.getRuntime().exec(
            arrayOf(
                proofBin.absolutePath,
                "--rootfs=${rootfsDir.absolutePath}",
                "--bind=/dev", "--bind=/proc", "--bind=/sys",
                "--change-id=0:0",
                "/bin/sh", "/aether/start-aether.sh"
            ),
            buildEnvArray(context)
        )

        sandboxProcess = proc
        startTime = System.currentTimeMillis()

        // Tee stdout/stderr to log file
        Thread {
            try {
                proc.inputStream.bufferedReader().forEachLine { line ->
                    Log.d(TAG, line)
                    logFile.appendText("$line\n")
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }

        Thread {
            try {
                proc.errorStream.bufferedReader().forEachLine { line ->
                    Log.w(TAG, "[err] $line")
                    logFile.appendText("[ERR] $line\n")
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }

        Log.i(TAG, "Sandbox started (pid=${proc.pid()})")
        proc
    }

    // ── Stop ────────────────────────────────────────────────────────────────

    suspend fun stop() = withContext(Dispatchers.IO) {
        sandboxProcess?.let { proc ->
            if (proc.isAlive) {
                proc.destroy()
                val exited = runCatching { proc.waitFor() }.isSuccess
                Log.i(TAG, "Sandbox stopped (clean=$exited)")
            }
        }
        sandboxProcess = null
        startTime = 0L
    }

    // ── Status ──────────────────────────────────────────────────────────────

    fun isRunning(): Boolean = sandboxProcess?.isAlive == true

    fun uptimeMs(): Long = if (isRunning()) System.currentTimeMillis() - startTime else 0L

    // ── Log tailing ─────────────────────────────────────────────────────────

    suspend fun getLogs(context: Context, lines: Int = 200): List<String> =
        withContext(Dispatchers.IO) {
            val logFile = File(context.filesDir, LOG_FILE)
            if (!logFile.exists()) return@withContext emptyList()
            logFile.readLines().takeLast(lines)
        }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private fun buildEnvArray(context: Context): Array<String> {
        val cfg = VaultManager.load(context, "aether_config") ?: "{}"
        val configJson = org.json.JSONObject(cfg)
        val list = mutableListOf(
            "HOME=/root",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TERM=xterm-256color",
            "AETHER_ANDROID=true",
        )
        if (configJson.has("provider"))
            list += "BYOB_PROVIDER=${configJson.getString("provider")}"
        if (configJson.has("model"))
            list += "BYOB_MODEL=${configJson.getString("model")}"
        if (configJson.has("apiKey"))
            list += "BYOB_API_KEY=${configJson.getString("apiKey")}"
        return list.toTypedArray()
    }

    private fun copyAssetToRootfs(
        context: Context,
        rootfsDir: File,
        assetName: String,
        targetRelPath: String,
    ) {
        val targetFile = File(rootfsDir, targetRelPath.removePrefix("/"))
        targetFile.parentFile?.mkdirs()
        context.assets.open(assetName).use { input ->
            FileOutputStream(targetFile).use { out -> input.copyTo(out) }
        }
        targetFile.setExecutable(true, false)
    }
}
