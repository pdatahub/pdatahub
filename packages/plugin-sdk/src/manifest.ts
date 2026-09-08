/**
 * Builds the PluginManifest returned to the Hub on `initialize`.
 *
 * Reads metadata from @Tool and @OAuth decorators attached to the plugin
 * class via decorators.ts, plus v2 lifecycle hooks from the class itself.
 */
import { getOAuthForClass, getToolsForClass } from './decorators.js';
import type {
  PluginCapability,
  PluginManifest,
  ProtocolVersion,
  ToolDefinition,
} from './types.js';

/** Default protocol version for plugins that don't opt in to v2. */
const DEFAULT_PROTOCOL_VERSION: ProtocolVersion = 1;

/**
 * Build the manifest from decorator metadata on the plugin instance.
 *
 * The plugin instance is needed because we read `name` and `version` from
 * instance fields (these are typically instance properties on the subclass).
 *
 * @param pluginInstance  Live instance of the plugin class
 * @param description     Optional human-readable description (overrides any
 *                         instance-level description field if provided)
 */
export function buildManifest(
  pluginInstance: object,
  description?: string,
): PluginManifest {
  const klass = (pluginInstance as { constructor: object }).constructor;
  const tools = getToolsForClass(klass);
  const oauth = getOAuthForClass(klass);

  const toolDefs: ToolDefinition[] = tools.map(({ method, options }) => ({
    name: method,
    scope: options.scope,
    description: options.description,
    ...(options.inputSchema !== undefined ? { inputSchema: options.inputSchema } : {}),
  }));

  // Read name/version/description/protocolVersion from instance fields.
  // Plugin subclasses set these as instance properties. We use type
  // narrowing via `unknown` then check for string — required because we
  // don't have a guaranteed base-class shape across all plugin implementations.
  const name = readStringField(pluginInstance, 'name');
  const version = readStringField(pluginInstance, 'version');
  const descField = readStringField(pluginInstance, 'description');
  const protocolVersion = readProtocolVersion(pluginInstance);

  if (!name) {
    throw new Error('Plugin instance must set `name` string field');
  }
  if (!version) {
    throw new Error('Plugin instance must set `version` string field');
  }

  const capabilities = deriveCapabilities(pluginInstance, tools);

  const manifest: PluginManifest = {
    name,
    version,
    description: description ?? descField,
    protocolVersion,
    tools: toolDefs,
  };

  if (oauth) {
    manifest.oauth = oauth;
  }

  // Only attach capabilities when non-empty — keeps v1 manifests minimal
  // and reduces Hub work for plugins that haven't opted in.
  if (capabilities.length > 0) {
    manifest.capabilities = capabilities;
  }

  return manifest;
}

/**
 * Read the instance-level `protocolVersion` field. Defaults to 1
 * (v0.1.x compat) when missing or not a valid literal.
 */
function readProtocolVersion(obj: object): ProtocolVersion {
  const value = (obj as Record<string, unknown>)['protocolVersion'];
  if (value === 1 || value === 2) return value;
  return DEFAULT_PROTOCOL_VERSION;
}

/**
 * Determine which v2 capabilities the plugin uses, by introspecting:
 *   - whether any @Tool has an `inputSchema` → 'schema-validation'
 *   - whether the subclass overrides any lifecycle method → 'lifecycle-hooks'
 *   - whether `protocolVersion === 2` enables the others
 *
 * `typed-errors` is added when protocolVersion is 2 because v2 plugins
 * are expected to throw PluginError subclasses; we can't introspect
 * thrown values statically.
 *
 * Returns an empty array for v1 plugins so `manifest.capabilities` is
 * omitted entirely (see buildManifest).
 */
function deriveCapabilities(
  pluginInstance: object,
  tools: readonly { options: { inputSchema?: Record<string, unknown> } }[],
): PluginCapability[] {
  const result: PluginCapability[] = [];
  const protocolVersion = readProtocolVersion(pluginInstance);

  if (protocolVersion === 2) {
    result.push('typed-errors');
  }

  if (tools.some((t) => t.options.inputSchema !== undefined)) {
    result.push('schema-validation');
  }

  if (hasOverriddenLifecycleMethod(pluginInstance)) {
    result.push('lifecycle-hooks');
    result.push('health-check');
  }

  return result;
}

/**
 * Detect whether any of the v2 lifecycle methods (onInstall/onUninstall/
 * onActivate/onDeactivate/health) was overridden by the plugin subclass.
 *
 * We check each method's owner via the prototype chain. If the method
 * resolved via `pluginInstance` is defined on a prototype further down
 * the chain than the immediate prototype, the subclass overrode it.
 * Methods defined directly on `Plugin.prototype` are the base no-ops.
 */
function hasOverriddenLifecycleMethod(pluginInstance: object): boolean {
  const immediateProto = Object.getPrototypeOf(pluginInstance);
  if (immediateProto === null || immediateProto === Object.prototype) return false;

  // Find Plugin.prototype by walking up — it's the class that defines the
  // base no-ops. We compare against THAT, not the immediate prototype,
  // because an override on `MyPlugin` resolves to `MyPlugin.prototype.X`
  // (the immediate proto), which would falsely equal `instance.X`.
  let baseProto: object | null = immediateProto;
  while (baseProto !== null && baseProto !== Object.prototype) {
    const ctorName = (baseProto as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName === 'Plugin') break;
    baseProto = Object.getPrototypeOf(baseProto);
  }
  if (baseProto === null || baseProto === Object.prototype) return false;

  for (const name of [
    'onInstall',
    'onUninstall',
    'onActivate',
    'onDeactivate',
    'health',
  ]) {
    const onInstance = (pluginInstance as Record<string, unknown>)[name];
    if (typeof onInstance !== 'function') continue;
    const onBase = (baseProto as Record<string, unknown>)[name];
    if (onInstance !== onBase) return true;
  }
  return false;
}

function readStringField(obj: object, key: string): string | undefined {
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}