# Aether Mesh — Android Application

This is the installable Android application wrapper for Aether Mesh. It runs Aether Core inside a PRoot-based Alpine Linux container on-device.

## How it Works

1. **PRoot Sandbox**: We bundle a statically-compiled `proot` binary and a minimal `alpine-rootfs.tar.gz` inside the app assets.
2. **Onboarding**: During the first-run wizard, the app extracts the Alpine rootfs to the internal storage and boots the sandbox.
3. **Services**: Inside the Alpine environment, it installs Node.js and Python, copies the Aether codebase, installs dependencies, and boots the local stack.
4. **WebView Dashboard**: The main dashboard UI runs in a WebView pointing to `http://localhost:8080` (the platform web server running inside the sandbox).
5. **KeyStore Encryption**: Secrets and BYOB API keys are stored securely using Android's KeyStore-backed `EncryptedSharedPreferences`.
6. **Foreground Service**: `AetherService` runs as a foreground service with a persistent notification to keep the sandbox alive and update the user on heartbeat task counts.

## Permissions Needed

- `INTERNET`: For connecting to OpenClaw gateways, Slack, and your LLM provider.
- `FOREGROUND_SERVICE`: For running the sandbox watchdog service in the background.
- `RECEIVE_BOOT_COMPLETED`: To automatically start Aether when the device boots.
- `WAKE_LOCK`: To keep the CPU active during heartbeat periods.
- `POST_NOTIFICATIONS`: Required on Android 13+ to display the background notification.

## Building the Project

Ensure you have Android SDK 34 and Gradle installed, then run:

```bash
cd aether/app/android
./gradlew assembleDebug
```

The compiled APK will be located at `app/build/outputs/apk/debug/app-debug.apk`.
