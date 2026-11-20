package com.mykiwi.vault.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import com.mykiwi.vault.data.VaultDatabase
import com.mykiwi.vault.service.VaultBridgeService
import com.mykiwi.vault.util.ShareLinkExtractor

/**
 * Activity transparan yang menerima Intent.ACTION_SEND dari tombol Share Shopee / aplikasi lain.
 * Menyimpan link affiliate ke SQLite dalam < 30ms lalu langsung finish() tanpa memindahkan layar!
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

        VaultBridgeService.startOrWake(applicationContext, VaultBridgeService.ACTION_WAKE_QUEUE)

        val suffix = if (VaultBridgeService.isKiwiConnected) {
            "diproses di latar belakang"
        } else {
            "masuk antrean (menunggu Kiwi Dev)"
        }
        Toast.makeText(
            applicationContext,
            "📥 Simpan Produk: $suffix",
            Toast.LENGTH_SHORT
        ).show()
    }
}
