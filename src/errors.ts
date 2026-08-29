/**
 * Errors that carry an agent-facing hint. Tool handlers convert them into
 * `isError: true` results with the hint attached, so the model can recover
 * (install a binary, fix a path, pick another tool) instead of guessing.
 */
export class MediaIntelError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "MediaIntelError";
    this.code = code;
    this.hint = hint;
  }
}

export function toolErrorResult(error: unknown) {
  if (error instanceof MediaIntelError) {
    const hint = error.hint ? `\nHint: ${error.hint}` : "";
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: `${error.code}: ${error.message}${hint}` }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `internal_error: ${message}` }],
  };
}
