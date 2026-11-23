package com.mykiwi.vault.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import com.mykiwi.vault.data.VaultDatabase
import com.mykiwi.vault.service.VaultBridgeService
import com.mykiwi.vault.util.KiwiLauncher
import com.mykiwi.vault.util.ShareLinkExtractor

/**
 * Activity transparan yang menerima Intent.ACTION_SEND dari tombol Share Shopee / aplikasi lain.
 * Menyimpan link affiliate ke antrean SQLite lalu langsung membangunkan Kiwi Browser Dev
 * agar segera mengambil Raw JSON dan auto-close tab produk!
 */
class ShareReceiverActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overridePendingTransition(0, 0)

        handleShareIntent(intent)

        finish()
        overridePendingTransition(0, 0)
    }

    private fun handleShareIntent(incoming: Intent?) {
        if (incoming?.action != Intent.ACTION_SEND) return

        val sharedText = incoming.getStringExtra(Intent.EXTRA_TEXT)
            ?: incoming.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()

        val extractedUrl = ShareLinkExtractor.extractFirstUrl(sharedText)
        if (extractedUrl.isNullOrBlank()) {
            Toast.makeText(
                applicationContext,
                "Tidak ditemukan link produk pada teks yang dibagikan",
                Toast.LENGTH_SHORT
            ).show()
            return
        }

        val db = VaultDatabase.getInstance(applicationContext)
        db.enqueueShare(
            rawShareText = sharedText ?: extractedUrl,
            affiliateUrl = extractedUrl
        )

        // 1. Bangunkan service jembatan untuk resolve shortlink & kirim sinyal WebSocket
        VaultBridgeService.startOrWake(applicationContext, VaultBridgeService.ACTION_WAKE_QUEUE)

        // 2. Langsung buka Kiwi Browser Dev agar tidak dibekukan di background oleh Android
        val launched = KiwiLauncher.launchKiwiForCapture(this)

        val msg = if (launched) {
            "⚡ Mengambil Raw JSON di Kiwi Dev (auto-close setelah dapat)..."
        } else {
            "📥 Masuk antrean (pasang Kiwi Browser Dev untuk mengambil JSON)"
        }
        Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
    }
}
