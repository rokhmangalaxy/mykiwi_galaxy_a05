package com.mykiwi.vault.service

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
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.mykiwi.vault.R
import com.mykiwi.vault.data.VaultDatabase
import com.mykiwi.vault.server.LocalBridgeServer
import com.mykiwi.vault.ui.MainActivity
import com.mykiwi.vault.util.ShareLinkExtractor
import java.util.concurrent.Executors

class VaultBridgeService : Service() {

    private lateinit var db: VaultDatabase
    private var server: LocalBridgeServer? = null
    private val resolverExecutor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        db = VaultDatabase.getInstance(this)
        ensureNotificationChannels()
        startForegroundSafely(buildStatusNotification("Siaga menerima Share produk..."))

        server = LocalBridgeServer(
            appContext = applicationContext,
            port = LocalBridgeServer.DEFAULT_PORT,
            onEventCallback = { eventType, detail ->
                handleBridgeEvent(eventType, detail)
            }
        ).also { it.start() }

        resolvePendingLinksAsync()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafely(buildCurrentNotification())

        when (intent?.action) {
            ACTION_WAKE_QUEUE -> {
                resolvePendingLinksAsync()
            }
            ACTION_RETRY_ATTENTION -> {
                resolverExecutor.execute {
                    db.retryAttentionJobs()
                    server?.broadcastWake(forceResume = true)
                    refreshNotificationAndUi()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        isKiwiConnected = false
        resolverExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun resolvePendingLinksAsync() {
        resolverExecutor.execute {
            val pending = db.listResolvingJobs()
            for (job in pending) {
                val resolved = ShareLinkExtractor.resolveToCleanTarget(job.affiliateUrl)
                db.markQueueResolved(
                    queueId = job.id,
                    targetUrl = resolved.targetUrl,
                    shopId = resolved.shopId,
                    itemId = resolved.itemId
                )
            }
            server?.broadcastWake()
            refreshNotificationAndUi()
        }
    }

    private fun handleBridgeEvent(eventType: String, detail: String?) {
        isKiwiConnected = (server?.connectedClientCount() ?: 0) > 0

        if (eventType == "ENQUEUE_REQUESTED") {
            resolvePendingLinksAsync()
            return
        }

        if (eventType.startsWith("JOB_FAILED:")) {
            val status = eventType.removePrefix("JOB_FAILED:")
            if (status == VaultDatabase.STATUS_NEED_LOGIN ||
                status == VaultDatabase.STATUS_CAPTCHA ||
                status == VaultDatabase.STATUS_RATE_LIMITED
            ) {
                postAttentionNotification(detail ?: "Perlu cek sesi Shopee di Kiwi Browser Dev")
            }
        }

        refreshNotificationAndUi()
    }

    private fun refreshNotificationAndUi() {
        isKiwiConnected = (server?.connectedClientCount() ?: 0) > 0
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID_SERVICE, buildCurrentNotification())

        sendBroadcast(
            Intent(ACTION_VAULT_UPDATED).apply {
                setPackage(packageName)
            }
        )
    }

    private fun buildCurrentNotification(): Notification {
        val stats = db.getStats()
        val connText = if (isKiwiConnected) "Kiwi Terhubung" else "Menunggu Kiwi Dev"
        val summary = when {
            stats.processingCount > 0 -> "$connText • Memproses produk..."
            stats.queuedCount > 0 -> "$connText • Antrean: ${stats.queuedCount}"
            else -> "$connText • Tersimpan: ${stats.totalProducts} produk"
        }
        return buildStatusNotification(summary)
    }

    private fun buildStatusNotification(contentText: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher_vault)
            .setContentTitle("ShopVault Aktif")
            .setContentText(contentText)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun postAttentionNotification(reason: String) {
        val openKiwiIntent = packageManager.getLaunchIntentForPackage("com.kiwibrowser.browser.dev")
            ?: Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this,
            2,
            openKiwiIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher_vault)
            .setContentTitle("ShopVault: Perlu Cek Kiwi Dev")
            .setContentText(reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID_ALERT, notif)
    }

    private fun startForegroundSafely(notification: Notification) {
        val fgType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIF_ID_SERVICE, notification, fgType)
    }

    private fun ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val serviceChannel = NotificationChannel(
                CHANNEL_SERVICE,
                "ShopVault Background Bridge",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Menjaga jembatan penyimpanan produk dengan Kiwi Browser Dev"
                setShowBadge(false)
            }
            val alertChannel = NotificationChannel(
                CHANNEL_ALERTS,
                "ShopVault Peringatan Login/Captcha",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Pemberitahuan jika sesi Shopee di Kiwi Dev perlu dicek"
            }
            nm.createNotificationChannel(serviceChannel)
            nm.createNotificationChannel(alertChannel)
        }
    }

    companion object {
        const val ACTION_WAKE_QUEUE = "com.mykiwi.vault.ACTION_WAKE_QUEUE"
        const val ACTION_RETRY_ATTENTION = "com.mykiwi.vault.ACTION_RETRY_ATTENTION"
        const val ACTION_VAULT_UPDATED = "com.mykiwi.vault.ACTION_VAULT_UPDATED"

        private const val CHANNEL_SERVICE = "shopvault_bridge_channel"
        private const val CHANNEL_ALERTS = "shopvault_alert_channel"
        private const val NOTIF_ID_SERVICE = 1001
        private const val NOTIF_ID_ALERT = 1002

        @Volatile
        var isKiwiConnected: Boolean = false
            private set

        fun startOrWake(context: Context, action: String = ACTION_WAKE_QUEUE) {
            val intent = Intent(context, VaultBridgeService::class.java).apply {
                this.action = action
            }
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
