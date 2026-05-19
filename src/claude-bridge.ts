// Pi Network — Claude Code Bridge Server
// Runs on the Claude Code machine. Receives tasks via HTTP, runs claude -p, returns results.
//
// Usage: node claude-bridge.js

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BRIDGE_DIR = join(homedir(), ".pi", "agent", "bridge");
const CONFIG_FILE = join(BRIDGE_DIR, "config.json");
const PORT = parseInt(process.env.BRIDGE_PORT || "9766");

interface BridgeConfig {
  localName: string;
  bridgePort: number;
  role: string;
  reportTo?: string;
  capabilities: string[];
  specialties: string[];
  server?: { url: string; apiKey: string };
}

function loadConfig(): BridgeConfig {
  if (!existsSync(CONFIG_FILE)) {
    return {
      localName: "claude-bridge",
      bridgePort: PORT,
      role: "worker",
      capabilities: ["research", "analysis", "writing"],
      specialties: [],
    };
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const config = loadConfig();

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.end(); return; }

  const url = new URL(req.url!, `http://${req.headers.host}`);

  // ── Ping ──
  if (req.method === "GET" && url.pathname === "/ping") {
    res.end(JSON.stringify({ pong: true, name: config.localName }));
    return;
  }

  // ── Task ──
  if (req.method === "POST" && url.pathname === "/task") {
    const body = JSON.parse(await readBody(req));
    const { task, from, fromSession, taskId, rootTaskId } = body;

    console.log(`[task] From ${from}/${fromSession}: ${task.slice(0, 80)}...`);

    res.end(JSON.stringify({ accepted: true }));

    try {
      const result = execSync(
        `claude -p ${shellEscape(task)} --output-format text`,
        {
          timeout: 300000,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      console.log(`[done] Task ${taskId?.slice(0, 12)} completed (${result.length} chars)`);

      // Send result back
      const resultPayload = {
        taskId,
        rootTaskId,
        from: config.localName,
        fromSession: "claude",
        deliverTo: from,
        deliverToSession: fromSession,
        result,
        files: [],
        chain: body.chain || [],
        originInstructor: body.originInstructor || from,
        originSession: body.originSession || fromSession,
        status: "completed",
        isConsolidated: false,
        needsConsolidation: false,
        partialResults: [],
      };

      // Try direct delivery first
      const port = body.callerPort || 9764;
      try {
        await fetch(`http://${from}:${port}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(resultPayload),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Try via relay
        if (config.server?.url) {
          await fetch(`${config.server.url}/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.server.apiKey}`,
            },
            body: JSON.stringify({ to: from, from: config.localName, payload: resultPayload }),
          });
        }
      }
    } catch (error: any) {
      console.error(`[error] Task ${taskId?.slice(0, 12)} failed: ${error.message}`);

      const errorPayload = {
        taskId,
        rootTaskId,
        from: config.localName,
        fromSession: "claude",
        deliverTo: from,
        deliverToSession: fromSession,
        result: `Error: ${error.message}`,
        files: [],
        status: "failed",
        chain: body.chain || [],
        originInstructor: body.originInstructor || from,
        originSession: body.originSession || fromSession,
      };

      try {
        const port = body.callerPort || 9764;
        await fetch(`http://${from}:${port}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(errorPayload),
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    }
    return;
  }

  // ── File receive ──
  if (req.method === "POST" && url.pathname === "/file") {
    const body = JSON.parse(await readBody(req));
    const inboxDir = join(BRIDGE_DIR, "inbox");
    if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
    const dest = join(inboxDir, body.filename);
    writeFileSync(dest, Buffer.from(body.content, "base64"));
    console.log(`[file] Received: ${body.filename} from ${body.from}`);
    res.end(JSON.stringify({ received: true }));
    return;
  }

  // ── Status ──
  if (req.method === "GET" && url.pathname === "/status") {
    res.end(JSON.stringify({
      name: config.localName,
      role: config.role,
      capabilities: config.capabilities,
      online: true,
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Bridge running on :${PORT}`);
  console.log(`Name: ${config.localName}`);
  console.log(`Capabilities: ${config.capabilities.join(", ")}`);
});
