package com.mykiwi.vault.data

import android.content.Context
import com.mykiwi.vault.model.ProductRecord
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object RawJsonStorage {

    private fun rawDir(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        return File(base, "raw_products").apply { mkdirs() }
    }

    private fun exportDir(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        return File(base, "exports").apply { mkdirs() }
    }

    fun saveRawResponse(
        context: Context,
        platform: String,
        shopId: String?,
        itemId: String?,
        rawJson: String
    ): String {
        val safeKey = if (!shopId.isNullOrBlank() && !itemId.isNullOrBlank()) {
            "${platform}_${shopId}_${itemId}".replace(Regex("[^a-zA-Z0-9._-]"), "_")
        } else {
            "${platform}_${System.currentTimeMillis()}"
        }
        val file = File(rawDir(context), "$safeKey.json")
        file.writeText(rawJson, Charsets.UTF_8)
        return file.absolutePath
    }

    fun readRawResponse(path: String?): String? {
        if (path.isNullOrBlank()) return null
        val f = File(path)
        return if (f.exists() && f.isFile) {
            try {
                f.readText(Charsets.UTF_8)
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
    }

    fun deleteRawFile(path: String?) {
        if (path.isNullOrBlank()) return
        try {
            val f = File(path)
            if (f.exists()) f.delete()
        } catch (_: Exception) {
        }
    }

    fun buildCatalogJsonExport(context: Context, products: List<ProductRecord>): File {
        val root = JSONObject().apply {
            put("exportedAt", System.currentTimeMillis())
            put("app", "ShopVault (com.mykiwi.vault)")
            put("count", products.size)
            val arr = JSONArray()
            for (p in products) {
                arr.put(p.toJsonObject())
            }
            put("products", arr)
        }
        val out = File(exportDir(context), "shopvault_products_${System.currentTimeMillis()}.json")
        out.writeText(root.toString(2), Charsets.UTF_8)
        return out
    }

    fun buildCatalogCsvExport(context: Context, products: List<ProductRecord>): File {
        val sb = StringBuilder()
        sb.appendLine(
            "id,shop_id,item_id,title,price_min,price_max,original_price,discount_pct,stock,sold_count,rating_star,shop_name,affiliate_url,clean_url,video_url,cover_image_url"
        )
        for (p in products) {
            val row = listOf(
                p.id.toString(),
                p.shopId ?: "",
                p.itemId ?: "",
                p.title,
                p.priceMin?.toString() ?: "",
                p.priceMax?.toString() ?: "",
                p.originalPrice?.toString() ?: "",
                p.discountPercent?.toString() ?: "",
                p.stock?.toString() ?: "",
                p.soldCount?.toString() ?: "",
                p.ratingStar?.toString() ?: "",
                p.shopName ?: "",
                p.affiliateUrl ?: "",
                p.cleanUrl,
                p.videoUrl ?: "",
                p.coverImageUrl ?: ""
            ).joinToString(",") { csvEscape(it) }
            sb.appendLine(row)
        }
        val out = File(exportDir(context), "shopvault_products_${System.currentTimeMillis()}.csv")
        out.writeText(sb.toString(), Charsets.UTF_8)
        return out
    }

    private fun csvEscape(value: String): String {
        val cleaned = value.replace("\r\n", " ").replace("\n", " ")
        return if (cleaned.contains(',') || cleaned.contains('"')) {
            "\"${cleaned.replace("\"", "\"\"")}\""
        } else {
            cleaned
        }
    }
}
