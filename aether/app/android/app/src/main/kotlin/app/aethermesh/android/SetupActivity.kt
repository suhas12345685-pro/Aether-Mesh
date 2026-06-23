package app.aethermesh.android

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.viewpager2.adapter.FragmentStateAdapter
import app.aethermesh.android.databinding.ActivitySetupBinding
import app.aethermesh.android.databinding.FragmentSetupStepBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * First-run setup wizard with 4 steps:
 *   0 – Welcome
 *   1 – Install sandbox (with progress bar)
 *   2 – BYOB configuration (provider / model / API key)
 *   3 – Launch
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val adapter = SetupPagerAdapter(this)
        binding.viewPager.adapter = adapter
        binding.viewPager.isUserInputEnabled = false  // programmatic only

        // Step indicator dots driven by ViewPager page changes
        binding.viewPager.registerOnPageChangeCallback(object :
            androidx.viewpager2.widget.ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                updateStepIndicator(position)
            }
        })
        updateStepIndicator(0)

        binding.btnNext.setOnClickListener { advance() }
        binding.btnBack.setOnClickListener {
            val cur = binding.viewPager.currentItem
            if (cur > 0) binding.viewPager.currentItem = cur - 1
        }
    }

    // ── Navigation ──────────────────────────────────────────────────────────

    private fun advance() {
        val cur = binding.viewPager.currentItem
        when (cur) {
            0 -> binding.viewPager.currentItem = 1               // Welcome → Install
            1 -> startInstall()                                   // triggers install, then advances
            2 -> saveConfigAndAdvance()                          // Config → Launch step
            3 -> launchMain()                                     // Done → MainActivity
        }
    }

    private fun startInstall() {
        val step = getStep(1) as? InstallStepFragment ?: run {
            binding.viewPager.currentItem = 2; return
        }
        binding.btnNext.isEnabled = false
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                SandboxManager.install(this@SetupActivity) { progress ->
                    launch(Dispatchers.Main) { step.setProgress(progress) }
                }
                launch(Dispatchers.Main) {
                    binding.btnNext.isEnabled = true
                    binding.viewPager.currentItem = 2
                }
            } catch (e: Exception) {
                launch(Dispatchers.Main) {
                    binding.btnNext.isEnabled = true
                    Toast.makeText(this@SetupActivity,
                        "Install failed: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun saveConfigAndAdvance() {
        val step = getStep(2) as? ConfigStepFragment ?: return
        val cfg = step.getConfig()
        if (cfg == null) {
            Toast.makeText(this, "Please fill in all required fields", Toast.LENGTH_SHORT).show()
            return
        }
        VaultManager.save(this, "aether_config", cfg)
        binding.viewPager.currentItem = 3
    }

    private fun launchMain() {
        // Start foreground service and open dashboard
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(AetherService.startIntent(this))
        } else {
            startService(AetherService.startIntent(this))
        }
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun getStep(pos: Int): Fragment? {
        return supportFragmentManager.findFragmentByTag("f$pos")
    }

    private fun updateStepIndicator(step: Int) {
        binding.stepIndicator.text = "${step + 1} / 4"
        binding.btnBack.visibility = if (step == 0) View.GONE else View.VISIBLE
        val lastStep = step == 3
        binding.btnNext.text = if (lastStep) "Launch Aether 🚀" else "Next →"
        // Hide next on install step (install triggers automatically)
        binding.btnNext.isEnabled = step != 1 || SandboxManager.isRunning()
    }

    // ── Pager adapter ───────────────────────────────────────────────────────

    private inner class SetupPagerAdapter(activity: AppCompatActivity) :
        FragmentStateAdapter(activity) {
        override fun getItemCount() = 4
        override fun createFragment(position: Int): Fragment = when (position) {
            0 -> WelcomeStepFragment()
            1 -> InstallStepFragment()
            2 -> ConfigStepFragment()
            3 -> LaunchStepFragment()
            else -> WelcomeStepFragment()
        }
    }
}

// ── Step Fragments ───────────────────────────────────────────────────────────

class WelcomeStepFragment : Fragment() {
    override fun onCreateView(inflater: LayoutInflater, c: ViewGroup?, b: Bundle?): View {
        val binding = FragmentSetupStepBinding.inflate(inflater, c, false)
        binding.stepTitle.text = "Welcome to Aether"
        binding.stepSubtitle.text = "Your autonomous AI agent, always on."
        binding.stepDescription.text =
            "Aether runs 24/7 on your phone — managing email, executing tasks, " +
            "and acting as your synthetic employee.\n\nWe'll set everything up in a few steps."
        binding.stepProgress.visibility = View.GONE
        return binding.root
    }
}

class InstallStepFragment : Fragment() {
    private var _binding: FragmentSetupStepBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, c: ViewGroup?, b: Bundle?): View {
        _binding = FragmentSetupStepBinding.inflate(inflater, c, false)
        binding.stepTitle.text = "Installing Sandbox"
        binding.stepSubtitle.text = "Setting up Alpine Linux + Node + Python"
        binding.stepDescription.text =
            "Aether runs inside a lightweight Alpine Linux container on your device. " +
            "This keeps the AI stack isolated and portable.\n\nThis takes ~2 minutes on first run."
        binding.stepProgress.visibility = View.VISIBLE
        binding.stepProgress.progress = 0
        return binding.root
    }

    fun setProgress(value: Int) {
        _binding?.stepProgress?.progress = value
        _binding?.stepDescription?.text = when {
            value < 30 -> "Extracting Alpine rootfs…"
            value < 60 -> "Running bootstrap installer…"
            value < 90 -> "Installing Node.js, Python, npm packages…"
            value < 100 -> "Finalising…"
            else -> "Installation complete ✓"
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}

class ConfigStepFragment : Fragment() {
    private var _binding: FragmentSetupStepBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, c: ViewGroup?, b: Bundle?): View {
        _binding = FragmentSetupStepBinding.inflate(inflater, c, false)
        binding.stepTitle.text = "Connect Your AI"
        binding.stepSubtitle.text = "Bring Your Own Brain (BYOB)"
        binding.stepDescription.text = "Choose your AI provider:"
        binding.stepProgress.visibility = View.GONE

        // Provider spinner
        val providers = listOf("openai", "anthropic", "ollama", "custom")
        val spinnerAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, providers)
        spinnerAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        binding.providerSpinner.adapter = spinnerAdapter

        // Pre-fill from vault if reconfiguring
        val existing = VaultManager.load(requireContext(), "aether_config")?.let {
            runCatching { org.json.JSONObject(it) }.getOrNull()
        }
        existing?.let { cfg ->
            binding.modelEdit.setText(cfg.optString("model"))
            binding.apiKeyEdit.setText(cfg.optString("apiKey"))
            val idx = providers.indexOf(cfg.optString("provider"))
            if (idx >= 0) binding.providerSpinner.setSelection(idx)
        }

        return binding.root
    }

    fun getConfig(): String? {
        val provider = binding.providerSpinner.selectedItem?.toString() ?: return null
        val model = binding.modelEdit.text?.toString()?.trim() ?: ""
        val apiKey = binding.apiKeyEdit.text?.toString()?.trim() ?: ""
        if (provider != "ollama" && apiKey.isEmpty()) return null
        return org.json.JSONObject().apply {
            put("provider", provider)
            put("model", model)
            put("apiKey", apiKey)
        }.toString()
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}

class LaunchStepFragment : Fragment() {
    override fun onCreateView(inflater: LayoutInflater, c: ViewGroup?, b: Bundle?): View {
        val binding = FragmentSetupStepBinding.inflate(inflater, c, false)
        binding.stepTitle.text = "Ready to Launch"
        binding.stepSubtitle.text = "Your agent is configured"
        binding.stepDescription.text =
            "Aether will start in the background and begin monitoring your channels.\n\n" +
            "Tap 'Launch Aether 🚀' to open the dashboard."
        binding.stepProgress.visibility = View.GONE
        return binding.root
    }
}
