// Pi Network — Task Claiming System
// Post tasks to the network for any idle peer to grab.

export interface ClaimableTask {
  taskId: string;
  task: string;
  postedBy: string;
  postedAt: number;
  priority: "urgent" | "high" | "normal" | "low";
  claimedBy?: string;
  claimedAt?: number;
  status: "open" | "claimed" | "completed" | "expired";
  result?: string;
}

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000; // 5 min to claim
const TASK_TTL_MS = 30 * 60 * 1000; // 30 min before expiry

const tasks = new Map<string, ClaimableTask>();

let onNewTask: ((task: ClaimableTask) => void) | null = null;

export function setOnNewTask(cb: (task: ClaimableTask) => void): void {
  onNewTask = cb;
}

export function postTask(taskId: string, task: string, postedBy: string, priority: ClaimableTask["priority"] = "normal"): ClaimableTask {
  const t: ClaimableTask = {
    taskId,
    task,
    postedBy,
    postedAt: Date.now(),
    priority,
    status: "open",
  };
  tasks.set(taskId, t);
  if (onNewTask) onNewTask(t);
  return t;
}

export function claimTask(taskId: string, claimedBy: string): ClaimableTask | null {
  const t = tasks.get(taskId);
  if (!t) return null;
  if (t.status !== "open") return null;
  if (Date.now() - t.postedAt > CLAIM_TIMEOUT_MS) {
    t.status = "expired";
    return null;
  }
  t.claimedBy = claimedBy;
  t.claimedAt = Date.now();
  t.status = "claimed";
  return t;
}

export function completeTask(taskId: string, result: string): ClaimableTask | null {
  const t = tasks.get(taskId);
  if (!t) return null;
  t.status = "completed";
  t.result = result;
  return t;
}

export function getOpenTasks(): ClaimableTask[] {
  // Expire old tasks
  const now = Date.now();
  for (const t of tasks.values()) {
    if (t.status === "open" && now - t.postedAt > TASK_TTL_MS) {
      t.status = "expired";
    }
  }
  return [...tasks.values()].filter(t => t.status === "open").sort((a, b) => {
    const order = { urgent: 0, high: 1, normal: 2, low: 3 };
    return (order[a.priority] ?? 2) - (order[b.priority] ?? 2) || a.postedAt - b.postedAt;
  });
}

export function getAllTasks(): ClaimableTask[] {
  return [...tasks.values()].sort((a, b) => b.postedAt - a.postedAt);
}

export function getTask(taskId: string): ClaimableTask | undefined {
  return tasks.get(taskId);
}
