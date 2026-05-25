// Pi Network — Active session discovery
// Scans Pi's JSONL session files for session_info names (same source as /resume)
// Also discovers Claude sessions from ~/.claude/sessions/

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DiscoveredSession {
  name: string;
  runtime: "pi" | "claude";
  status: string;
  pid?: number;
  cwd: string;
  startedAt: number;
  model?: string;
}

// ── Pi session discovery (reads JSONL session_info like /resume) ────

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch(_e) { return false; }
}

// Scan ~/.pi/agent/sessions/*/ for JSONL files and return sessions
// that have a session_info name AND whose file was modified recently.
// This matches what /resume shows.
export function discoverActivePiSessions(maxAgeMs: number = 4 * 60 * 60 * 1000): DiscoveredSession[] {
  const sessionsDir = join(homedir(), ".pi/agent/sessions");
  if (!existsSync(sessionsDir)) return [];

  const now = Date.now();
  const results: DiscoveredSession[] = [];

  let projectDirs: string[];
  try { projectDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => join(sessionsDir, d.name)); }
  catch(_e) { return []; }

  for (const dirPath of projectDirs) {
    let files: string[];
    try { files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl")); } catch(_e) { continue; }

    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const stat = statSync(filePath);
        // Only include recently modified files (active or recently active sessions)
        if (now - stat.mtimeMs > maxAgeMs) continue;

        // Read file and find session_info name (scan from end for speed)
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        let name = "";
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === "session_info" && entry.name?.trim()) {
              name = entry.name.trim();
              break;
            }
          } catch(_e) {}
        }
        if (!name) continue;

        // Extract timestamp from filename
        const tsMatch = file.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        let startedAt = 0;
        if (tsMatch) {
          try {
            const iso = `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}Z`;
            startedAt = new Date(iso).getTime();
          } catch(_e) {}
        }

        results.push({ name, runtime: "pi", status: "online", cwd: "", startedAt });
      } catch(_e) {}
    }
  }

  // Dedup by name (keep the most recently started)
  const seen = new Set<string>();
  return results
    .sort((a, b) => b.startedAt - a.startedAt)
    .filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; });
}

// ── Claude session discovery (from ~/.claude/sessions/) ─────────────

export function discoverClaudeSessions(): DiscoveredSession[] {
  const claudeDir = join(homedir(), ".claude");
  const sessionsDir = join(claudeDir, "sessions");
  if (!existsSync(sessionsDir)) return [];

  let files: string[];
  try { files = readdirSync(sessionsDir); } catch(_e) { return []; }

  const results: DiscoveredSession[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(sessionsDir, file), "utf-8");
      const session = JSON.parse(raw);
      if (!isProcessAlive(session.pid)) continue;

      const name = session.name?.trim() || `Claude ${session.sessionId?.slice(0, 8) || "?"}`;

      results.push({
        name,
        runtime: "claude",
        status: session.status || "idle",
        pid: session.pid,
        cwd: session.cwd || "",
        startedAt: session.startedAt,
      });
    } catch(_e) {}
  }

  return results.sort((a, b) => b.startedAt - a.startedAt);
}
