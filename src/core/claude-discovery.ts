// Pi Network — Claude Code session discovery
// Reads ~/.claude/sessions/*.json to find live Claude processes
// Ported from pi-intercom-adapter/claude-discovery.ts

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface ClaudeDiscoveredSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  name: string;
  status: string;
  version?: string;
  model?: string;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Encode cwd the same way Claude does for project dirs */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Extract last-used model from Claude transcript (reads last few KB only) */
function readLastModel(transcriptPath: string): string | null {
  try {
    if (!existsSync(transcriptPath)) return null;
    // Read last 50KB of file for speed
    const stat = require("fs").statSync(transcriptPath);
    const start = Math.max(0, stat.size - 50_000);
    const fd = require("fs").openSync(transcriptPath, "r");
    const buf = Buffer.alloc(stat.size - start);
    require("fs").readSync(fd, buf, 0, buf.length, start);
    require("fs").closeSync(fd);

    // Scan lines in reverse for model info
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.message?.model && obj.message.model !== "<synthetic>") {
          return obj.message.model;
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return null;
}

const CLAUDE_DIR = join(homedir(), ".claude");

/** Discover all currently-running Claude Code sessions (sync) */
export function discoverClaudeSessions(): ClaudeDiscoveredSession[] {
  const sessionsDir = join(CLAUDE_DIR, "sessions");
  const projectsDir = join(CLAUDE_DIR, "projects");

  if (!existsSync(sessionsDir)) return [];

  let files: string[];
  try { files = readdirSync(sessionsDir); } catch { return []; }

  const results: ClaudeDiscoveredSession[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(sessionsDir, file), "utf-8");
      const session = JSON.parse(raw);

      if (!isProcessAlive(session.pid)) continue;

      const name = session.name?.trim() || `Claude ${session.sessionId?.slice(0, 8) || "?"}`;
      const projectDir = join(projectsDir, encodeCwd(session.cwd || ""));
      const transcriptPath = join(projectDir, `${session.sessionId}.jsonl`);
      const model = readLastModel(transcriptPath);

      results.push({
        pid: session.pid,
        sessionId: session.sessionId,
        cwd: session.cwd,
        startedAt: session.startedAt,
        name,
        status: session.status || "idle",
        version: session.version,
        model: model || undefined,
      });
    } catch { /* skip malformed */ }
  }

  results.sort((a, b) => b.startedAt - a.startedAt);
  return results;
}
