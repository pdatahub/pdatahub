/**
 * JSON Schema validation for plugin tool inputs (v2).
 *
 * Backed by `ajv`. Plugin authors opt in by passing `inputSchema` to the
 * `@Tool` decorator and importing `validateInput` (or using the implicit
 * validation the @Tool wrapper applies, see design doc § 2).
 *
 * The shared ajv instance is configured with:
 *   - `allErrors: true` so we collect every problem (though validateInput
 *     currently surfaces only the first; callers can introspect via the
 *     compiled `ValidateFunction` directly).
 *   - `strict: false` so non-standard keywords (e.g., `example`) do not
 *     throw at compile time. Plugins can use them for documentation.
 */
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { ValidationError } from './errors.js';

/**
 * Single shared Ajv instance. Module-level so compiled schemas are
 * cached by ajv's internal reference table — compiling the same schema
 * twice returns the same ValidateFunction.
 *
 * `verbose: true` is required so ajv includes the offending `data` value
 * on each error. Without it, the {@link ValidationError} we throw loses the
 * actual bad value.
 */
const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });

/**
 * Compile a JSON Schema into an ajv `ValidateFunction`.
 *
 * Throws a plain `Error` (not `ValidationError`) when the schema itself
 * is invalid — that's a programmer bug, not a runtime input problem.
 *
 * @example
 * ```typescript
 * const validate = compileSchema({
 *   type: 'object',
 *   required: ['channel'],
 *   properties: { channel: { type: 'string' } },
 * });
 * if (!validate({ channel: '#general' })) {
 *   console.log(validate.errors);
 * }
 * ```
 */
export function compileSchema(schema: object): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON Schema: ${message}`);
  }
}

/**
 * Derive the field name from an ajv error.
 *
 * ajv surfaces required-property violations via `params.missingProperty`
 * (with empty `instancePath`) — combine them so `field` reads as
 * `address.street` rather than just `address`.
 *
 * For other errors, `instancePath` is a JSON Pointer like `/channel/0`
 * which we strip of the leading `/` and convert `/` separators to `.`.
 */
function deriveField(err: { instancePath?: string; keyword?: string; params?: Record<string, unknown> } | undefined): string {
  if (!err) return '<root>';
  const path = err.instancePath?.replace(/^\//, '').replace(/\//g, '.') ?? '';
  if (err.keyword === 'required') {
    const missing = (err.params as { missingProperty?: string })?.missingProperty;
    if (missing) {
      return path.length > 0 ? `${path}.${missing}` : missing;
    }
  }
  return path.length > 0 ? path : '<root>';
}

/**
 * Validate `data` against `schema`. On failure, throws a {@link ValidationError}
 * describing the first problem ajv reported.
 *
 * `toolName` is reserved for future use (e.g., wrapping the error message
 * with the tool name) and is currently unused — kept in the signature for
 * forward compatibility.
 *
 * The thrown ValidationError's `field` is derived from `instancePath`
 * (with `/` separators converted to `.`) combined with
 * `params.missingProperty` for `required` errors, so `address.street`
 * surfaces as `field: 'address.street'` rather than `field: 'address'`.
 *
 * @example
 * ```typescript
 * validateInput(schema, { channel: 123 }, 'sendMessage');
 * // throws ValidationError('channel', 123, 'must be string')
 * ```
 */
export function validateInput(
  schema: object,
  data: unknown,
  _toolName: string,
): void {
  const validate = compileSchema(schema);
  if (validate(data)) return;

  const err = validate.errors?.[0];
  const field = deriveField(err);
  const constraint = err?.message ?? 'unknown';
  // ajv 8 with verbose:true puts the offending value in err.data.
  // The `data` cast is safe because we only set `verbose: true` on the
  // shared instance — see constructor above.
  const value = (err as unknown as { data?: unknown } | undefined)?.data;
  throw new ValidationError(field, value, constraint);
}

/**
 * Decorator-style wrapper: returns a function that validates its single
 * object argument before delegating to the original method.
 *
 * Intended use inside `@Tool`:
 * ```typescript
 * @Tool({ scope: 'send', description: 'Send a message', inputSchema })
 * async send(input: { channel: string; text: string }) { ... }
 * ```
 *
 * The decorator (when extended for v2) wraps the method with
 * `withSchema(opts.inputSchema)`. Plugin authors who prefer explicit
 * control can call `withSchema(schema)(method)` directly.
 *
 * @param schema  JSON Schema to validate the input against.
 * @returns  Method decorator that wraps the original function.
 */
export function withSchema(schema: object) {
  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') {
      throw new Error('withSchema: target property is not a function');
    }
    descriptor.value = function (...args: unknown[]): unknown {
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        validateInput(schema, args[0], String(_propertyKey));
      }
      return original.apply(this, args);
    };
    return descriptor;
  };
}

/** Re-export ajv's ValidateFunction so callers don't need to import ajv. */
export type { ValidateFunction };