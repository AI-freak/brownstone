import { ValidationError } from '@brownstone/errors';

/**
 * Strongly-typed body field readers.
 *
 * Replaces the previous pattern of:
 *   String((body as Record<string, unknown>).prompt || '')
 * which is repeated dozens of times in the original server, hides type
 * errors behind `as any`, and silently coerces nulls.
 *
 * Each helper takes the parsed body, the field name, and throws a
 * ValidationError with a clear message if the field is missing or wrong type.
 */

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export interface BodyFields {
  string(field: string): string;
  optionalString(field: string): string | undefined;
  number(field: string): number;
  optionalNumber(field: string): number | undefined;
  boolean(field: string): boolean;
  optionalBoolean(field: string, fallback?: boolean): boolean | undefined;
  stringArray(field: string): string[];
  object<T extends Record<string, unknown> = Record<string, unknown>>(field: string): T;
  optionalObject<T extends Record<string, unknown> = Record<string, unknown>>(field: string): T | undefined;
  raw<T = unknown>(field: string): T | undefined;
  enum<T extends string>(field: string, allowed: readonly T[]): T;
  optionalEnum<T extends string>(field: string, allowed: readonly T[]): T | undefined;
}

export function fields(body: unknown): BodyFields {
  const record = asRecord(body);

  return {
    string(field) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError(`Field "${field}" is required and must be a non-empty string`);
      }
      return value;
    },
    optionalString(field) {
      const value = record[field];
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value !== 'string') {
        throw new ValidationError(`Field "${field}" must be a string when provided`);
      }
      return value;
    },
    number(field) {
      const value = record[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(`Field "${field}" must be a finite number`);
      }
      return value;
    },
    optionalNumber(field) {
      const value = record[field];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(`Field "${field}" must be a finite number when provided`);
      }
      return value;
    },
    boolean(field) {
      const value = record[field];
      if (typeof value !== 'boolean') {
        throw new ValidationError(`Field "${field}" must be a boolean`);
      }
      return value;
    },
    optionalBoolean(field, fallback) {
      const value = record[field];
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'boolean') {
        throw new ValidationError(`Field "${field}" must be a boolean when provided`);
      }
      return value;
    },
    stringArray(field) {
      const value = record[field];
      if (!Array.isArray(value)) {
        throw new ValidationError(`Field "${field}" must be an array of strings`);
      }
      return value.map((item, index) => {
        if (typeof item !== 'string') {
          throw new ValidationError(`Field "${field}[${index}]" must be a string`);
        }
        return item;
      });
    },
    object<T extends Record<string, unknown>>(field: string): T {
      const value = record[field];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(`Field "${field}" must be an object`);
      }
      return value as T;
    },
    optionalObject<T extends Record<string, unknown>>(field: string): T | undefined {
      const value = record[field];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(`Field "${field}" must be an object when provided`);
      }
      return value as T;
    },
    raw<T = unknown>(field: string): T | undefined {
      const value = record[field];
      return value === undefined ? undefined : (value as T);
    },
    enum<T extends string>(field: string, allowed: readonly T[]): T {
      const value = record[field];
      if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new ValidationError(`Field "${field}" must be one of: ${allowed.join(', ')}`);
      }
      return value as T;
    },
    optionalEnum<T extends string>(field: string, allowed: readonly T[]): T | undefined {
      const value = record[field];
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new ValidationError(`Field "${field}" must be one of: ${allowed.join(', ')} when provided`);
      }
      return value as T;
    },
  };
}

/** Convenience for query-string params, with the same shape. */
export function queryFields(params: URLSearchParams): {
  string(name: string): string;
  optionalString(name: string): string | undefined;
  optionalInt(name: string, fallback: number): number;
} {
  return {
    string(name) {
      const value = params.get(name);
      if (value === null || value === '') {
        throw new ValidationError(`Query parameter "${name}" is required`);
      }
      return value;
    },
    optionalString(name) {
      const value = params.get(name);
      return value === null || value === '' ? undefined : value;
    },
    optionalInt(name, fallback) {
      const value = params.get(name);
      if (value === null || value === '') return fallback;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) {
        throw new ValidationError(`Query parameter "${name}" must be an integer`);
      }
      return parsed;
    },
  };
}
