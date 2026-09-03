package com.pdatahub.hub.mcp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.pdatahub.hub.MainActivity
import com.pdatahub.hub.R
import com.pdatahub.hub.pairing.PairingManager
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Foreground service hosting the local MCP HTTP server.
 *
 * Started when user taps "Start MCP server" in the UI. Runs until user stops
 * it explicitly or the OS kills it under memory pressure (notification keeps
 * us in foreground service type DATA_SYNC).
 *
 * On API 26+ the service must run in foreground with a notification — this is
 * why it can't be a plain IntentService.
 */
@AndroidEntryPoint
class McpServerService : Service() {

    @Inject lateinit var httpServer: McpHttpServer
    @Inject lateinit var pairingManager: PairingManager

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundWithNotification("starting…")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startServer()
            }
            ACTION_STOP -> {
                stopServer()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startServer() {
        val sessionToken = when (val s = pairingManager.state.value) {
            is PairingManager.PairingState.AwaitingLaptop -> s.sessionToken
            is PairingManager.PairingState.Active -> s.sessionToken
            else -> pairingManager.startPairing().sessionToken
        }
        httpServer.setSessionToken(sessionToken)
        val port = httpServer.start(McpHttpServer.DEFAULT_PORT)
        startForegroundWithNotification("http://0.0.0.0:$port")
    }

    private fun stopServer() {
        httpServer.stop()
    }

    private fun startForegroundWithNotification(text: String) {
        val channelId = ensureNotificationChannel()
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle(getString(R.string.notification_mcp_title))
            .setContentText(getString(R.string.notification_mcp_text, text))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(tapIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureNotificationChannel(): String {
        val channelId = "pdatahub_mcp"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val existing = mgr.getNotificationChannel(channelId)
            if (existing == null) {
                val channel = NotificationChannel(
                    channelId,
                    getString(R.string.notification_mcp_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = getString(R.string.notification_mcp_channel_description)
                    setShowBadge(false)
                }
                mgr.createNotificationChannel(channel)
            }
        }
        return channelId
    }

    companion object {
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.pdatahub.hub.mcp.START"
        const val ACTION_STOP = "com.pdatahub.hub.mcp.STOP"
    }
}
