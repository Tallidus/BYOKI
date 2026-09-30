import type { ErrorCode } from "./types.js";

export class AIConnectionsError extends Error {
  readonly code: ErrorCode;
  readonly providerRequestId?: string;

  constructor(code: ErrorCode, message: string, providerRequestId?: string) {
    super(message);
    this.name = "AIConnectionsError";
    this.code = code;
    if (providerRequestId !== undefined) {
      this.providerRequestId = providerRequestId;
    }
  }
}

export function isAIConnectionsError(error: unknown): error is AIConnectionsError {
  return error instanceof AIConnectionsError;
}
