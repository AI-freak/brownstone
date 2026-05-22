/**
 * Typed error hierarchy.
 *
 * Replaces the previous pattern of classifying HTTP status codes by regexing
 * `error.message`. Each error class carries its own `statusCode` and a stable
 * `code` for clients, so renaming a message string never changes behavior.
 *
 * All errors deliberately subclass `AppError` so callers can use
 * `instanceof AppError` as a single discrimination point.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'upstream_unavailable'
  | 'timeout'
  | 'internal';

export interface AppErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.details = options.details;
  }

  /** Wire format suitable for an HTTP error body. */
  toJSON(): { error: string; code: ErrorCode; details?: Record<string, unknown> } {
    return this.details
      ? { error: this.message, code: this.code, details: this.details }
      : { error: this.message, code: this.code };
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'validation_failed' as const;
}

export class UnauthenticatedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'unauthenticated' as const;
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'forbidden' as const;
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'not_found' as const;
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'conflict' as const;
}

export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = 'payload_too_large' as const;
}

export class UpstreamError extends AppError {
  readonly statusCode = 502;
  readonly code = 'upstream_unavailable' as const;
}

export class TimeoutError extends AppError {
  readonly statusCode = 504;
  readonly code = 'timeout' as const;
}

export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'internal' as const;
}

/**
 * Convert any thrown value into a structured response. Unknown errors become
 * `InternalError` with their original message preserved (never leak stack
 * traces to clients — that's the caller's job to log).
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    // Preserve any third-party libraries that already set statusCode.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number') {
      return mapStatusToError(status, error.message, { cause: error });
    }
    return new InternalError(error.message || 'Internal error', { cause: error });
  }
  return new InternalError('Unknown error');
}

function mapStatusToError(status: number, message: string, options: AppErrorOptions): AppError {
  switch (status) {
    case 400: return new ValidationError(message, options);
    case 401: return new UnauthenticatedError(message, options);
    case 403: return new ForbiddenError(message, options);
    case 404: return new NotFoundError(message, options);
    case 409: return new ConflictError(message, options);
    case 413: return new PayloadTooLargeError(message, options);
    case 502: return new UpstreamError(message, options);
    case 504: return new TimeoutError(message, options);
    default: return new InternalError(message, options);
  }
}
