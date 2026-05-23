// Pi Network — Broker socket path resolution
// Adapted from pi-intercom's paths.ts

import { join } from "path";
import { homedir } from "os";

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getBrokerDir(homeDir: string = homedir()): string {
  return join(homeDir, ".pi/agent/network");
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-network-${sanitizePipeSegment(homeDir)}`;
  }
  return join(getBrokerDir(homeDir), "broker.sock");
}

export function getBrokerPidPath(homeDir: string = homedir()): string {
  return join(getBrokerDir(homeDir), "broker.pid");
}

export function getBrokerSpawnLockPath(homeDir: string = homedir()): string {
  return join(getBrokerDir(homeDir), "broker.spawn.lock");
}
