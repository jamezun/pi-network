// Pi Network — WhatsApp proactive notifications
// Phase 2.7: Push notifications to WhatsApp for task completion, peer changes, damage control blocks.

import type { AgentEntry } from "./registry";
import type { TaskResult } from "./tasks";

interface NotificationThrottle {
  lastSent: number;
  minIntervalMs: number; // 30s default
}

export class WhatsAppNotifier {
  private apiUrl: string;
  private apiKey: string;
  private instanceName: string;
  private targetNumber: string;
  private throttle: NotificationThrottle = { lastSent: 0, minIntervalMs: 30_000 };
  private enabled: boolean;

  constructor(config: {
    enabled: boolean;
    evolutionApiUrl?: string;
    evolutionApiKey?: string;
    instanceName?: string;
    targetNumber?: string;
    throttleMs?: number;
  }) {
    this.enabled = config.enabled;
    this.apiUrl = config.evolutionApiUrl || "";
    this.apiKey = config.evolutionApiKey || "";
    this.instanceName = config.instanceName || "pi-network";
    this.targetNumber = config.targetNumber || "";
    this.throttle.minIntervalMs = config.throttleMs ?? 30_000;
  }

  /**
   * Notify that a long-running task completed.
   */
  async notifyTaskComplete(result: TaskResult): Promise<void> {
    if (!this.enabled) return;
    const preview = result.result.length > 200 ? result.result.slice(0, 200) + "…" : result.result;
    await this.send(`✅ *Task Complete*\nFrom: ${result.from}\n${preview}`);
  }

  /**
   * Notify that a peer went offline/online.
   */
  async notifyPeerStatusChange(peer: AgentEntry, oldStatus: string): Promise<void> {
    if (!this.enabled) return;
    if (peer.status === oldStatus) return;
    const icon = peer.status === "online" ? "🟢" : "🔴";
    await this.send(`${icon} ${peer.name} is now ${peer.status}`);
  }

  /**
   * Notify that damage control blocked an operation.
   */
  async notifyDamageControlBlock(peer: string, reason: string): Promise<void> {
    if (!this.enabled) return;
    await this.send(`🛡️ *BLOCKED by Damage Control*\nPeer: ${peer}\nReason: ${reason}\n_Respond "approve" to allow, or ignore to deny._`);
  }

  /**
   * Notify that damage control needs human confirmation (WhatsApp approval flow).
   */
  async requestConfirmation(peer: string, reason: string): Promise<void> {
    if (!this.enabled) return;
    await this.send(`⚠️ *Confirmation Required*\nPeer: ${peer}\nAction: ${reason}\n\n_Reply "yes" to approve, "no" to deny._`);
  }

  private async send(text: string): Promise<void> {
    // Throttle
    const now = Date.now();
    if (now - this.throttle.lastSent < this.throttle.minIntervalMs) return;
    this.throttle.lastSent = now;

    try {
      await fetch(`${this.apiUrl}/message/sendText/${this.instanceName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.apiKey,
        },
        body: JSON.stringify({
          number: this.targetNumber,
          text,
        }),
      });
    } catch {}
  }
}
