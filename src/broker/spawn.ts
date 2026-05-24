// Pi Network — Broker spawn logic (auto-start broker if not running)
// Resolves tsx from local node_modules or falls back to pi-intercom's tsx.

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import net from "net";
import { getBrokerSocketPath, getBrokerPidPath, getBrokerSpawnLockPath, getBrokerDir } from "./paths";

const BROKER_DIR = getBrokerDir();
const BROKER_SOCKET = getBrokerSocketPath();
const BROKER_PID = getBrokerPidPath();
const BROKER_SPAWN_LOCK = getBrokerSpawnLockPath();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isBrokerRunning(): Promise<boolean> {
  return checkSocketConnectable();
}

function checkSocketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(BROKER_SOCKET);
    const finish = (ok: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(ok);
    };
    const onConnect = () => { socket.end(); finish(true); };
    const onError = () => { socket.destroy(); finish(false); };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    const timeout = setTimeout(() => { socket.destroy(); finish(false); }, 1000);
  });
}

function acquireSpawnLock(): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (isSpawnLockStale()) {
        try { unlinkSync(BROKER_SPAWN_LOCK); } catch {}
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) return false;
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    if (Number.isFinite(pid)) { try { process.kill(pid, 0); } catch { return true; } }
    return !Number.isFinite(createdAt) || Date.now() - createdAt > 10_000;
  } catch { return true; }
}

function releaseSpawnLock(): void {
  try { unlinkSync(BROKER_SPAWN_LOCK); } catch {}
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) return;
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}

/**
 * Find tsx CLI path — check local node_modules, then pi-intercom's node_modules.
 */
function resolveTsxPath(): string | null {
  const candidates = [
    // Local node_modules
    join(__dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs"),
    // pi-intercom's node_modules (common co-install)
    join(require("os").homedir(), ".pi", "agent", "extensions", "pi-intercom", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Spawn the broker process if it's not already running.
 * Resolves tsx from local or pi-intercom's node_modules.
 */
export async function spawnBrokerIfNeeded(): Promise<void> {
  mkdirSync(BROKER_DIR, { recursive: true });

  if (await isBrokerRunning()) return;

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) return;

    const brokerPath = join(__dirname, "broker.ts");
    const tsxPath = resolveTsxPath();

    const child = tsxPath
      ? spawn(process.execPath, [tsxPath, brokerPath], {
          detached: true,
          stdio: "ignore",
          cwd: dirname(brokerPath),
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          windowsHide: true,
        })
      : spawn("npx", ["--no-install", "tsx", brokerPath], {
          detached: true,
          stdio: "ignore",
          cwd: dirname(brokerPath),
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          windowsHide: true,
        });
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error: Error) => { cleanup(); reject(new Error(`Failed to spawn broker: ${error.message}`)); };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Broker exited before startup with code ${code ?? "unknown"}`));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => { cleanup(); resolve(); }, (e) => { cleanup(); reject(toError(e)); });
    });
  } finally {
    releaseSpawnLock();
  }
}
