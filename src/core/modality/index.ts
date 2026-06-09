// Pi Network — Improvement #2: Modality Adapter Services (Axis 2)
//
// Stolen from OpenClaw's understand-then-dispatch pipeline + provider cascade.
// These adapters run BEFORE dispatch to the agent bridge (Axis 1 bridges stay
// dumb). The relay decides: passthrough to a vision-native model, or inject an
// [Image] summary for non-vision; transcribe audio via a cascading STT chain.
//
// All providers behind a stable internal interface so swapping backends is free.

export { STTProvider, transcribe, DEFAULT_STT_CHAIN } from "./stt";
export { VisionAdapter, describeImage, type VisionCapability } from "./vision";
export { ObjectStorage, type ObjectStorageConfig, type StoredObject } from "./storage";

// Media caps stolen from OpenClaw (understand / send limits).
export const MEDIA_CAPS = {
  image: { understandMaxBytes: 10 * 1024 * 1024, sendMaxBytes: 50 * 1024 * 1024 },
  audio: { understandMaxBytes: 20 * 1024 * 1024, sendMaxBytes: 16 * 1024 * 1024 },
  video: { understandMaxBytes: 50 * 1024 * 1024 },
  /** Tiny files are skipped before transcription (no signal). */
  minTranscribeBytes: 1024,
} as const;

export type MediaKind = "image" | "audio" | "video" | "file";
