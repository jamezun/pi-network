// Pi Network — Unified presence tracking
// Phase 1.8: Real-time presence with per-tool status, model changes, and registry sync.

export type PresenceState = "idle" | "thinking" | { tool: string };

export interface PresenceUpdate {
  agent: string;
  state: PresenceState;
  model?: string;
  contextUsedPct?: number;
  queueLength?: number;
  activeTaskCount?: number;
  timestamp: number;
}

export class PresenceManager {
  private currentState: PresenceState = "idle";
  private currentModel?: string;
  private updates: PresenceUpdate[] = [];
  private maxHistory = 100;

  getState(): PresenceState {
    return this.currentState;
  }

  getModel(): string | undefined {
    return this.currentModel;
  }

  setThinking(): PresenceUpdate {
    this.currentState = "thinking";
    return this.createUpdate();
  }

  setToolExecuting(toolName: string): PresenceUpdate {
    this.currentState = { tool: toolName };
    return this.createUpdate();
  }

  setIdle(): PresenceUpdate {
    this.currentState = "idle";
    return this.createUpdate();
  }

  setModel(model: string): PresenceUpdate {
    this.currentModel = model;
    return this.createUpdate();
  }

  updateContext(pct: number, queueLen: number, activeTasks: number): PresenceUpdate {
    const update = this.createUpdate();
    update.contextUsedPct = pct;
    update.queueLength = queueLen;
    update.activeTaskCount = activeTasks;
    return update;
  }

  private createUpdate(): PresenceUpdate {
    const update: PresenceUpdate = {
      agent: "",  // filled by caller
      state: this.currentState,
      model: this.currentModel,
      timestamp: Date.now(),
    };
    this.updates.push(update);
    if (this.updates.length > this.maxHistory) this.updates.shift();
    return update;
  }

  getRecentUpdates(count = 20): PresenceUpdate[] {
    return this.updates.slice(-count);
  }

  formatState(): string {
    if (this.currentState === "idle") return "🟢 idle";
    if (this.currentState === "thinking") return "🟡 thinking";
    if (typeof this.currentState === "object" && "tool" in this.currentState) {
      return `🔧 ${this.currentState.tool}`;
    }
    return "❓ unknown";
  }
}
