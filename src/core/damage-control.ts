// Pi Network — Damage Control (Safety Rules Engine)
// Stolen from disler/damage-control: intercepts tool_calls against a YAML rule set.
// Prevents remote agents from executing destructive commands on your machine.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface Rule {
  pattern: string;  // regex pattern for bash commands
  reason: string;
  ask?: boolean;    // if true, ask for confirmation instead of blocking
}

export interface DamageControlRules {
  bashToolPatterns: Rule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
  noDeletePaths: string[];
}

const DEFAULT_RULES: DamageControlRules = {
  bashToolPatterns: [
    { pattern: "rm\\s+-rf\\s+/", reason: "Recursive force delete from root", ask: true },
    { pattern: "git\\s+reset\\s+--hard", reason: "Destructive git reset", ask: true },
    { pattern: "git\\s+push\\s+.*--force", reason: "Force push to remote", ask: true },
    { pattern: "DROP\\s+DATABASE", reason: "SQL drop database", ask: false },
    { pattern: "aws\\s+s3\\s+rm\\s+--recursive", reason: "Recursive S3 delete", ask: false },
    { pattern: "docker\\s+system\\s+prune", reason: "Docker system prune", ask: true },
    { pattern: "chmod\\s+-R\\s+777", reason: "Insecure recursive permissions", ask: true },
    { pattern: ":\\(\\)\\s*\\{\\s*:|\\.&\\s*\\}", reason: "Fork bomb pattern", ask: false },
    { pattern: "mkfs\\.", reason: "Filesystem format", ask: false },
    { pattern: "dd\\s+.*of=/dev/", reason: "Raw device write", ask: false },
  ],
  zeroAccessPaths: [
    "~/.ssh/",
    "~/.gnupg/",
    "~/.aws/",
    "*.pem",
    "*.key",
    ".env.production",
    ".env.local",
  ],
  readOnlyPaths: [
    "/etc/",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
  ],
  noDeletePaths: [
    ".git/",
    "Dockerfile",
    "docker-compose.yml",
    "README.md",
    "LICENSE",
  ],
};

function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
  const resolvedPattern = pattern.startsWith("~") ? join(homedir(), pattern.slice(1)) : pattern;

  if (resolvedPattern.endsWith("/")) {
    const absolutePattern = isAbsolute(resolvedPattern) ? resolvedPattern : resolve(cwd, resolvedPattern);
    return targetPath.startsWith(absolutePattern);
  }

  // Handle wildcards
  const regexPattern = resolvedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);
  const relativePath = resolve(cwd, targetPath) !== targetPath
    ? resolve(cwd, targetPath)
    : targetPath;

  return regex.test(targetPath) || regex.test(relativePath) ||
    targetPath.includes(resolvedPattern) || relativePath.includes(resolvedPattern);
}

export function loadRules(cwd: string): DamageControlRules {
  const projectRulesPath = join(cwd, ".pi", "damage-control-rules.yaml");
  const globalRulesPath = join(homedir(), ".pi", "damage-control-rules.yaml");
  const rulesPath = existsSync(projectRulesPath)
    ? projectRulesPath
    : existsSync(globalRulesPath)
      ? globalRulesPath
      : null;

  if (!rulesPath) return DEFAULT_RULES;

  try {
    const content = readFileSync(rulesPath, "utf8");
    // Simple YAML parsing — avoid adding yaml dependency
    // For full YAML support, user should install 'yaml' package
    let loaded: any;
    try {
      const { parse } = require("yaml");
      loaded = parse(content);
    } catch {
      // Fallback: try JSON
      loaded = JSON.parse(content);
    }

    return {
      bashToolPatterns: loaded.bashToolPatterns || DEFAULT_RULES.bashToolPatterns,
      zeroAccessPaths: loaded.zeroAccessPaths || DEFAULT_RULES.zeroAccessPaths,
      readOnlyPaths: loaded.readOnlyPaths || DEFAULT_RULES.readOnlyPaths,
      noDeletePaths: loaded.noDeletePaths || DEFAULT_RULES.noDeletePaths,
    };
  } catch {
    return DEFAULT_RULES;
  }
}

export interface DamageControlResult {
  blocked: boolean;
  reason: string | null;
  ask: boolean;
  rule?: string;
}

/**
 * Evaluate a tool call against damage-control rules.
 * Returns { blocked: true } if the call should be blocked,
 * or { blocked: false, ask: true } if it needs confirmation.
 */
export function evaluateToolCall(
  toolName: string,
  input: Record<string, any>,
  rules: DamageControlRules,
  cwd: string
): DamageControlResult {
  // 1. Bash command patterns
  if (toolName === "bash" && input.command) {
    const cmd = input.command as string;
    for (const rule of rules.bashToolPatterns) {
      try {
        const regex = new RegExp(rule.pattern, "i");
        if (regex.test(cmd)) {
          return { blocked: !rule.ask, reason: rule.reason, ask: !!rule.ask, rule: rule.pattern };
        }
      } catch {
        // Bad regex — skip
      }
    }
  }

  // 2. Path-based checks for write/edit/read/bash tools
  const pathFields = ["path", "file", "filePath", "destination"];
  const paths = pathFields
    .map((f) => input[f])
    .filter(Boolean)
    .map((p: string) => resolvePath(p, cwd));

  // Add glob patterns for read/write tools
  if (input.glob) paths.push(resolvePath(input.glob, cwd));

  for (const targetPath of paths) {
    // Zero access — block all reads and writes
    for (const pattern of rules.zeroAccessPaths) {
      if (isPathMatch(targetPath, pattern, cwd)) {
        return { blocked: true, reason: `Zero-access path: ${pattern}`, ask: false, rule: pattern };
      }
    }

    // Read-only — block writes
    if (["write", "edit", "bash"].includes(toolName)) {
      for (const pattern of rules.readOnlyPaths) {
        if (isPathMatch(targetPath, pattern, cwd)) {
          return { blocked: true, reason: `Read-only path: ${pattern}`, ask: false, rule: pattern };
        }
      }
    }

    // No-delete — block file deletion
    if (toolName === "bash" && input.command && /\brm\s/.test(input.command)) {
      for (const pattern of rules.noDeletePaths) {
        if (isPathMatch(targetPath, pattern, cwd)) {
          return { blocked: true, reason: `No-delete path: ${pattern}`, ask: false, rule: pattern };
        }
      }
    }
  }

  return { blocked: false, reason: null, ask: false };
}

/**
 * Format a block message with anti-bypass language (stolen from damage-control).
 */
export function formatBlockMessage(reason: string, rule?: string): string {
  return (
    `🛡️ BLOCKED by Damage Control: ${reason}` +
    (rule ? ` (rule: ${rule})` : "") +
    `\n\nDO NOT retry with alternative commands, different flags, or creative workarounds to achieve the same destructive result. ` +
    `This rule exists to prevent catastrophic mistakes. If you genuinely need to perform this action, ask the user to update .pi/damage-control-rules.yaml.`
  );
}

export function formatAskMessage(reason: string, rule?: string): string {
  return (
    `⚠️ Damage Control confirmation needed: ${reason}` +
    (rule ? ` (rule: ${rule})` : "") +
    `\n\nThis action might be destructive. Proceed with caution.`
  );
}
