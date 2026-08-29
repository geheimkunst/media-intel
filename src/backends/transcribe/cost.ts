/**
 * Cost estimation for paid transcription backends.
 * Prices checked on 29-08-2026 on the vendor pages:
 * - OpenAI whisper-1: 0.006 USD per minute (0.36 USD per hour)
 * - ElevenLabs Scribe (scribe_v2): 0.22 USD per hour, billed per audio minute
 *   (https://elevenlabs.io/pricing/api, Speech to Text API; keyterms and entity detection cost extra and are not used)
 */

import { DEFAULT_ELEVENLABS_MODEL } from "../../config.js";

export type PaidBackend = "openai" | "elevenlabs";

export interface CostEstimate {
  backend: PaidBackend;
  model: string;
  duration_minutes: number;
  estimated_cost_usd: number;
}

export const OPENAI_WHISPER_1_COST_PER_MIN = 0.006;
export const ELEVENLABS_SCRIBE_COST_PER_HOUR = 0.22;

export function estimateCost(backend: PaidBackend, durationSeconds: number, model?: string): CostEstimate {
  const minutes = Math.max(0, durationSeconds) / 60;

  if (backend === "openai") {
    return {
      backend: "openai",
      model: model ?? "whisper-1",
      duration_minutes: Math.ceil(minutes),
      estimated_cost_usd: minutes * OPENAI_WHISPER_1_COST_PER_MIN,
    };
  }

  return {
    backend: "elevenlabs",
    model: model ?? DEFAULT_ELEVENLABS_MODEL,
    duration_minutes: Math.ceil(minutes),
    estimated_cost_usd: (minutes / 60) * ELEVENLABS_SCRIBE_COST_PER_HOUR,
  };
}
