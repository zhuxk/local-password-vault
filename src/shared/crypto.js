(function (scope) {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const AAD = encoder.encode("local-password-vault:v1");

  function bytesToBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  async function deriveKey(password, salt, iterations) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations
      },
      material,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function importKey(rawKey) {
    return crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function exportKey(key) {
    return new Uint8Array(await crypto.subtle.exportKey("raw", key));
  }

  async function encryptJson(value, key) {
    const iv = randomBytes(12);
    const plaintext = encoder.encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: AAD },
      key,
      plaintext
    );
    return {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
  }

  async function decryptJson(payload, key) {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(payload.iv),
        additionalData: AAD
      },
      key,
      base64ToBytes(payload.ciphertext)
    );
    return JSON.parse(decoder.decode(plaintext));
  }

  scope.PasswordCrypto = {
    base64ToBytes,
    bytesToBase64,
    decryptJson,
    deriveKey,
    encryptJson,
    exportKey,
    importKey,
    randomBytes
  };
})(globalThis);
