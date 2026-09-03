package com.pdatahub.hub.plugin

import android.content.Context
import com.pdatahub.hub.data.crypto.CryptoBox
import com.pdatahub.hub.data.db.PluginEntity
import com.pdatahub.hub.data.identity.IdentityManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonElement
import java.io.File
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton

/**
 * Registry of installed plugin subprocesses.
 *
 * Reads installed plugins from the [com.pdatahub.hub.data.db.PluginDao]
 * (caller wires persistence in real impl), starts each as a subprocess on
 * app boot, and aggregates their manifests for the MCP server.
 *
 * For init: in-memory only. Persistence wiring is a follow-up.
 */
@Singleton
class PluginManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val identity: IdentityManager,
    private val cryptoBox: CryptoBox,
    private val processProvider: Provider<PluginProcess>,
) {
    private val _running = MutableStateFlow<Map<String, PluginProcess>>(emptyMap())
    val running: StateFlow<Map<String, PluginProcess>> = _running.asStateFlow()

    private val _manifests = MutableStateFlow<Map<String, PluginManifest>>(emptyMap())
    val manifests: StateFlow<Map<String, PluginManifest>> = _manifests.asStateFlow()

    /**
     * Start all enabled plugins.
     *
     * @param nodePath absolute path to `node` binary (Termux path on Android)
     * @param installed list of plugins to start
     */
    suspend fun startAll(nodePath: String, installed: List<PluginEntity>) {
        val started = mutableMapOf<String, PluginProcess>()
        val manifests = mutableMapOf<String, PluginManifest>()
        for (plugin in installed.filter { it.enabled }) {
            try {
                val proc = processProvider.get()
                proc.start(nodePath = nodePath, entryPath = plugin.entryPath, pluginName = plugin.name)
                started[plugin.name] = proc
                proc.manifest?.let { manifests[plugin.name] = it }
            } catch (e: Throwable) {
                android.util.Log.e("PluginManager", "failed to start ${plugin.name}: ${e.message}", e)
            }
        }
        _running.value = started
        _manifests.value = manifests
    }

    fun findProcessForTool(toolName: String): PluginProcess? {
        val map = _running.value
        return map.entries.firstOrNull { (_, proc) ->
            proc.manifest?.tools?.any { it.name == toolName } == true
        }?.value
    }

    fun shutdownAll() {
        kotlinx.coroutines.runBlocking {
            _running.value.values.forEach { it.shutdown() }
        }
        _running.value = emptyMap()
        _manifests.value = emptyMap()
    }

    /**
     * Locate the `node` binary on this device.
     *
     * On Android, the user installs Node via Termux at /data/data/com.termux/...
     * The UI can prompt the user to configure the path if not found.
     */
    fun resolveNodePath(): String? {
        val candidates = listOf(
            "/data/data/com.termux/files/usr/bin/node",
            "/system/bin/node",
            "/vendor/bin/node",
        )
        return candidates.firstOrNull { File(it).exists() && File(it).canExecute() }
    }

    fun identityPublicKey(): String = identity.publicKeyBase64()
}

/**
 * Find which plugin owns a given tool, plus the tool descriptor.
 */
data class ToolLookup(
    val pluginName: String,
    val process: PluginProcess,
    val tool: PluginTool,
)

fun PluginManager.lookupTool(name: String): ToolLookup? {
    val map = this.running.value
    for ((pluginName, proc) in map) {
        val tool = proc.manifest?.tools?.firstOrNull { it.name == name }
        if (tool != null) return ToolLookup(pluginName, proc, tool)
    }
    return null
}
