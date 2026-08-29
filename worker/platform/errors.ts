import type { PlatformErrorCode } from "../../src/contracts/platform.ts";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: PlatformErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function platformErrorBody(error: PlatformError): { error: string; code: PlatformErrorCode; details?: Record<string, unknown> } {
  return { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
}
