/** Model-aware thinking-level support shared by spawn and settings UI. */

import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../types.js";
import { VALID_THINKING_LEVELS } from "../utils.js";

/**
 * Return the levels the model accepts. Without a resolved model, retain the
 * full Pi level set; the spawn boundary will resolve the model when possible.
 */
export function supportedThinkingLevels(model: Model<any> | undefined): readonly ThinkingLevel[] {
  return model ? getSupportedThinkingLevels(model) : VALID_THINKING_LEVELS;
}

/**
 * Normalize an explicit/inherited level for a resolved model. A missing
 * request stays missing so createAgentSession can apply Pi's own settings
 * default before performing its final clamp.
 */
export function normalizeThinkingLevel(
  model: Model<any> | undefined,
  requested: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  return model && requested !== undefined
    ? clampThinkingLevel(model, requested)
    : requested;
}
