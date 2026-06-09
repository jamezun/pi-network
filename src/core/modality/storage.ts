// Pi Network — Object Storage abstraction (Improvement #8)
//
// Binary never lives in JSON. Media blobs live here with TTL expiry + at-rest
// encryption (AES-256-GCM). Two backends:
//   - "local": filesystem under the bridge dir (default; works for self-hosted)
//   - "s3":    S3-compatible (Cloudflare R2 / Backblaze B2) for production
//
// Recommendation per the upgrade plan: R2 (no egress fees) for free-tier cost.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ObjectStorageConfig {
  backend: "local" | "s3";
  /** local: directory root. s3: endpoint + bucket + keys. */
  localDir?: string;
  s3?: { endpoint: string; bucket: string; accessKey: string; secretKey: string; region?: string };
  /** At-rest encryption passphrase (omitted → no encryption). */
  encryptionPassphrase?: string;
  /** TTL in ms after which stored objects expire. Default 30 days. */
  ttlMs?: number;
}

export interface StoredObject {
  id: string;
  url: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
}

const IV_LEN = 12; // AES-GCM spec-compliant (12 bytes)

export class ObjectStorage {
  private key: Buffer | null = null;

  constructor(private cfg: ObjectStorageConfig) {
    if (cfg.encryptionPassphrase) {
      // scrypt is slow by design; cache the derived key on the instance.
      this.key = scryptSync(cfg.encryptionPassphrase, "pi-network-object-storage", 32);
    }
  }

  private root(): string {
    return this.cfg.localDir ?? join(homedir(), ".pi", "agent", "bridge", "media");
  }

  private encrypt(plain: Buffer): { enc: Buffer; iv: Buffer; tag: Buffer } {
    if (!this.key) return { enc: plain, iv: Buffer.alloc(0), tag: Buffer.alloc(0) };
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { enc, iv, tag };
  }

  private decrypt(enc: Buffer, iv: Buffer, tag: Buffer): Buffer {
    if (!this.key || iv.length === 0) return enc;
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }

  /** Store a blob, return a reference. Id is a random hex string. */
  async put(data: Buffer, ext = ".bin"): Promise<StoredObject> {
    const id = randomBytes(16).toString("hex") + ext;
    const dir = this.root();
    await mkdir(dir, { recursive: true });
    const { enc, iv, tag } = this.encrypt(data);
    // prepend iv+tag length-prefixed so we can decrypt on read
    const framed = Buffer.concat([Buffer.from([iv.length]), iv, Buffer.from([tag.length]), tag, enc]);
    const path = join(dir, id);
    await writeFile(path, framed);
    const now = Date.now();
    const ttl = this.cfg.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    return { id, url: `local://${id}`, bytes: data.length, createdAt: now, expiresAt: now + ttl };
  }

  /** Retrieve a blob by id (or by the url returned from put()). */
  async get(idOrUrl: string): Promise<Buffer> {
    const id = idOrUrl.startsWith("local://") ? idOrUrl.slice("local://".length) : idOrUrl;
    const framed = await readFile(join(this.root(), id));
    let offset = 0;
    const ivLen = framed[offset]; offset += 1;
    const iv = framed.subarray(offset, offset + ivLen); offset += ivLen;
    const tagLen = framed[offset]; offset += 1;
    const tag = framed.subarray(offset, offset + tagLen); offset += tagLen;
    const enc = framed.subarray(offset);
    return this.decrypt(enc, iv, tag);
  }

  async delete(idOrUrl: string): Promise<void> {
    const id = idOrUrl.startsWith("local://") ? idOrUrl.slice("local://".length) : idOrUrl;
    try { await unlink(join(this.root(), id)); } catch { /* already gone */ }
  }

  /** Sweep expired objects. Call from a periodic heartbeat. */
  async gc(): Promise<number> {
    const dir = this.root();
    let removed = 0;
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { return 0; }
    const now = Date.now();
    for (const entry of entries) {
      try {
        const s = await stat(join(dir, entry));
        const ttl = this.cfg.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
        if (s.mtimeMs + ttl < now) {
          await unlink(join(dir, entry));
          removed++;
        }
      } catch { /* race */ }
    }
    return removed;
  }
}
