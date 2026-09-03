package com.pdatahub.hub.plugin

import android.content.Context
import com.pdatahub.hub.data.crypto.CryptoBox
import com.pdatahub.hub.data.db.PluginDao
import com.pdatahub.hub.data.db.PluginEntity
import com.pdatahub.hub.data.identity.IdentityManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton

/**
 * Registry of installed plugin subprocesses.
 *
 * Reads installed plugins from [PluginDao], starts each as a Node.js subprocess
 * on [refreshInstalled], and aggregates their manifests for the MCP server.
 *
 * Lifecycle:
 *   - App boot: caller invokes [refreshInstalled] (or HubApplication.onCreate
 *     does it)
 *   - Plugin install: [refreshInstalled] picks up the new entry
 *   - Plugin remove: [refreshInstalled] removes it from the registry
 */
@Singleton
class PluginManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val identity: IdentityManager,
    private val cryptoBox: CryptoBox,
    private val pluginDao: PluginDao,
    private val processProvider: Provider<PluginProcess>,
) {
    private val _running = MutableStateFlow<Map<String, PluginProcess>>(emptyMap())
    val running: StateFlow<Map<String, PluginProcess>> = _running.asStateFlow()

    private val _manifests = MutableStateFlow<Map<String, PluginManifest>>(emptyMap())
    val manifests: StateFlow<Map<String, PluginManifest>> = _manifests.asStateFlow()

    /**
     * Re-read installed plugins from DB and restart subprocesses.
     *
     * Shuts down plugins no longer in DB, starts new ones, keeps running the
     * ones that are still installed (their manifest is preserved).
     */
    suspend fun refreshInstalled() {
        val installed = pluginDao.listEnabled()
        val desiredNames = installed.map { it.name }.toSet()
        val current = _running.value

        val newRunning = mutableMapOf<String, PluginProcess>()
        val newManifests = mutableMapOf<String, PluginManifest>()

        // Keep running plugins that are still installed
        for ((name, proc) in current) {
            if (name in desiredNames) {
                newRunning[name] = proc
                proc.manifest?.let { newManifests[name] = it }
            } else {
                proc.shutdown()
            }
        }

        // Start plugins that aren't running yet
        val nodePath = resolveNodePath() ?: run {
            android.util.Log.w("PluginManager", "node binary not found; cannot start plugins")
            _running.value = newRunning
            _manifests.value = newManifests
            return
        }
        for (plugin in installed.filter { it.name !in current }) {
            try {
                val proc = processProvider.get()
                proc.start(nodePath = nodePath, entryPath = plugin.entryPath, pluginName = plugin.name)
                newRunning[plugin.name] = proc
                proc.manifest?.let { newManifests[plugin.name] = it }
            } catch (e: Throwable) {
                android.util.Log.e("PluginManager", "failed to start ${plugin.name}: ${e.message}", e)
            }
        }
        _running.value = newRunning
        _manifests.value = newManifests
    }

    /**
     * Back-compat signature for manual startup with explicit plugin list.
     * Prefer [refreshInstalled] which reads from DB.
     */
    @Suppress("unused")
    suspend fun startAll(nodePath: String, installed: List<PluginEntity>) {
        // Implementation kept for API compat; new code should call refreshInstalled().
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
