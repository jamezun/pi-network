// Pi Network — Confirm-before-send safety prompt
// Phase 1.6: Optionally prompt user before sending tasks to remote agents.

import type { BridgeConfig } from "./config";

export interface ConfirmConfig {
  confirmSend: boolean;       // Confirm all task sends
  confirmBroadcast: boolean;  // Confirm broadcasts (stricter default)
  confirmTimeoutMs: number;   // Timeout before auto-cancel (default 30s)
}

export function loadConfirmConfig(config: BridgeConfig): ConfirmConfig {
  const raw = (config as any).confirmSend;
  if (typeof raw === "object" && raw !== null) {
    return {
      confirmSend: raw.confirmSend ?? false,
      confirmBroadcast: raw.confirmBroadcast ?? true,
      confirmTimeoutMs: raw.confirmTimeoutMs ?? 30_000,
    };
  }
  return {
    confirmSend: false,
    confirmBroadcast: true,
    confirmTimeoutMs: 30_000,
  };
}

export function shouldConfirm(config: ConfirmConfig, isBroadcast: boolean): boolean {
  if (isBroadcast && config.confirmBroadcast) return true;
  return config.confirmSend;
}

export function formatConfirmPrompt(peer: string, task: string, isBroadcast: boolean): string {
  const icon = isBroadcast ? "📢" : "📤";
  const target = isBroadcast ? "ALL peers" : peer;
  const preview = task.length > 200 ? task.slice(0, 200) + "…" : task;
  return `${icon} **Confirm send to ${target}?**\n\n> ${preview}\n\n_Respond "yes" to confirm, or "no" to cancel. Auto-cancels in 30s._`;
}
