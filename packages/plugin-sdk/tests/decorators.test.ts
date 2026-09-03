import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OAuth, getOAuthForClass, getToolsForClass, Tool } from '../src/decorators.js';

describe('@Tool decorator', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('registers a single tool against the class', () => {
    class SingleTool {
      name = 'single';
      version = '1.0.0';

      @Tool({ scope: 'thing.read', description: 'Read a thing' })
      async readThing() {
        return 'value';
      }
    }

    const tools = getToolsForClass(SingleTool);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.method).toBe('readThing');
    expect(tools[0]!.options.scope).toBe('thing.read');
    expect(tools[0]!.options.description).toBe('Read a thing');
  });

  it('registers multiple tools, preserving declaration order', () => {
    class MultiTool {
      name = 'multi';
      version = '1.0.0';

      @Tool({ scope: 'a', description: 'First' })
      async first() {
        return 1;
      }

      @Tool({ scope: 'b', description: 'Second' })
      async second() {
        return 2;
      }

      @Tool({ scope: 'c', description: 'Third' })
      async third() {
        return 3;
      }
    }

    const tools = getToolsForClass(MultiTool);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.method)).toEqual(['first', 'second', 'third']);
  });

  it('preserves the original method body', async () => {
    class Identity {
      name = 'id';
      version = '1.0.0';

      @Tool({ scope: 'echo', description: 'Echo' })
      async echo(input: string) {
        return input;
      }
    }

    const instance = new Identity();
    expect(await instance.echo('hi')).toBe('hi');
  });

  it('returns empty array for a class with no @Tool decorators', () => {
    expect(getToolsForClass({})).toEqual([]);
  });

  it('keeps separate registries for different classes', () => {
    class A {
      name = 'a';
      version = '1.0.0';
      @Tool({ scope: 'x', description: 'X' })
      async xMethod() {
        return 'a.x';
      }
    }
    class B {
      name = 'b';
      version = '1.0.0';
      @Tool({ scope: 'y', description: 'Y' })
      async yMethod() {
        return 'b.y';
      }
    }

    expect(getToolsForClass(A)).toHaveLength(1);
    expect(getToolsForClass(B)).toHaveLength(1);
    expect(getToolsForClass(A)[0]!.method).toBe('xMethod');
    expect(getToolsForClass(B)[0]!.method).toBe('yMethod');
  });
});

describe('@OAuth decorator', () => {
  it('registers OAuth config against the class', () => {
    @OAuth({
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read', 'write'],
    })
    class AuthPlugin {}

    const config = getOAuthForClass(AuthPlugin);
    expect(config?.authorizationUrl).toBe('https://example.com/auth');
    expect(config?.tokenUrl).toBe('https://example.com/token');
    expect(config?.scopes).toEqual(['read', 'write']);
  });

  it('returns undefined for a class with no @OAuth decorator', () => {
    class NoAuth {}
    expect(getOAuthForClass(NoAuth)).toBeUndefined();
  });

  it('preserves optional fields', () => {
    @OAuth({
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read'],
      tokenMethod: 'GET',
      extraTokenParams: { audience: 'foo' },
    })
    class CustomAuth {}

    const config = getOAuthForClass(CustomAuth);
    expect(config?.tokenMethod).toBe('GET');
    expect(config?.extraTokenParams).toEqual({ audience: 'foo' });
  });
});

describe('combined @Tool + @OAuth', () => {
  it('both metadata are independently retrievable', () => {
    @OAuth({
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read'],
    })
    class Combined {
      name = 'combined';
      version = '0.1.0';

      @Tool({ scope: 'data.read', description: 'Read data' })
      async read() {
        return null;
      }
    }

    expect(getOAuthForClass(Combined)?.tokenUrl).toBe('https://example.com/token');
    expect(getToolsForClass(Combined)).toHaveLength(1);
  });
});