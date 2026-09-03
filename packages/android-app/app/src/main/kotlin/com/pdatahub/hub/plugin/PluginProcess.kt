package com.pdatahub.hub.plugin

import com.pdatahub.hub.data.crypto.CryptoBox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.BufferedWriter
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject

/**
 * Wraps a single pdatahub plugin subprocess.
 *
 * Communicates with the plugin over JSON-RPC 2.0 via newline-delimited JSON
 * on stdin/stdout. Logs go to stderr (captured for Hub's logger).
 *
 * Lifecycle:
 *   1. spawn(nodePath, entryPath) — boots Node.js subprocess
 *   2. initialize() — sends handshake, captures manifest
 *   3. callTool(name, args, token) — forwards tool calls
 *   4. shutdown() — graceful exit
 *
 * One [PluginProcess] per installed plugin. Constructed by [PluginManager]
 * (not @Singleton — multiple instances needed).
 */
class PluginProcess @Inject constructor(
    private val cryptoBox: CryptoBox,
) {
    data class StartedProcess(
        val process: Process,
        val stdin: BufferedWriter,
        val stdout: InputStream,
        val stderr: InputStream,
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    @Volatile
    private var process: StartedProcess? = null

    @Volatile
    var manifest: PluginManifest? = null
        private set

    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, kotlin.coroutines.Continuation<JsonRpcResponse>>()

    private val _logLines = MutableSharedFlow<String>(extraBufferCapacity = 256)
    val logLines: SharedFlow<String> = _logLines.asSharedFlow()

    /**
     * Spawn the subprocess and run the handshake.
     *
     * @param nodePath absolute path to the node binary
     * @param entryPath absolute path to the plugin's index.js
     */
    suspend fun start(nodePath: String, entryPath: String, pluginName: String) = withContext(Dispatchers.IO) {
        check(process == null) { "Plugin $pluginName already started" }

        val pb = ProcessBuilder(nodePath, entryPath).redirectErrorStream(false)
        val proc = pb.start()
        val started = StartedProcess(
            process = proc,
            stdin = proc.outputStream.bufferedWriter(),
            stdout = proc.inputStream,
            stderr = proc.errorStream,
        )
        process = started

        startStdoutReader(started.stdout, pluginName)
        startStderrReader(started.stderr, pluginName)

        val initParams = kotlinx.serialization.json.buildJsonObject {
            put("hubVersion", "0.1.0")
        }
        val initResponse = sendRequest("initialize", initParams)
        manifest = json.decodeFromJsonElement(PluginManifest.serializer(), initResponse.result ?: JsonNull)
    }

    /**
     * Forward a tool call. Token is injected into the context so the plugin
     * SDK's HttpClient can attach it as Bearer.
     */
    suspend fun callTool(
        name: String,
        arguments: List<JsonElement>,
        accessToken: String?,
    ): JsonRpcResponse = sendRequest(
        method = "tools/call",
        params = kotlinx.serialization.json.buildJsonObject {
            put("name", name)
            put("arguments", kotlinx.serialization.json.JsonArray(arguments))
            if (accessToken != null) {
                put("context", kotlinx.serialization.json.buildJsonObject {
                    put("token", accessToken)
                })
            }
        },
    )

    /** Ask the plugin to shut down. Closes stdin and waits up to 2 seconds. */
    suspend fun shutdown() = withContext(Dispatchers.IO) {
        val started = process ?: return@withContext
        try {
            sendNotification("shutdown", null)
        } catch (_: Throwable) {
            // Plugin may already be dead
        }
        try {
            started.stdin.close()
        } catch (_: Throwable) {}
        try {
            started.process.waitFor(2, TimeUnit.SECONDS)
        } catch (_: Throwable) {}
        process = null
        manifest = null
        pending.clear()
    }

    fun isRunning(): Boolean = process?.process?.isAlive == true

    private suspend fun sendRequest(method: String, params: JsonElement?): JsonRpcResponse {
        val id = nextId.getAndIncrement()
        val req = JsonRpcRequest(id = id, method = method, params = params)
        return kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            pending[id] = cont
            cont.invokeOnCancellation { pending.remove(id) }
            writeFrame(req)
        }
    }

    private fun sendNotification(method: String, params: JsonElement?) {
        val req = JsonRpcRequest(id = null, method = method, params = params)
        writeFrame(req)
    }

    private fun writeFrame(req: JsonRpcRequest) {
        val started = process ?: error("plugin not started")
        val line = json.encodeToString(JsonRpcRequest.serializer(), req)
        synchronized(started.stdin) {
            started.stdin.write(line)
            started.stdin.newLine()
            started.stdin.flush()
        }
    }

    private fun startStdoutReader(stream: InputStream, pluginName: String) {
        Thread({
            stream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    if (line.isBlank()) return@forEach
                    try {
                        val resp = json.decodeFromString(JsonRpcResponse.serializer(), line)
                        val id = resp.id
                        if (id != null) {
                            pending.remove(id)?.resumeWith(Result.success(resp))
                        }
                    } catch (e: Throwable) {
                        _logLines.tryEmit("[$pluginName] stdout parse error: ${e.message}")
                    }
                }
            }
        }, "plugin-$pluginName-stdout").apply { isDaemon = true; start() }
    }

    private fun startStderrReader(stream: InputStream, pluginName: String) {
        Thread({
            stream.bufferedReader().useLines { lines ->
                lines.forEach { line -> _logLines.tryEmit("[$pluginName] $line") }
            }
        }, "plugin-$pluginName-stderr").apply { isDaemon = true; start() }
    }
}
