/**
 * Cost estimation for transcription backends.
 * As of 2026-08-29:
 * - OpenAI Whisper-1: $0.006 USD per minute
 * - Groq Whisper-Large-V3-Turbo: $0.04 USD per hour
 */

export interface CostEstimate {
  backend: "openai" | "groq";
  model: string;
  duration_minutes: number;
  estimated_cost_usd: number;
}

const OPENAI_WHISPER_1_COST_PER_MIN = 0.006;
const GROQ_WHISPER_COST_PER_HOUR = 0.04;
const GROQ_WHISPER_COST_PER_MIN = GROQ_WHISPER_COST_PER_HOUR / 60;

export function estimateCost(backend: "openai" | "groq", durationSeconds: number): CostEstimate {
  const minutes = durationSeconds / 60;

  if (backend === "openai") {
    return {
      backend: "openai",
      model: "whisper-1",
      duration_minutes: Math.ceil(minutes),
      estimated_cost_usd: minutes * OPENAI_WHISPER_1_COST_PER_MIN,
    };
  }

  return {
    backend: "groq",
    model: "whisper-large-v3-turbo",
    duration_minutes: Math.ceil(minutes),
    estimated_cost_usd: minutes * GROQ_WHISPER_COST_PER_MIN,
  };
}
