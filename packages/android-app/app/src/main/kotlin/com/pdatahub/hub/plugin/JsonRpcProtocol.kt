package com.pdatahub.hub.plugin

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * JSON-RPC 2.0 protocol shared with TypeScript plugin-sdk.
 *
 * Wire format: one JSON object per line, newline-terminated. stdout is the
 * protocol channel; stderr is for logs. See plugin-sdk/src/types.ts for the
 * matching TypeScript definitions.
 */

@Serializable
data class JsonRpcRequest(
    val jsonrpc: String = "2.0",
    val id: Long? = null,
    val method: String,
    val params: JsonElement? = null,
)

@Serializable
data class JsonRpcResponse(
    val jsonrpc: String = "2.0",
    val id: Long? = null,
    val result: JsonElement? = null,
    val error: JsonRpcError? = null,
)

@Serializable
data class JsonRpcError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null,
)

@Serializable
data class InitializeParams(
    val hubVersion: String,
)

@Serializable
data class PluginManifest(
    val name: String,
    val version: String,
    val description: String? = null,
    val tools: List<PluginTool>,
)

@Serializable
data class PluginTool(
    val name: String,
    val description: String,
    val inputSchema: JsonElement,
    val scope: String,
)

@Serializable
data class ToolCallParams(
    val name: String,
    val arguments: List<JsonElement> = emptyList(),
    val context: JsonElement? = null,
)

@Serializable
data class ToolCallResult(
    val data: JsonElement? = null,
)
