// Pi Network — Vision Adapter (image → understanding)
//
// OpenClaw pattern: vision-native models get passthrough (no summary block);
// non-vision models get an injected [Image] description. This adapter decides
// which path applies based on the recipient session's declared `modalities`.

export type VisionCapability = "native" | "summary" | "none";

export interface VisionContext {
  /** Can the target agent's model ingest images natively? */
  targetIsVisionNative: boolean;
  /** Optional function that produces a description for non-vision models. */
  describe?: (imageUrl: string) => Promise<string>;
}

export interface VisionResult {
  /** What the agent bridge should actually receive. */
  textBlock: string;
  /** The passthrough url, if the model can handle it directly. */
  passthroughUrl?: string;
  /** Which path was taken. */
  capability: VisionCapability;
}

const SUMMARY_PLACEHOLDER = (desc: string) => `[Image: ${desc}]`;

/**
 * Decide how to present an image to a recipient.
 * - native: pass the url through (model reads it directly)
 * - summary: inject a [Image: ...] description block (model has no eyes)
 * - none: drop entirely (recipient can't process media)
 */
export async function describeImage(
  imageUrl: string,
  ctx: VisionContext,
): Promise<VisionResult> {
  if (ctx.targetIsVisionNative) {
    return { textBlock: "", passthroughUrl: imageUrl, capability: "native" };
  }
  if (ctx.describe) {
    try {
      const desc = await ctx.describe(imageUrl);
      return { textBlock: SUMMARY_PLACEHOLDER(desc), capability: "summary" };
    } catch {
      return { textBlock: SUMMARY_PLACEHOLDER("(description unavailable)"), capability: "summary" };
    }
  }
  // No describer available — still emit a placeholder so the agent knows an image exists.
  return { textBlock: SUMMARY_PLACEHOLDER("(received)"), capability: "summary" };
}

/**
 * Map a set of model/session modalities to a VisionCapability for routing.
 */
export class VisionAdapter {
  constructor(private knownVisionModels: RegExp[] = DEFAULT_VISION_MODELS) {}

  isVisionNative(modelOrModalities?: string | { vision?: boolean }): boolean {
    if (typeof modelOrModalities === "object") {
      return modelOrModalities?.vision === true;
    }
    if (!modelOrModalities) return false;
    return this.knownVisionModels.some(re => re.test(modelOrModalities));
  }
}

// Models that ingest images natively (no [Image] summary needed).
export const DEFAULT_VISION_MODELS: RegExp[] = [
  /gpt-4o/i, /gpt-4.*vision/i, /gpt-4-turbo/i,
  /claude-3/i, /claude-4/i, /claude-opus/i, /claude-sonnet/i,
  /gemini/i, /glm-4v/i, /qwen.*vl/i, /pixtral/i,
];
