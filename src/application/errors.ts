/** Errors the application reports to its callers with a stable code. */
export type ApplicationErrorCode =
  | "not_found"
  | "invalid_request"
  | "not_configured"
  | "conflict"
  | "upstream_failure";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
