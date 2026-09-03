/**
 * Builds the PluginManifest returned to the Hub on `initialize`.
 *
 * Reads metadata from @Tool and @OAuth decorators attached to the plugin
 * class via decorators.ts.
 */
import { getOAuthForClass, getToolsForClass } from './decorators.js';
import type { PluginManifest, ToolDefinition } from './types.js';

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
  }));

  // Read name/version/description from instance fields. Plugin subclasses set
  // these as instance properties. We use type narrowing via `unknown` then
  // check for string — required because we don't have a guaranteed base-class
  // shape across all plugin implementations.
  const name = readStringField(pluginInstance, 'name');
  const version = readStringField(pluginInstance, 'version');
  const descField = readStringField(pluginInstance, 'description');

  if (!name) {
    throw new Error('Plugin instance must set `name` string field');
  }
  if (!version) {
    throw new Error('Plugin instance must set `version` string field');
  }

  const manifest: PluginManifest = {
    name,
    version,
    description: description ?? descField,
    tools: toolDefs,
  };

  if (oauth) {
    manifest.oauth = oauth;
  }

  return manifest;
}

function readStringField(obj: object, key: string): string | undefined {
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}