// Pi Network — STT Cascade (audio → text)
//
// OpenClaw's cascade: active reply model (if audio-native) → local CLIs
// (sherpa-onnx / whisper.cpp / whisper) → provider APIs (OpenAI / Groq /
// xAI / Deepgram / Google / ...). Default: gpt-4o-mini-transcribe.
//
// Our recommended default: Groq Whisper large-v3 (sub-0.5s, $0.0008/min) →
// OpenAI fallback → self-hosted whisper.cpp for power users.

export interface TranscriptResult {
  transcript: string;
  language?: string;
  confidence?: number;
  provider: string;
  durationMs?: number;
}

export interface STTProvider {
  name: string;
  /** Whether this provider can run given the current config/env. */
  available(): Promise<boolean>;
  transcribe(audioPath: string, opts?: { language?: string }): Promise<TranscriptResult>;
}

export interface STTConfig {
  groqApiKey?: string;
  openaiApiKey?: string;
  /** Path to a self-hosted whisper-cli binary (whisper.cpp). */
  whisperCliPath?: string;
  /** Preferred language hint (ISO code). */
  language?: string;
}

// ─── Provider implementations ──────────────────────────────────────────────

class GroqSTT implements STTProvider {
  name = "groq";
  constructor(private cfg: STTConfig) {}
  async available(): Promise<boolean> {
    return Boolean(this.cfg.groqApiKey);
  }
  async transcribe(audioPath: string, opts?: { language?: string }): Promise<TranscriptResult> {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const form = new FormData();
    form.append("file", new Blob([await readFile(audioPath)]), basename(audioPath));
    form.append("model", "whisper-large-v3");
    form.append("response_format", "verbose_json");
    if (opts?.language || this.cfg.language) form.append("language", opts?.language ?? this.cfg.language!);
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.groqApiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Groq STT ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return {
      transcript: data.text ?? "",
      language: data.language,
      confidence: data.segments?.length ? avg(data.segments.map((s: any) => s.avg_logprob)) : undefined,
      provider: this.name,
      durationMs: data.duration ? Math.round(data.duration * 1000) : undefined,
    };
  }
}

class OpenAISTT implements STTProvider {
  name = "openai";
  constructor(private cfg: STTConfig) {}
  async available(): Promise<boolean> {
    return Boolean(this.cfg.openaiApiKey);
  }
  async transcribe(audioPath: string, opts?: { language?: string }): Promise<TranscriptResult> {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const form = new FormData();
    form.append("file", new Blob([await readFile(audioPath)]), basename(audioPath));
    form.append("model", "gpt-4o-mini-transcribe");
    if (opts?.language || this.cfg.language) form.append("language", opts?.language ?? this.cfg.language!);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.openaiApiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return { transcript: data.text ?? "", provider: this.name };
  }
}

class WhisperCliSTT implements STTProvider {
  name = "whisper-cpp";
  constructor(private cfg: STTConfig) {}
  async available(): Promise<boolean> {
    if (!this.cfg.whisperCliPath) return false;
    const { access } = await import("node:fs/promises");
    try { await access(this.cfg.whisperCliPath); return true; } catch { return false; }
  }
  async transcribe(audioPath: string): Promise<TranscriptResult> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      execFile(this.cfg.whisperCliPath!, ["-f", audioPath, "-nt"], { timeout: 120_000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve({ transcript: stdout.trim(), provider: this.name });
      });
    });
  }
}

function avg(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Build the default cascade in priority order:
 *   Groq (fastest/cheapest) → OpenAI (most accurate) → whisper.cpp (self-hosted).
 */
export function DEFAULT_STT_CHAIN(cfg: STTConfig): STTProvider[] {
  return [new GroqSTT(cfg), new OpenAISTT(cfg), new WhisperCliSTT(cfg)];
}

/**
 * Transcribe by walking the cascade; first available + succeeding provider wins.
 * Throws only if EVERY provider is unavailable or fails.
 */
export async function transcribe(
  audioPath: string,
  cfg: STTConfig,
  chain?: STTProvider[],
  opts?: { language?: string },
): Promise<TranscriptResult> {
  const providers = chain ?? DEFAULT_STT_CHAIN(cfg);
  const errors: string[] = [];
  for (const p of providers) {
    try {
      if (!(await p.available())) { errors.push(`${p.name}: unavailable`); continue; }
      return await p.transcribe(audioPath, opts);
    } catch (e: any) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  throw new Error(`All STT providers failed: ${errors.join("; ")}`);
}
