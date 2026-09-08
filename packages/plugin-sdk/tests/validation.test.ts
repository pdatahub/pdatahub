import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import {
  compileSchema,
  validateInput,
  withSchema,
  type ValidateFunction,
} from '../src/validation.js';
import { ValidationError } from '../src/errors.js';

describe('compileSchema', () => {
  it('returns a working ajv ValidateFunction', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    // ValidateFunction has a typed signature
    const fn: ValidateFunction = validate;
    expect(typeof fn).toBe('function');
    expect(validate({ name: 'x' })).toBe(true);
    expect(validate({})).toBe(false);
  });

  it('throws a plain Error on invalid schema', () => {
    // `type: 'banana'` is not a valid JSON Schema type
    expect(() => compileSchema({ type: 'banana' as 'string' })).toThrow(
      /Invalid JSON Schema/,
    );
  });
});

describe('validateInput', () => {
  const sendMessageSchema = {
    type: 'object',
    required: ['channel', 'text'],
    properties: {
      channel: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      attachments: { type: 'array', items: { type: 'string' } },
    },
  } as const;

  it('passes on valid input (returns void)', () => {
    expect(() =>
      validateInput(
        sendMessageSchema,
        { channel: '#general', text: 'hello' },
        'sendMessage',
      ),
    ).not.toThrow();
  });

  it('throws ValidationError with field name on missing required field', () => {
    try {
      validateInput(sendMessageSchema, { channel: '#x' }, 'sendMessage');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.field).toBe('text');
      expect(ve.code).toBe('VALIDATION_FAILED');
      expect(ve.constraint).toMatch(/required/i);
    }
  });

  it('throws ValidationError on wrong type', () => {
    try {
      validateInput(sendMessageSchema, { channel: 123, text: 'x' }, 'sendMessage');
      expect.fail('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve).toBeInstanceOf(ValidationError);
      expect(ve.field).toBe('channel');
      expect(ve.value).toBe(123);
    }
  });

  it('validates nested objects (address.street)', () => {
    const addressSchema = {
      type: 'object',
      required: ['address'],
      properties: {
        address: {
          type: 'object',
          required: ['street'],
          properties: {
            street: { type: 'string' },
            zip: { type: 'string' },
          },
        },
      },
    } as const;

    expect(() =>
      validateInput(addressSchema, { address: { street: 'Main', zip: '1' } }, 'ship'),
    ).not.toThrow();

    try {
      validateInput(addressSchema, { address: { zip: '1' } }, 'ship');
      expect.fail('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      // ajv uses dot-notation for nested required paths
      expect(ve.field).toBe('address.street');
    }
  });

  it('validates arrays (minItems / maxItems)', () => {
    const arraySchema = {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: { type: 'number' },
    } as const;

    expect(() => validateInput(arraySchema, [1, 2], 'arr')).not.toThrow();
    expect(() => validateInput(arraySchema, [1, 2, 3, 4], 'arr')).not.toThrow();

    try {
      validateInput(arraySchema, [1], 'arr');
      expect.fail('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve).toBeInstanceOf(ValidationError);
      expect(ve.constraint).toMatch(/min|fewer/i);
    }

    try {
      validateInput(arraySchema, [1, 2, 3, 4, 5], 'arr');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });

  it('validates enum constraints', () => {
    const enumSchema = {
      type: 'string',
      enum: ['red', 'green', 'blue'],
    } as const;

    expect(() => validateInput(enumSchema, 'red', 'color')).not.toThrow();

    try {
      validateInput(enumSchema, 'orange', 'color');
      expect.fail('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve).toBeInstanceOf(ValidationError);
      expect(ve.constraint).toMatch(/must be equal to one of|enum/);
    }
  });

  it('throws the FIRST error when multiple are present (ajv allErrors collects, we surface one)', () => {
    const strict = {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    } as const;

    try {
      validateInput(strict, {}, 'multi');
      expect.fail('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      // ajv reports 'a' first because it's listed first in `required`
      expect(ve.field).toBe('a');
    }
  });

  it('empty schema accepts any input', () => {
    expect(() => validateInput({}, 'whatever', 'any')).not.toThrow();
    expect(() => validateInput({}, { anything: true }, 'any')).not.toThrow();
    expect(() => validateInput({}, 42, 'any')).not.toThrow();
    expect(() => validateInput({}, null, 'any')).not.toThrow();
  });

  it('supports custom format registration (e.g., positive-integer)', () => {
    // Register a custom format on a fresh ajv instance — the shared instance
    // is module-level so we register here and it persists across this test.
    // (We can't isolate without a more invasive API; just verify registration works.)
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addFormat('positive-integer', {
      type: 'number',
      validate: (x: number) => Number.isInteger(x) && x > 0,
    });

    const validate = ajv.compile({
      type: 'object',
      required: ['n'],
      properties: { n: { type: 'number', format: 'positive-integer' } },
    });

    expect(validate({ n: 5 })).toBe(true);
    expect(validate({ n: 0 })).toBe(false);
    expect(validate({ n: -1 })).toBe(false);
    expect(validate({ n: 1.5 })).toBe(false);
  });

  it('validates nullable fields (type includes null)', () => {
    const nullableSchema = {
      type: ['string', 'null'],
    } as const;

    expect(() => validateInput(nullableSchema, 'hello', 'opt')).not.toThrow();
    expect(() => validateInput(nullableSchema, null, 'opt')).not.toThrow();

    try {
      validateInput(nullableSchema, 42, 'opt');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });

  it('validates union types via oneOf', () => {
    const unionSchema = {
      oneOf: [
        { type: 'object', required: ['kind'], properties: { kind: { const: 'a' }, a: { type: 'string' } } },
        { type: 'object', required: ['kind'], properties: { kind: { const: 'b' }, b: { type: 'number' } } },
      ],
    } as const;

    expect(() =>
      validateInput(unionSchema, { kind: 'a', a: 'hi' }, 'union'),
    ).not.toThrow();
    expect(() =>
      validateInput(unionSchema, { kind: 'b', b: 7 }, 'union'),
    ).not.toThrow();

    // Not matching either branch — kind: 'c' not declared
    try {
      validateInput(unionSchema, { kind: 'c' }, 'union');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
    }
  });
});

describe('withSchema decorator helper', () => {
  it('wraps a method and validates its single-object argument', () => {
    const schema = {
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'number' } },
    } as const;

    class Holder {
      value = 0;
      // Method decorator shape
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set(_x: { x: number }): any {
        return undefined;
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      Holder.prototype as object,
      'set',
    ) as PropertyDescriptor;
    if (!descriptor) throw new Error('descriptor missing');

    const wrapped = withSchema(schema)(
      Holder.prototype as object,
      'set',
      descriptor,
    );
    Object.defineProperty(Holder.prototype, 'set', wrapped);

    const h = new Holder();
    expect(() => h.set({ x: 5 })).not.toThrow();
    expect(() => (h.set as unknown as (i: unknown) => void)({ x: 'oops' })).toThrow(
      ValidationError,
    );
  });

  it('skips validation when argument is not a single object', () => {
    const schema = {
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'number' } },
    } as const;

    const original = function sum(a: number, b: number): number {
      return a + b;
    };
    const descriptor: PropertyDescriptor = {
      value: original,
      writable: true,
      enumerable: false,
      configurable: true,
    };

    const wrapped = withSchema(schema)({}, 'sum', descriptor);
    const fn = wrapped.value as (...a: unknown[]) => unknown;
    // Two positional args — should NOT trigger validation
    expect(fn.call({}, 1, 2)).toBe(3);
  });
});