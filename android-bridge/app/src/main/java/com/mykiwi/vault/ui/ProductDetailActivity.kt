package com.mykiwi.vault.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.button.MaterialButton
import com.mykiwi.vault.R
import com.mykiwi.vault.data.VaultDatabase
import com.mykiwi.vault.model.ProductRecord
import org.json.JSONArray
import java.io.File
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.Executors

class ProductDetailActivity : AppCompatActivity() {

    private lateinit var db: VaultDatabase
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val idrFormat = NumberFormat.getNumberInstance(Locale("id", "ID"))

    private var currentProduct: ProductRecord? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_product_detail)

        db = VaultDatabase.getInstance(this)
        val productId = intent.getLongExtra(EXTRA_PRODUCT_ID, -1L)
        if (productId <= 0L) {
            finish()
            return
        }

        findViewById<MaterialButton>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<MaterialButton>(R.id.btnDeleteProduct).setOnClickListener {
            confirmDelete(productId)
        }

        loadProduct(productId)
    }

    override fun onDestroy() {
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun loadProduct(productId: Long) {
        ioExecutor.execute {
            val product = db.getProductById(productId)
            runOnUiThread {
                if (product == null) {
                    finish()
                    return@runOnUiThread
                }
                currentProduct = product
                bindProduct(product)
            }
        }
    }

    private fun bindProduct(p: ProductRecord) {
        val tvShop = findViewById<TextView>(R.id.tvDetailShop)
        val tvTitle = findViewById<TextView>(R.id.tvDetailTitle)
        val tvPrice = findViewById<TextView>(R.id.tvDetailPrice)
        val tvStats = findViewById<TextView>(R.id.tvDetailStats)
        val tvLinks = findViewById<TextView>(R.id.tvDetailLinks)
        val tvVariantsAndReviews = findViewById<TextView>(R.id.tvDetailVariantsAndReviews)
        val tvDescription = findViewById<TextView>(R.id.tvDetailDescription)

        val btnCopyAffiliate = findViewById<MaterialButton>(R.id.btnDetailCopyAffiliate)
        val btnShareJson = findViewById<MaterialButton>(R.id.btnDetailShareJson)
        val btnCopyVideo = findViewById<MaterialButton>(R.id.btnDetailCopyVideo)
        val btnCopyImages = findViewById<MaterialButton>(R.id.btnDetailCopyImages)

        tvShop.text = buildString {
            append(p.shopName ?: p.sourcePlatform.uppercase())
            if (p.isOfficialShop) append(" ✓ Official Mall")
            if (!p.shopLocation.isNullOrBlank()) append(" • ${p.shopLocation}")
        }

        tvTitle.text = p.title

        val priceStr = when {
            p.priceMin != null && p.priceMax != null && p.priceMax > p.priceMin ->
                "Rp ${idrFormat.format(p.priceMin)} - Rp ${idrFormat.format(p.priceMax)}"
            p.priceMin != null ->
                "Rp ${idrFormat.format(p.priceMin)}"
            else -> "Harga tidak tersedia"
        }
        val discountSuffix = p.discountPercent?.takeIf { it > 0 }?.let { " (-$it%)" } ?: ""
        tvPrice.text = priceStr + discountSuffix

        val statsParts = mutableListOf<String>()
        p.ratingStar?.let { statsParts.add("⭐ $it (${p.ratingCount ?: 0} ulasan)") }
        p.soldCount?.let { statsParts.add("Terjual ${idrFormat.format(it)}") }
        p.stock?.let { statsParts.add("Stok $it") }
        tvStats.text = statsParts.joinToString(" • ")

        val images = p.imageList()
        tvLinks.text = buildString {
            appendLine("🔗 Link Affiliate Asli:")
            appendLine(p.affiliateUrl ?: "(tidak ada, memakai clean URL)")
            appendLine()
            appendLine("🌐 Clean Product URL:")
            appendLine(p.cleanUrl)
            appendLine()
            appendLine("🆔 Shop ID: ${p.shopId ?: "-"}  |  Item ID: ${p.itemId ?: "-"}")
            appendLine("🎬 Video MP4: ${p.videoUrl ?: "Tidak ada video produk"}")
            appendLine("🖼️ Jumlah Foto HD: ${images.size} file")
            append("📁 File Raw JSON: ${p.rawJsonPath ?: "-"}")
        }

        tvVariantsAndReviews.text = buildVariantsAndReviewsSummary(p)
        tvDescription.text = "📝 Deskripsi Produk:\n\n" + (p.description.ifBlank { "(Kosong)" })

        btnCopyAffiliate.setOnClickListener {
            copyText("Link Affiliate", p.affiliateUrl ?: p.cleanUrl)
        }

        btnCopyVideo.isEnabled = !p.videoUrl.isNullOrBlank()
        btnCopyVideo.setOnClickListener {
            p.videoUrl?.let { copyText("URL Video MP4", it) }
        }

        btnCopyImages.isEnabled = images.isNotEmpty()
        btnCopyImages.setOnClickListener {
            copyText("Daftar URL Foto HD", images.joinToString("\n"))
        }

        btnShareJson.setOnClickListener {
            shareProductJson(p)
        }
    }

    private fun buildVariantsAndReviewsSummary(p: ProductRecord): String {
        val sb = StringBuilder()
        sb.appendLine("📦 Daftar Varian SKU:")
        try {
            val vars = JSONArray(p.variantsJson)
            if (vars.length() == 0) {
                sb.appendLine("• Produk tunggal (tanpa varian)")
            } else {
                for (i in 0 until vars.length()) {
                    val v = vars.optJSONObject(i) ?: continue
                    val name = v.optString("name", "-")
                    val price = if (v.isNull("price")) null else v.optLong("price")
                    val stock = if (v.isNull("stock")) null else v.optInt("stock")
                    val priceTxt = price?.let { "Rp ${idrFormat.format(it)}" } ?: "-"
                    val stockTxt = stock?.let { "stok $it" } ?: if (v.optBoolean("inStock", true)) "tersedia" else "habis"
                    sb.appendLine("• $name — $priceTxt ($stockTxt)")
                }
            }
        } catch (_: Exception) {
            sb.appendLine("• -")
        }

        sb.appendLine()
        sb.appendLine("💬 Top Review Pembeli (Bahan Hook Konten):")
        try {
            val revs = JSONArray(p.reviewsJson)
            if (revs.length() == 0) {
                sb.appendLine("• Belum ada ulasan tersadap")
            } else {
                for (i in 0 until minOf(revs.length(), 5)) {
                    val r = revs.optJSONObject(i) ?: continue
                    val star = r.optInt("rating", 5)
                    val comment = r.optString("comment", "").trim()
                    if (comment.isNotEmpty()) {
                        sb.appendLine("• [$star★] $comment")
                    }
                }
            }
        } catch (_: Exception) {
            sb.appendLine("• -")
        }
        return sb.toString().trimEnd()
    }

    private fun shareProductJson(p: ProductRecord) {
        ioExecutor.execute {
            val rawFile = p.rawJsonPath?.let { File(it) }?.takeIf { it.exists() }
            val fileToShare = if (rawFile != null) {
                rawFile
            } else {
                val fallback = File(cacheDir, "product_${p.id}.json")
                fallback.writeText(p.toJsonObject().toString(2), Charsets.UTF_8)
                fallback
            }
            runOnUiThread {
                val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", fileToShare)
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "application/json"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, p.title)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(intent, "Kirim JSON Produk ke..."))
            }
        }
    }

    private fun confirmDelete(productId: Long) {
        AlertDialog.Builder(this)
            .setTitle("Hapus Produk?")
            .setMessage("Data produk dan file JSON mentahnya akan dihapus dari penyimpanan lokal.")
            .setPositiveButton("Hapus") { _, _ ->
                ioExecutor.execute {
                    db.deleteProduct(this, productId)
                    runOnUiThread {
                        Toast.makeText(this, "Produk dihapus", Toast.LENGTH_SHORT).show()
                        finish()
                    }
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun copyText(label: String, value: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, "✅ $label disalin", Toast.LENGTH_SHORT).show()
    }

    companion object {
        const val EXTRA_PRODUCT_ID = "extra_product_id"
    }
}
