// Pi Network — Persona file loader
// Stolen from coms.ts: per-agent .md files with YAML frontmatter.
// Users define peer personas declaratively in .pi/agents/ instead of config.json.

import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface PersonaDef {
  name: string;
  description: string;
  color?: string;
  purpose?: string;
  tools?: string;
  systemPrompt: string;
  file: string;
  role?: "manager" | "worker";
  capabilities?: string[];
  specialties?: string[];
  explicit?: boolean;
}

/**
 * Parse a persona .md file with YAML frontmatter.
 * Format:
 *   ---
 *   name: planner
 *   description: Plans the work
 *   color: "#36F9F6"
 *   role: manager
 *   capabilities: planning, architecture
 *   specialties: code-review, refactoring
 *   explicit: false
 *   ---
 *   System prompt body here...
 */
export function parsePersonaFile(filePath: string): PersonaDef | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        // Strip surrounding quotes (YAML-style)
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        frontmatter[key] = value;
      }
    }

    if (!frontmatter.name) return null;

    return {
      name: frontmatter.name,
      description: frontmatter.description || "",
      color: frontmatter.color,
      purpose: frontmatter.description || frontmatter.purpose,
      tools: frontmatter.tools,
      systemPrompt: match[2].trim(),
      file: filePath,
      role: frontmatter.role === "manager" ? "manager" : "worker",
      capabilities: frontmatter.capabilities?.split(",").map((s) => s.trim()).filter(Boolean) || [],
      specialties: frontmatter.specialties?.split(",").map((s) => s.trim()).filter(Boolean) || [],
      explicit: frontmatter.explicit === "true",
    };
  } catch {
    return null;
  }
}

/**
 * Load all persona files from a directory.
 * Searches: .pi/agents/ (project) then ~/.pi/agents/ (global).
 */
export function loadPersonaFiles(cwd?: string): PersonaDef[] {
  const dirs: string[] = [];

  // Project-level
  if (cwd) {
    const projectDir = join(cwd, ".pi", "agents");
    if (existsSync(projectDir)) dirs.push(projectDir);
  }

  // Global-level
  const globalDir = join(homedir(), ".pi", "agents");
  if (existsSync(globalDir)) dirs.push(globalDir);

  // Bridge-specific
  const bridgeDir = join(homedir(), ".pi", "agent", "bridge", "agents-personas");
  if (existsSync(bridgeDir)) dirs.push(bridgeDir);

  const personas: PersonaDef[] = [];
  const seenNames = new Set<string>();

  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const persona = parsePersonaFile(join(dir, file));
        if (persona && !seenNames.has(persona.name)) {
          seenNames.add(persona.name);
          personas.push(persona);
        }
      }
    } catch {}
  }

  return personas;
}
