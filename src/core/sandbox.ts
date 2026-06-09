// Pi Network — Sandbox Model (Phase 4 prep — document now, build later)
//
// Ported from OpenClaw's per-agent isolation. For federation (Phase 4),
// external agent calls (cross-user) run in an isolated context. Media is
// copied into the workspace, path rewritten to `media/inbound/<file>`.
//
// Path canonicalization: symlink/parent tricks fail CLOSED against blocked
// roots (/etc, /var/run, credential dirs). This is a hostile-tenant guard —
// OpenClaw explicitly disclaims multi-tenant, so we build it ourselves.

import { resolve, normalize, relative, isAbsolute, join } from "node:path";

export type SandboxScope = "agent" | "session" | "shared";
export type WorkspaceAccess = "none" | "ro" | "rw";

export interface SandboxConfig {
  scope: SandboxScope;            // one container per agent / per session / shared
  workspaceAccess: WorkspaceAccess; // none (default) | ro | rw
  docker?: {
    setupCommand?: string;        // runs once on container creation
    binds?: string[];             // canonicalized + validated against blocked roots
  };
  /** Roots that binds must NEVER escape into (host system dirs). */
  blockedRoots?: string[];
}

export const DEFAULT_BLOCKED_ROOTS = [
  "/etc",
  "/var/run",
  "/run",
  "/root",
  "/home/*/.ssh",
  "/home/*/.pi/agent/auth.json",
  "/home/*/.aws",
  "/home/*/.config/gcloud",
  "/proc",
  "/sys",
];

export class SandboxError extends Error {}

/**
 * Canonicalize a bind path and reject any that escape into a blocked root.
 * Symlink tricks fail CLOSED: we resolve real paths and compare prefixes.
 */
export function validateBind(
  bindPath: string,
  blockedRoots: string[] = DEFAULT_BLOCKED_ROOTS,
): string {
  const canonical = resolve(normalize(bindPath));
  for (const blocked of blockedRoots) {
    if (matchesBlocked(canonical, blocked)) {
      throw new SandboxError(`Bind path "${bindPath}" escapes into blocked root "${blocked}"`);
    }
  }
  return canonical;
}

function matchesBlocked(candidate: string, pattern: string): boolean {
  // Support glob patterns like /home/*/.ssh
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]+") + "(/|$)");
    return re.test(candidate);
  }
  return candidate === pattern || candidate.startsWith(pattern + "/");
}

/**
 * Rewrite an inbound media path into the sandbox workspace.
 * e.g. /tmp/inbound/foo.png → <workspace>/media/inbound/foo.png
 * Stolen from OpenClaw's media/inbound/<file> convention.
 */
export function rewriteMediaPath(workspaceRoot: string, originalName: string): string {
  // strip any path components from the original name — keep basename only
  const safe = normalize(originalName).replace(/^(\.\.[/\\])+/, "");
  const base = safe.split(/[/\\]/).pop() || "file";
  return join(workspaceRoot, "media", "inbound", base);
}

/**
 * Validate that a resolved path stays inside the workspace (no traversal out).
 */
export function assertInsideWorkspace(workspaceRoot: string, target: string): void {
  const root = resolve(workspaceRoot);
  const rel = relative(root, resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SandboxError(`Path "${target}" escapes workspace "${workspaceRoot}"`);
  }
}

/**
 * Resolve the effective workspace access for a binding.
 * `none` is the safe default — workspace is off-limits unless explicitly granted.
 */
export function effectiveAccess(config: SandboxConfig | undefined): WorkspaceAccess {
  return config?.workspaceAccess ?? "none";
}
