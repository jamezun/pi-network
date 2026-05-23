// Pi Network — Git sync manager
// Cross-machine branch management, auto-commit, merge coordination.
//
// Architecture:
//   Workers: auto-branch → code → auto-commit → auto-push
//   Manager: periodic fetch → detect branches → merge clean → consolidate conflicts
//
// Mode: "github" (default) | "direct" (SSH) | "off"
// Sync transport is git itself — pi-network coordinates tasks, git syncs code.

import { execSync, exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { BridgeConfig, AgentRole } from "./config";

// ─── Types ───

export type GitSyncMode = "github" | "direct" | "off";

export interface GitSyncConfig {
  mode: GitSyncMode;
  /** Remote name (default: "origin") */
  remote: string;
  /** Base branch workers branch from / manager merges to (default: "main") */
  baseBranch: string;
  /** Branch prefix for workers: "agent/venus/" → branch "agent/venus/feat-auth" */
  branchPrefix: string;
  /** Auto-commit when agent_end fires and files changed (worker only) */
  autoCommitOnTaskComplete: boolean;
  /** Auto-push after commit (worker only) */
  autoPushOnCommit: boolean;
  /** Manager: interval in seconds for periodic git fetch (default: 30) */
  fetchIntervalSeconds: number;
  /** Manager: auto-merge branches with no conflicts (default: true) */
  autoMergeClean: boolean;
  /** Manager: squash-merge instead of regular merge (default: true) */
  squashMerge: boolean;
  /** Direct SSH config (only used when mode: "direct") */
  direct?: {
    host: string;
    user: string;
    repoPath: string;
    port?: number;
  };
}

interface BranchInfo {
  name: string;
  isClean: boolean;        // no conflicts vs main
  aheadBy: number;         // commits ahead of base
  behindBy: number;        // commits behind base
  lastCommitMessage: string;
  lastCommitAuthor: string;
  lastCommitDate: string;
}

interface MergeResult {
  branch: string;
  merged: boolean;
  hadConflicts: boolean;
  conflictedFiles: string[];
  message: string;
}

// ─── Config loader ───

export function loadGitSyncConfig(config: BridgeConfig): GitSyncConfig {
  const raw = (config as any).git_sync;
  if (!raw || raw.mode === "off") {
    return defaultGitSyncConfig("off");
  }

  return {
    mode: raw.mode || "github",
    remote: raw.remote || "origin",
    baseBranch: raw.base_branch || raw.baseBranch || "main",
    branchPrefix: raw.branch_prefix || raw.branchPrefix || `agent/${config.localName}/`,
    autoCommitOnTaskComplete: raw.auto_commit_on_task_complete ?? raw.autoCommitOnTaskComplete ?? true,
    autoPushOnCommit: raw.auto_push_on_commit ?? raw.autoPushOnCommit ?? true,
    fetchIntervalSeconds: raw.fetch_interval_seconds ?? raw.fetchIntervalSeconds ?? 30,
    autoMergeClean: raw.auto_merge_clean ?? raw.autoMergeClean ?? true,
    squashMerge: raw.squash_merge ?? raw.squashMerge ?? true,
    direct: raw.direct,
  };
}

function defaultGitSyncConfig(mode: GitSyncMode): GitSyncConfig {
  return {
    mode,
    remote: "origin",
    baseBranch: "main",
    branchPrefix: "",
    autoCommitOnTaskComplete: false,
    autoPushOnCommit: false,
    fetchIntervalSeconds: 30,
    autoMergeClean: true,
    squashMerge: true,
  };
}

// ─── GitSyncManager ───

export class GitSyncManager {
  private config: GitSyncConfig;
  private role: AgentRole;
  private localName: string;
  private cwd: string;
  private fetchTimer: ReturnType<typeof setInterval> | null = null;
  private currentBranch: string | null = null;

  constructor(gitSyncConfig: GitSyncConfig, role: AgentRole, localName: string, cwd: string) {
    this.config = gitSyncConfig;
    this.role = role;
    this.localName = localName;
    this.cwd = cwd;
  }

  // ─── Lifecycle ───

  /**
   * Start periodic operations based on role.
   * Manager: periodic fetch + merge loop.
   * Worker: nothing periodic (commits happen on task complete).
   */
  start(): void {
    if (this.config.mode === "off") return;
    if (!this.isGitRepo()) return;

    if (this.role === "manager") {
      this.startFetchLoop();
    }
  }

  stop(): void {
    if (this.fetchTimer) {
      clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  // ─── Worker operations ───

  /**
   * Create a feature branch for a task. Workers call this when they start coding.
   * Branch name: {branchPrefix}{sanitized-task-slug}
   * e.g. agent/hendry/fix-auth-validation
   */
  createTaskBranch(taskDescription: string): string {
    const slug = this.slugify(taskDescription);
    const branchName = `${this.config.branchPrefix}${slug}`;

    const baseBranch = `${this.config.remote}/${this.config.baseBranch}`;
    this.git(`checkout -b ${branchName} ${baseBranch}`);
    this.currentBranch = branchName;
    return branchName;
  }

  /**
   * Auto-commit all changes with a descriptive message.
   * Called from agent_end when task is complete and files changed.
   * Returns true if there was something to commit.
   */
  autoCommit(taskDescription: string, taskId: string): boolean {
    if (this.config.mode === "off") return false;
    if (!this.isGitRepo()) return false;

    // Check if there are any changes
    const status = this.git("status --porcelain");
    if (!status.trim()) return false; // nothing to commit

    const shortTask = taskDescription.length > 72
      ? taskDescription.slice(0, 69) + "..."
      : taskDescription;
    const message = `[agent:${this.localName}] ${shortTask}\n\nTask-Id: ${taskId}\nAgent: ${this.localName}\nRole: ${this.role}`;

    // Stage all changes
    this.git("add -A");

    // Commit
    this.git(`commit -m ${shellQuote(message)} --no-gpg-sign`);

    // Push
    if (this.config.autoPushOnCommit && this.currentBranch) {
      this.pushCurrentBranch();
    }

    return true;
  }

  /**
   * Push the current branch to remote.
   * Sets upstream tracking on first push.
   */
  pushCurrentBranch(): void {
    if (!this.currentBranch) return;
    try {
      this.git(`push -u ${this.config.remote} ${this.currentBranch}`);
    } catch (e: any) {
      // Remote might not have the branch yet — try with --set-upstream
      try {
        this.git(`push --set-upstream ${this.config.remote} ${this.currentBranch}`);
      } catch {
        // Push failed — network issue? Will retry on next commit.
        console.error(`Git sync push failed: ${e.message}`);
      }
    }
  }

  /**
   * Switch back to base branch (for cleanup after task).
   */
  switchToBase(): void {
    try {
      this.git(`checkout ${this.config.baseBranch}`);
      this.currentBranch = this.config.baseBranch;
    } catch {}
  }

  // ─── Manager operations ───

  /**
   * Fetch all remotes. Manager calls this periodically.
   */
  fetch(): void {
    this.git(`fetch ${this.config.remote} --prune --quiet`);
  }

  /**
   * List all agent branches (branches matching worker prefixes).
   */
  listAgentBranches(): BranchInfo[] {
    const raw = this.git(`branch -r --list "${this.config.remote}/agent/*" --format="%(refname:short) %(upstream:track)"`);
    const lines = raw.trim().split("\n").filter(Boolean);
    const branches: BranchInfo[] = [];

    for (const line of lines) {
      const branchRef = line.split(/\s+/)[0];
      if (!branchRef) continue;
      const branchName = branchRef.replace(`${this.config.remote}/`, "");

      try {
        const info = this.getBranchInfo(branchName);
        branches.push(info);
      } catch {
        // Branch might have been deleted between listing and inspection
      }
    }

    return branches;
  }

  /**
   * Get detailed info about a remote branch vs base.
   */
  getBranchInfo(branchName: string): BranchInfo {
    const baseRef = `${this.config.remote}/${this.config.baseBranch}`;
    const branchRef = `${this.config.remote}/${branchName}`;

    // Check if branch is ahead/behind base
    const aheadRaw = this.git(`rev-list ${baseRef}..${branchRef} --count`).trim();
    const behindRaw = this.git(`rev-list ${branchRef}..${baseRef} --count`).trim();
    const aheadBy = parseInt(aheadRaw, 10) || 0;
    const behindBy = parseInt(behindRaw, 10) || 0;

    // Check for conflicts by attempting a dry-run merge
    let isClean = true;
    try {
      this.git(`merge-tree $(git merge-base ${baseRef} ${branchRef}) ${baseRef} ${branchRef} | grep -c "^changed in both" || true`);
      // If merge-tree outputs "changed in both", there are conflicts
    } catch {
      // merge-tree might not support this flag — fall back to diff check
      isClean = true;
    }

    // Actually check conflicts properly
    isClean = this.checkMergeClean(branchName);

    const lastCommitMessage = this.git(`log ${branchRef} -1 --format="%s"`).trim();
    const lastCommitAuthor = this.git(`log ${branchRef} -1 --format="%an"`).trim();
    const lastCommitDate = this.git(`log ${branchRef} -1 --format="%ar"`).trim();

    return { name: branchName, isClean, aheadBy, behindBy, lastCommitMessage, lastCommitAuthor, lastCommitDate };
  }

  /**
   * Check if a branch merges cleanly into base.
   */
  checkMergeClean(branchName: string): boolean {
    try {
      // Stash any local changes
      const hasChanges = this.git("status --porcelain").trim().length > 0;
      if (hasChanges) this.git("stash --quiet");

      // Try merge --no-commit --no-ff, then abort
      const branchRef = `${this.config.remote}/${branchName}`;
      try {
        this.git(`merge --no-commit --no-ff ${branchRef}`);
        this.git("merge --abort");
        return true;
      } catch {
        try { this.git("merge --abort"); } catch {}
        return false;
      }
    } finally {
      // Restore stashed changes
      try { this.git("stash pop --quiet"); } catch {}
    }
  }

  /**
   * Merge a branch into base. Manager only.
   * Returns the merge result including conflict info if any.
   */
  mergeBranch(branchName: string): MergeResult {
    if (this.role !== "manager") {
      return { branch: branchName, merged: false, hadConflicts: false, conflictedFiles: [], message: "Only manager can merge" };
    }

    const branchRef = `${this.config.remote}/${branchName}`;

    // Ensure we're on base branch
    this.git(`checkout ${this.config.baseBranch}`);
    this.git(`pull ${this.config.remote} ${this.config.baseBranch} --ff-only`);

    try {
      if (this.config.squashMerge) {
        this.git(`merge --squash ${branchRef}`);
        const message = `merge: ${branchName}\n\nSquashed from agent branch ${branchName}`;
        this.git(`commit -m ${shellQuote(message)} --no-gpg-sign`);
      } else {
        this.git(`merge ${branchRef} --no-ff -m ${shellQuote(`merge: ${branchName}`)}`);
      }

      // Push merged base
      this.git(`push ${this.config.remote} ${this.config.baseBranch}`);

      // Delete the merged branch
      this.git(`push ${this.config.remote} --delete ${branchName}`);

      return { branch: branchName, merged: true, hadConflicts: false, conflictedFiles: [], message: "Merged cleanly" };
    } catch (e: any) {
      // Conflict
      const conflictedFiles = this.getConflictedFiles();
      return { branch: branchName, merged: false, hadConflicts: true, conflictedFiles, message: `Conflicts in: ${conflictedFiles.join(", ")}` };
    }
  }

  /**
   * Manager consolidates conflicting branches.
   * Called when mergeBranch returns hadConflicts: true.
   * The manager agent resolves the conflicts in code, then calls this to finalize.
   */
  consolidateBranch(branchName: string, resolvedFileContents: Map<string, string>): MergeResult {
    if (this.role !== "manager") {
      return { branch: branchName, merged: false, hadConflicts: false, conflictedFiles: [], message: "Only manager can consolidate" };
    }

    // Write resolved files
    for (const [filePath, content] of resolvedFileContents) {
      const absPath = resolve(this.cwd, filePath);
      writeFileSync(absPath, content, "utf8");
    }

    // Stage resolved files and commit
    this.git("add -A");

    const message = `merge: ${branchName} (consolidated)\n\nManager resolved conflicts in: ${[...resolvedFileContents.keys()].join(", ")}`;
    this.git(`commit -m ${shellQuote(message)} --no-gpg-sign`);

    // Push
    this.git(`push ${this.config.remote} ${this.config.baseBranch}`);

    // Delete the merged branch
    try {
      this.git(`push ${this.config.remote} --delete ${branchName}`);
    } catch {}

    return { branch: branchName, merged: true, hadConflicts: false, conflictedFiles: [], message: "Consolidated and merged" };
  }

  /**
   * Get the list of conflicting files during an ongoing merge conflict.
   */
  getConflictedFiles(): string[] {
    try {
      const raw = this.git("diff --name-only --diff-filter=U");
      return raw.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get the conflicting content for a file — returns ours, theirs, and base.
   */
  getConflictDetails(filePath: string): { ours: string; theirs: string; base: string } {
    const absPath = resolve(this.cwd, filePath);
    const ours = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";

    // Get their version from the branch being merged
    let theirs = "";
    try {
      theirs = this.git(`show MERGE_HEAD:${filePath}`);
    } catch {
      theirs = "";
    }

    // Get base version
    let base = "";
    try {
      base = this.git(`show :1:${filePath}`);
    } catch {
      base = "";
    }

    return { ours, theirs, base };
  }

  /**
   * Abort an in-progress merge. Used when manager wants to skip a branch.
   */
  abortMerge(): void {
    try { this.git("merge --abort"); } catch {}
  }

  /**
   * Generate a diff summary for manager review.
   */
  getBranchDiff(branchName: string): string {
    const baseRef = `${this.config.remote}/${this.config.baseBranch}`;
    const branchRef = `${this.config.remote}/${branchName}`;
    try {
      return this.git(`diff ${baseRef}...${branchRef} --stat`);
    } catch {
      return "(unable to generate diff)";
    }
  }

  /**
   * Generate the full diff for a branch (for detailed review).
   */
  getBranchFullDiff(branchName: string): string {
    const baseRef = `${this.config.remote}/${this.config.baseBranch}`;
    const branchRef = `${this.config.remote}/${branchName}`;
    try {
      return this.git(`diff ${baseRef}...${branchRef}`);
    } catch {
      return "(unable to generate diff)";
    }
  }

  // ─── Status ───

  /**
   * Get git sync status for display.
   */
  getStatus(): string {
    if (this.config.mode === "off") return "⬜ git sync off";

    const parts: string[] = [];
    parts.push(`mode: ${this.config.mode}`);
    parts.push(`base: ${this.config.baseBranch}`);

    if (this.role === "manager") {
      const branches = this.listAgentBranches();
      const clean = branches.filter(b => b.isClean).length;
      const conflicts = branches.filter(b => !b.isClean).length;
      parts.push(`branches: ${branches.length} (${clean} clean, ${conflicts} conflicts)`);
    } else {
      if (this.currentBranch) {
        const status = this.git("status --porcelain").trim();
        const changed = status ? status.split("\n").length : 0;
        parts.push(`branch: ${this.currentBranch} (${changed} changed files)`);
      } else {
        parts.push("no active branch");
      }
    }

    return `🔀 ${parts.join(" | ")}`;
  }

  /**
   * Is the current agent on a task branch?
   */
  isOnTaskBranch(): boolean {
    return this.currentBranch !== null && this.currentBranch !== this.config.baseBranch;
  }

  /**
   * Get the current branch name.
   */
  getCurrentBranch(): string | null {
    return this.currentBranch;
  }

  /**
   * Detect current branch from git if not tracked internally.
   */
  detectCurrentBranch(): string {
    try {
      return this.git("rev-parse --abbrev-ref HEAD").trim();
    } catch {
      return this.config.baseBranch;
    }
  }

  // ─── Branch protection ───

  /**
   * Install a pre-push hook that prevents workers from pushing to base branch.
   */
  installBranchProtection(): void {
    if (this.role !== "worker") return;

    const hookDir = join(this.cwd, ".git", "hooks");
    const hookPath = join(hookDir, "pre-push");

    if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });

    const hookScript = `#!/bin/sh
# Pi Network branch protection — workers cannot push to ${this.config.baseBranch}
while read local_ref local_sha remote_ref remote_sha; do
  branch=$(echo "$remote_ref" | sed 's|refs/heads/||')
  if [ "$branch" = "${this.config.baseBranch}" ]; then
    echo "❌ BLOCKED: Workers cannot push to ${this.config.baseBranch}"
    echo "   Create a branch with prefix '${this.config.branchPrefix}' instead"
    exit 1
  fi
done
exit 0
`;

    // Don't overwrite existing hook — append guard if not present
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf8");
      if (existing.includes("Pi Network branch protection")) return;
      // Append our guard at the end
      writeFileSync(hookPath, existing + "\n" + hookScript);
    } else {
      writeFileSync(hookPath, hookScript);
    }

    // Make executable
    try { execSync(`chmod +x ${shellQuote(hookPath)}`, { stdio: "pipe" }); } catch {}
  }

  // ─── Periodic operations ───

  private startFetchLoop(): void {
    if (this.fetchTimer) return;

    // Initial fetch
    try { this.fetch(); } catch {}

    this.fetchTimer = setInterval(() => {
      try {
        this.fetch();
        this.processPendingBranches();
      } catch {}
    }, this.config.fetchIntervalSeconds * 1000);

    try { (this.fetchTimer as any).unref?.(); } catch {}
  }

  /**
   * Manager: check for new agent branches, merge clean ones.
   * Conflicting branches are left for the manager agent to consolidate.
   */
  processPendingBranches(): BranchInfo[] {
    if (this.role !== "manager") return [];

    const branches = this.listAgentBranches();
    const pending: BranchInfo[] = [];

    for (const branch of branches) {
      if (branch.isClean && this.config.autoMergeClean) {
        const result = this.mergeBranch(branch.name);
        if (result.merged) continue; // merged, move on
      }
      // Either has conflicts or auto-merge is off — needs review
      pending.push(branch);
    }

    return pending;
  }

  // ─── Helpers ───

  private git(command: string): string {
    return execSync(`git ${command}`, {
      cwd: this.cwd,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private isGitRepo(): boolean {
    try {
      this.git("rev-parse --git-dir");
      return true;
    } catch {
      return false;
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }
}

// ─── Utility ───

function shellQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
