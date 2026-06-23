package app.aethermesh.android

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Android KeyStore-backed encrypted storage for sensitive Aether configuration.
 * All values are encrypted at rest using AES-256-GCM via EncryptedSharedPreferences.
 */
object VaultManager {

    private const val TAG = "VaultManager"
    private const val PREFS_FILE = "aether_vault"

    private fun prefs(context: Context): android.content.SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /**
     * Persist a string value under [key]. Encrypted transparently by the KeyStore.
     */
    fun save(context: Context, key: String, value: String) {
        try {
            prefs(context).edit().putString(key, value).apply()
            Log.d(TAG, "Saved key=$key")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save key=$key", e)
            throw e
        }
    }

    /**
     * Retrieve the value for [key], or null if it doesn't exist.
     */
    fun load(context: Context, key: String): String? {
        return try {
            prefs(context).getString(key, null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load key=$key", e)
            null
        }
    }

    /**
     * Remove a stored value.
     */
    fun delete(context: Context, key: String) {
        try {
            prefs(context).edit().remove(key).apply()
            Log.d(TAG, "Deleted key=$key")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to delete key=$key", e)
        }
    }

    /**
     * Check whether a key has been stored.
     */
    fun has(context: Context, key: String): Boolean {
        return try {
            prefs(context).contains(key)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Return all keys stored in the vault (useful for debug / audit).
     */
    fun keys(context: Context): Set<String> {
        return try {
            prefs(context).all.keys
        } catch (e: Exception) {
            emptySet()
        }
    }
}
