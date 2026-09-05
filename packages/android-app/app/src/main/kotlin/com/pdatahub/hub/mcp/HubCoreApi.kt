package com.pdatahub.hub.mcp

import com.pdatahub.hub.data.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

/**
 * HTTP client for hub-core REST API.
 *
 * Same base URL as the WebSocket client (SettingsRepository.hubCoreUrl), with
 * ws:// → http:// / wss:// → https:// substitution. Bearer token from
 * SettingsRepository.hubCoreAuthToken if set.
 *
 * Methods:
 *   - getGrants() → GET /v1/grants
 *   - revokeGrant(id) → POST /v1/grants/:id/revoke
 *   - getAuditHistory(limit) → GET /v1/audit?limit=N
 *
 * All methods run on Dispatchers.IO. Throws HttpException on non-2xx.
 */
@Singleton
class HubCoreApi @Inject constructor(
    private val settings: SettingsRepository,
    private val okHttpClient: OkHttpClient,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMediaType = "application/json".toMediaType()

    private fun baseUrl(): String = settings.hubCoreUrl
        .replace("ws://", "http://")
        .replace("wss://", "https://")
        .trimEnd('/')

    private fun authHeader(request: Request.Builder): Request.Builder {
        val token = settings.hubCoreAuthToken
        if (token.isNotEmpty()) {
            request.addHeader("Authorization", "Bearer $token")
        }
        return request
    }

    suspend fun getGrants(): List<Grant> = withContext(Dispatchers.IO) {
        val req = authHeader(
            Request.Builder().url("${baseUrl()}/v1/grants").get()
        ).build()
        okHttpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw HttpException(resp.code, "getGrants")
            val body = resp.body?.string().orEmpty()
            json.decodeFromString<GrantsResponse>(body).grants
        }
    }

    suspend fun revokeGrant(grantId: String): Boolean = withContext(Dispatchers.IO) {
        val req = authHeader(
            Request.Builder()
                .url("${baseUrl()}/v1/grants/$grantId/revoke")
                .post("".toRequestBody(jsonMediaType))
        ).build()
        okHttpClient.newCall(req).execute().use { resp ->
            resp.isSuccessful
        }
    }

    suspend fun getAuditHistory(limit: Int = 50): List<AuditEntry> = withContext(Dispatchers.IO) {
        val req = authHeader(
            Request.Builder()
                .url("${baseUrl()}/v1/audit?limit=$limit")
                .get()
        ).build()
        okHttpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw HttpException(resp.code, "getAuditHistory")
            val body = resp.body?.string().orEmpty()
            json.decodeFromString<AuditResponse>(body).entries
        }
    }
}

class HttpException(val code: Int, val op: String) : Exception("HTTP $code from $op")

@Serializable
data class Grant(
    val grant_id: String,
    val tool_name: String,
    val plugin: String,
    val scope: String,
    val agent_id: String,
    val user_id: String,
    val created_at: String,
    val expires_at: String,
    val revoked: Boolean,
)

@Serializable
data class GrantsResponse(val grants: List<Grant>)

@Serializable
data class AuditEntry(
    val id: String,
    val timestamp: String,
    val agent_id: String,
    val user_id: String,
    val tool_name: String,
    val plugin: String,
    val scope: String,
    val justification: String? = null,
    val decision: String,
    val grant_id: String? = null,
    val duration_ms: Int,
    val error: String? = null,
)

@Serializable
data class AuditResponse(val entries: List<AuditEntry>)
