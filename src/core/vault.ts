// Pi Network — Encrypted vault for secrets

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";
import { getBridgeDir } from "./config";

const VAULT_FILE = "vault.json";
const ALGORITHM = "aes-256-gcm";

function getVaultPath(): string {
  return join(getBridgeDir(), VAULT_FILE);
}

function deriveKey(vaultKey: string): Buffer {
  return scryptSync(vaultKey, "pi-network-vault-salt", 32);
}

export interface VaultData {
  [secretName: string]: string;
}

export function loadVault(vaultKey?: string): VaultData {
  const path = getVaultPath();
  if (!existsSync(path)) return {};
  if (!vaultKey) {
    // Return encrypted blob unreadable
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const key = deriveKey(vaultKey);
    const iv = Buffer.from(raw.iv, "base64");
    const authTag = Buffer.from(raw.authTag, "base64");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return {};
  }
}

export function saveVault(data: VaultData, vaultKey?: string): void {
  if (!vaultKey) {
    throw new Error("vaultKey not configured. Add vaultKey to config.json");
  }
  const key = deriveKey(vaultKey);
  const iv = randomBytes(12); // AES-GCM spec: 12 bytes
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  writeFileSync(getVaultPath(), JSON.stringify({
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    authTag: authTag.toString("base64"),
  }));
}

export function getSecret(name: string, vaultKey?: string): string | undefined {
  const vault = loadVault(vaultKey);
  return vault[name];
}

export function setSecret(name: string, value: string, vaultKey?: string): void {
  const vault = loadVault(vaultKey);
  vault[name] = value;
  saveVault(vault, vaultKey);
}

export function deleteSecret(name: string, vaultKey?: string): void {
  const vault = loadVault(vaultKey);
  delete vault[name];
  saveVault(vault, vaultKey);
}

export function listSecretNames(vaultKey?: string): string[] {
  const vault = loadVault(vaultKey);
  return Object.keys(vault);
}

export function encryptForTransfer(data: VaultData, vaultKey: string): string {
  const key = deriveKey(vaultKey);
  const iv = randomBytes(12); // AES-GCM spec: 12 bytes
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    authTag: authTag.toString("base64"),
  });
}

export function decryptTransfer(payload: string, vaultKey: string): VaultData {
  const raw = JSON.parse(payload);
  const key = deriveKey(vaultKey);
  const iv = Buffer.from(raw.iv, "base64");
  const authTag = Buffer.from(raw.authTag, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}
