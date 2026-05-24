// Pi Network — Network Settings persistence & sync
// Stores which peers can auto-claim tasks. Syncs via broker.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { NetworkSettings } from "../ui/network-settings";
import { DEFAULT_SETTINGS } from "../ui/network-settings";

const SETTINGS_FILE = join(process.env.HOME || "/tmp", ".pi/agent/intercom/network-settings.json");

export function loadNetworkSettings(): NetworkSettings {
  try {
    const data = readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(data);
    return {
      autoClaimPeers: parsed.autoClaimPeers || [],
      enableTaskBoard: parsed.enableTaskBoard ?? true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveNetworkSettings(settings: NetworkSettings): void {
  const dir = dirname(SETTINGS_FILE);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = SETTINGS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  try { renameSync(tmp, SETTINGS_FILE); } catch { writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8"); }
}

// Need renameSync
import { renameSync } from "fs";
