// =============================================================================
// e2e.mjs — Browser-compatible E2E Encryption Module
// Uses Web Crypto API (globalThis.crypto.subtle).
// Compatible with both browsers and Node.js 20+.
// =============================================================================

// Base64 helpers (works in browser and Node 20+)
function bytesToBase64(bytes) {
  let binary = '';
  const arr = new Uint8Array(bytes);
  const len = arr.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Derive a 256-bit AES-GCM key from a password and email (salt) using PBKDF2
export async function deriveKey(password, email) {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle) {
    throw new Error("Web Crypto API is not supported in this environment");
  }

  const enc = new TextEncoder();
  const passwordBytes = enc.encode(password);
  const saltBytes = enc.encode(email);

  // Import raw password key material
  const baseKey = await cryptoObj.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );

  // Derive the AES-GCM 256-bit key
  return await cryptoObj.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 200000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// Encrypt plaintext string using the derived CryptoKey
export async function encryptSecret(key, plaintext) {
  const cryptoObj = globalThis.crypto;
  const enc = new TextEncoder();
  const plaintextBytes = enc.encode(plaintext);

  // AES-GCM standard IV size is 12 bytes
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));

  const ciphertextBuffer = await cryptoObj.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    key,
    plaintextBytes
  );

  const ivB64 = bytesToBase64(iv);
  const ciphertextB64 = bytesToBase64(new Uint8Array(ciphertextBuffer));

  // Return colon-separated IV and Ciphertext
  return `${ivB64}:${ciphertextB64}`;
}

// Decrypt ciphertext (colon-separated base64) using the derived CryptoKey
export async function decryptSecret(key, ciphertext) {
  const cryptoObj = globalThis.crypto;
  const parts = ciphertext.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted format");
  }

  const iv = base64ToBytes(parts[0]);
  const encryptedBytes = base64ToBytes(parts[1]);

  const decryptedBuffer = await cryptoObj.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    key,
    encryptedBytes
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedBuffer);
}

// Export CryptoKey to raw base64 string
export async function exportKeyB64(key) {
  const cryptoObj = globalThis.crypto;
  const rawKeyBuffer = await cryptoObj.subtle.exportKey("raw", key);
  return bytesToBase64(rawKeyBuffer);
}

// Import CryptoKey from raw base64 string
export async function importKeyB64(b64) {
  const cryptoObj = globalThis.crypto;
  const rawKeyBytes = base64ToBytes(b64);
  return await cryptoObj.subtle.importKey(
    "raw",
    rawKeyBytes,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}
