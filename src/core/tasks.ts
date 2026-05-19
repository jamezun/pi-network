// Pi Network — Task envelope + chain of custody

import type { TaskPriority, TaskStatus, TaskMode } from "./config";
import { ulid } from "./ulid";

export interface ChainHop {
  agent: string;
  session: string;
  role: "instructor" | "manager" | "worker";
  timestamp: number;
  action: "delegated" | "reassigned" | "clarified";
}

export interface ProjectContext {
  cwd: string;
  repo?: string;
  branch?: string;
  keyFiles: string[];
}

export interface TaskEnvelope {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  originInstructor: string;
  originSession: string;
  chain: ChainHop[];
  task: string;
  taskType: TaskMode;
  status: TaskStatus;
  lockScope: string[];
  requiresConsolidation: boolean;
  deliverTo: string;
  projectContext?: ProjectContext;
  requiredSecrets?: string[];
  partialWork?: string;
  priority: TaskPriority;
  hops: number;        // Hop count for loop prevention (MAX_HOPS=5)
  conversationId?: string;  // Thread conversations across hops
  responseSchema?: object | null;  // Optional JSON Schema for structured replies
  userId?: string;
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskResult {
  taskId: string;
  rootTaskId: string;
  from: string;
  fromSession: string;
  deliverTo: string;
  deliverToSession: string;
  result: string;
  files: FileAttachment[];
  chain: ChainHop[];
  originInstructor: string;
  originSession: string;
  needsConsolidation: boolean;
  isConsolidated: boolean;
  partialResults: TaskResult[];
  status: TaskStatus;
  userId?: string;
}

export interface FileAttachment {
  filename: string;
  content: string; // base64
  path: string;    // original path on worker
}

export function generateId(): string {
  return ulid();
}

export function createEnvelope(params: {
  task: string;
  taskType?: TaskMode;
  priority?: TaskPriority;
  from: string;
  fromSession: string;
  deliverTo: string;
  parentTaskId?: string | null;
  rootTaskId?: string;
  originInstructor?: string;
  originSession?: string;
  chain?: ChainHop[];
  requiresConsolidation?: boolean;
  projectContext?: ProjectContext;
  requiredSecrets?: string[];
  userId?: string;
}): TaskEnvelope {
  const taskId = generateId();
  const now = Date.now();
  return {
    taskId,
    parentTaskId: params.parentTaskId || null,
    rootTaskId: params.rootTaskId || taskId,
    originInstructor: params.originInstructor || params.from,
    originSession: params.originSession || params.fromSession,
    chain: params.chain || [{
      agent: params.from,
      session: params.fromSession,
      role: "instructor",
      timestamp: now,
      action: "delegated",
    }],
    task: params.task,
    taskType: params.taskType || "agent",
    status: "queued",
    lockScope: [],
    requiresConsolidation: params.requiresConsolidation || false,
    deliverTo: params.deliverTo,
    projectContext: params.projectContext,
    requiredSecrets: params.requiredSecrets,
    priority: params.priority || "normal",
    hops: (params as any).hops || 0,
    conversationId: (params as any).conversationId,
    responseSchema: (params as any).responseSchema ?? null,
    userId: params.userId,
    queuedAt: now,
  };
}

export function extractResultFromMessages(messages: any[]): string {
  const lastAssistant = [...messages]
    .reverse()
    .find((m: any) => m.role === "assistant");

  if (!lastAssistant) return "(no result)";

  const textParts = (lastAssistant.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text);

  return textParts.join("\n") || "(no text result)";
}
