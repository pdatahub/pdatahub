package com.pdatahub.hub.mcp

import com.pdatahub.hub.data.crypto.CryptoBox
import com.pdatahub.hub.data.db.TokenDao
import com.pdatahub.hub.plugin.PluginManager
import com.pdatahub.hub.plugin.lookupTool
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.receiveNullable
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Local HTTP server exposing the Hub API to laptop MCP clients.
 *
 * Routes (mirror packages/mcp-server/src/types.ts and packages/plugin-sdk):
 *   GET  /v1/tools                  → aggregate manifest across plugins
 *   POST /v1/tools/{name}/call      → forward to plugin subprocess
 *   GET  /v1/health                 → liveness
 *
 * Auth: Bearer token (session_token from PairingManager). Until pairing is
 * implemented, the token is generated on app start and stored in CryptoBox.
 */
@Singleton
class McpHttpServer @Inject constructor(
    private val pluginManager: PluginManager,
    private val tokenDao: TokenDao,
    private val cryptoBox: CryptoBox,
) {
    @Volatile
    private var server: io.ktor.server.engine.ApplicationEngine? = null

    @Volatile
    private var actualPort: Int = 0

    @Volatile
    private var sessionToken: String = ""

    fun setSessionToken(token: String) {
        sessionToken = token
    }

    fun start(port: Int = DEFAULT_PORT): Int {
        if (server != null) return actualPort
        val s = embeddedServer(Netty, port = port, host = "0.0.0.0") {
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true; explicitNulls = false }) }
            install(CallLogging)
            install(StatusPages) {
                exception<Throwable> { call, cause ->
                    call.respondText("internal error: ${cause.message}", status = HttpStatusCode.InternalServerError)
                }
            }
            routing {
                get("/v1/health") {
                    call.respond(mapOf("status" to "ok", "service" to "pdatahub-hub"))
                }
                get("/v1/tools") {
                    if (!authenticated(call)) {
                        call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "unauthorized"))
                        return@get
                    }
                    val tools = pluginManager.manifests.value.values.flatMap { manifest ->
                        manifest.tools.map { tool ->
                            ToolDescriptor(
                                name = tool.name,
                                description = tool.description,
                                inputSchema = tool.inputSchema,
                                scope = tool.scope,
                                plugin = manifest.name,
                            )
                        }
                    }
                    call.respond(ListToolsResponse(tools = tools))
                }
                post("/v1/tools/{name}/call") {
                    if (!authenticated(call)) {
                        call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "unauthorized"))
                        return@post
                    }
                    val toolName = call.parameters["name"] ?: run {
                        call.respond(HttpStatusCode.BadRequest, mapOf("error" to "missing tool name"))
                        return@post
                    }
                    val request = try {
                        call.receiveNullable<CallToolRequest>()
                    } catch (e: Throwable) {
                        call.respond(HttpStatusCode.BadRequest, mapOf("error" to "invalid body: ${e.message}"))
                        return@post
                    }
                    val args = request?.arguments?.map { it as JsonElement } ?: emptyList()
                    val lookup = pluginManager.lookupTool(toolName)
                    if (lookup == null) {
                        call.respond(HttpStatusCode.NotFound, mapOf("error" to "tool not found: $toolName"))
                        return@post
                    }
                    try {
                        val accessToken = runBlocking { resolveAccessToken(lookup.pluginName, lookup.tool.scope) }
                        val resp = runBlocking {
                            lookup!!.process.callTool(toolName, args, accessToken = accessToken)
                        }
                        if (resp.error != null) {
                            call.respond(
                                HttpStatusCode(500, resp.error.message),
                                mapOf("error" to resp.error.message),
                            )
                        } else {
                            call.respond(CallToolResponse(content = resp.result ?: JsonNull))
                        }
                    } catch (e: Throwable) {
                        call.respond(HttpStatusCode.InternalServerError, mapOf("error" to e.message))
                    }
                }
            }
        }
        s.start(wait = false)
        server = s
        actualPort = port
        return port
    }

    fun stop() {
        server?.stop(500, 1500)
        server = null
    }

    private fun authenticated(call: ApplicationCall): Boolean {
        if (sessionToken.isEmpty()) return false
        val auth = call.request.headers["Authorization"] ?: return false
        return auth == "Bearer $sessionToken"
    }

    /**
     * Resolve the OAuth access token for a given plugin + scope, decrypting it
     * via CryptoBox. Returns null when no token is stored (plugin runs without
     * auth, or the user hasn't completed OAuth yet).
     */
    private suspend fun resolveAccessToken(pluginName: String, scope: String): String? {
        val key = "${pluginName}:${scope}"
        val entity = tokenDao.get(key) ?: return null
        return cryptoBox.decrypt(entity.accessTokenCiphertext, entity.aad)
            ?.toString(Charsets.UTF_8)
    }

    companion object {
        const val DEFAULT_PORT = 8080
    }
}

@Serializable
data class ToolDescriptor(
    val name: String,
    val description: String,
    val inputSchema: JsonElement,
    val scope: String,
    val plugin: String,
)

@Serializable
data class ListToolsResponse(val tools: List<ToolDescriptor>)

@Serializable
data class CallToolRequest(val arguments: List<JsonElement> = emptyList())

@Serializable
data class CallToolResponse(val content: JsonElement)

/** Alias for Ktor ApplicationCall to avoid extra import in the helper. */
private typealias ApplicationCall = io.ktor.server.application.ApplicationCall
