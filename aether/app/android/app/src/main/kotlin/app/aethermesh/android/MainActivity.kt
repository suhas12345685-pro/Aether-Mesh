package app.aethermesh.android

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import app.aethermesh.android.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var logAdapter: LogAdapter
    private var logPollingActive = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // First-run check: if not configured, go to setup
        if (!VaultManager.has(this, "aether_config")) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupWebView()
        setupLogView()
        setupBottomNav()
        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let { handleDeepLink(it) }
    }

    override fun onResume() {
        super.onResume()
        updateSandboxStatus()
    }

    // ── WebView ─────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val wv = binding.webView
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
        }
        // Force dark mode for WebView if supported
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(wv.settings, true)
        }

        wv.addJavascriptInterface(CapabilityBridge(this), "Android")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                // Keep internal localhost URLs in the WebView
                if (uri.host == "localhost" || uri.host == "127.0.0.1") return false
                // Open external links in system browser
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                return true
            }
            override fun onReceivedError(
                view: WebView, errorCode: Int, description: String, failingUrl: String
            ) {
                // Show offline page if the platform isn't running yet
                view.loadData(offlineHtml(), "text/html", "utf-8")
            }
        }
        wv.webChromeClient = WebChromeClient()
        wv.loadUrl("http://localhost:8080")
    }

    // ── Log RecyclerView ────────────────────────────────────────────────────

    private fun setupLogView() {
        logAdapter = LogAdapter()
        binding.logRecycler.apply {
            adapter = logAdapter
            layoutManager = LinearLayoutManager(this@MainActivity).apply {
                stackFromEnd = true
            }
        }
    }

    private fun startLogPolling() {
        if (logPollingActive) return
        logPollingActive = true
        lifecycleScope.launch(Dispatchers.IO) {
            while (isActive && logPollingActive) {
                val lines = SandboxManager.getLogs(this@MainActivity, 300)
                launch(Dispatchers.Main) {
                    logAdapter.setLines(lines)
                    if (lines.isNotEmpty()) {
                        binding.logRecycler.scrollToPosition(lines.size - 1)
                    }
                }
                delay(2_000)
            }
        }
    }

    // ── Bottom Navigation ───────────────────────────────────────────────────

    private fun setupBottomNav() {
        binding.bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_dashboard -> {
                    logPollingActive = false
                    binding.webView.visibility = View.VISIBLE
                    binding.logRecycler.visibility = View.GONE
                    binding.settingsPanel.visibility = View.GONE
                    true
                }
                R.id.nav_logs -> {
                    binding.webView.visibility = View.GONE
                    binding.logRecycler.visibility = View.VISIBLE
                    binding.settingsPanel.visibility = View.GONE
                    startLogPolling()
                    true
                }
                R.id.nav_settings -> {
                    logPollingActive = false
                    binding.webView.visibility = View.GONE
                    binding.logRecycler.visibility = View.GONE
                    binding.settingsPanel.visibility = View.VISIBLE
                    true
                }
                else -> false
            }
        }
        // Settings panel buttons
        binding.btnRestartSandbox.setOnClickListener { restartSandbox() }
        binding.btnStopSandbox.setOnClickListener { stopSandbox() }
        binding.btnReconfigure.setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java))
        }
    }

    // ── Sandbox controls ────────────────────────────────────────────────────

    private fun updateSandboxStatus() {
        val running = SandboxManager.isRunning()
        binding.sandboxStatusChip.apply {
            text = if (running) "● Running" else "○ Stopped"
            setChipBackgroundColorResource(
                if (running) R.color.accent_green else R.color.accent_orange
            )
        }
        binding.btnRestartSandbox.isEnabled = !running
        binding.btnStopSandbox.isEnabled = running

        if (running && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(AetherService.startIntent(this))
        }
    }

    private fun restartSandbox() {
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                SandboxManager.start(this@MainActivity)
                launch(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, "Sandbox started", Toast.LENGTH_SHORT).show()
                    updateSandboxStatus()
                }
            } catch (e: Exception) {
                launch(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, "Start failed: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun stopSandbox() {
        lifecycleScope.launch(Dispatchers.IO) {
            SandboxManager.stop()
            stopService(AetherService.stopIntent(this@MainActivity))
            launch(Dispatchers.Main) {
                Toast.makeText(this@MainActivity, "Sandbox stopped", Toast.LENGTH_SHORT).show()
                updateSandboxStatus()
            }
        }
    }

    // ── Deep links ──────────────────────────────────────────────────────────

    private fun handleDeepLink(intent: Intent) {
        if (intent.action != Intent.ACTION_VIEW) return
        val uri: Uri = intent.data ?: return
        if (uri.scheme != "aethermesh" || uri.host != "configure") return

        val provider = uri.getQueryParameter("provider") ?: return
        val model = uri.getQueryParameter("model") ?: ""
        val apiKey = uri.getQueryParameter("apiKey") ?: ""

        val cfg = org.json.JSONObject().apply {
            put("provider", provider)
            if (model.isNotEmpty()) put("model", model)
            if (apiKey.isNotEmpty()) put("apiKey", apiKey)
        }.toString()

        VaultManager.save(this, "aether_config", cfg)
        Toast.makeText(this, "Configuration updated via deep link", Toast.LENGTH_SHORT).show()
        binding.webView.reload()
    }

    // ── Offline placeholder ─────────────────────────────────────────────────

    private fun offlineHtml() = """
        <!DOCTYPE html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { background:#0a0d14; color:#e2e8f0; font-family:system-ui,sans-serif;
                 display:flex; align-items:center; justify-content:center;
                 height:100vh; margin:0; flex-direction:column; gap:16px; }
          .orb { width:80px; height:80px; border-radius:50%;
                 background:radial-gradient(circle at 40% 40%,#818cf8,#6366f1 60%,#4f46e5);
                 box-shadow:0 0 40px #6366f180; }
          h2 { margin:0; font-size:1.25rem; color:#818cf8; }
          p  { margin:0; color:#94a3b8; font-size:.9rem; text-align:center; padding:0 32px; }
        </style>
        </head>
        <body>
          <div class="orb"></div>
          <h2>Aether is starting…</h2>
          <p>The local dashboard will appear here once the sandbox is running.</p>
        </body>
        </html>
    """.trimIndent()
}
