/**
 * @Tool and @OAuth decorators for pdatahub plugins.
 *
 * Uses TypeScript legacy decorator syntax (TC39 Stage 2) — chosen over the
 * newer Stage 3 decorators because the latter is not yet supported by esbuild
 * (the transformer used by vitest). Legacy syntax has the broadest tooling
 * compatibility today.
 *
 * Metadata is stored in module-level WeakMaps keyed by the class constructor.
 * Method decorators register via a side-effect inside the decorator function
 * itself (called once at class evaluation time).
 */
import type { OAuthConfig, ToolOptions } from './types.js';

interface ToolRegistration {
  /** Method name on the class (matches what callers will pass in tools/call). */
  method: string;
  /** The original options passed to @Tool. */
  options: ToolOptions;
}

/**
 * Internal: per-class registry of @Tool metadata.
 *
 * Keyed by the class constructor object. WeakMap so the registry doesn't keep
 * classes alive after they go out of use.
 */
const toolRegistry = new WeakMap<object, ToolRegistration[]>();

/**
 * Internal: per-class registry of @OAuth config.
 */
const oauthRegistry = new WeakMap<object, OAuthConfig>();

/**
 * Mark a method as a Tool exposed to AI-agents.
 *
 * The method name on the class becomes the tool name (e.g., `readMessages`).
 * Arguments to `tools/call` are passed positionally to the method.
 *
 * @example
 * ```typescript
 * @Tool({ scope: 'messages.read', description: 'Read Slack messages' })
 * async readMessages(channel: string) {
 *   const response = await this.http!.get('conversations.history', {
 *     params: { channel },
 *   });
 *   return response.data;
 * }
 * ```
 */
export function Tool(options: ToolOptions) {
  return function (
    target: object,
    propertyKey: string | symbol,
  ): void {
    const ctor = (target as { constructor: object }).constructor;
    const methodName = String(propertyKey);

    const existing = toolRegistry.get(ctor) ?? [];
    if (!existing.some((t) => t.method === methodName)) {
      existing.push({ method: methodName, options });
      toolRegistry.set(ctor, existing);
    }
  };
}

/**
 * Mark OAuth config on a plugin class.
 *
 * Provides authorization metadata to the Hub so it can run the OAuth dance.
 * Override `handleOAuthCallback` in the Plugin subclass for the actual token
 * exchange.
 *
 * @example
 * ```typescript
 * @OAuth({
 *   authorizationUrl: 'https://slack.com/oauth/authorize',
 *   tokenUrl: 'https://slack.com/api/oauth.token',
 *   scopes: ['channels:history', 'chat:write'],
 * })
 * class SlackPlugin extends Plugin { ... }
 * ```
 */
export function OAuth(config: OAuthConfig) {
  return function (target: object): void {
    oauthRegistry.set(target, config);
  };
}

/**
 * Internal: get all @Tool metadata registered against a class.
 *
 * Used by `manifest.ts` and tests. Returns an empty array if the class has
 * no @Tool decorators.
 */
export function getToolsForClass(klass: object): readonly ToolRegistration[] {
  return toolRegistry.get(klass) ?? [];
}

/**
 * Internal: get @OAuth config for a class, if any.
 *
 * Returns undefined if the class has no @OAuth decorator.
 */
export function getOAuthForClass(klass: object): OAuthConfig | undefined {
  return oauthRegistry.get(klass);
}