package com.mykiwi.vault.data

import android.content.Context
import com.mykiwi.vault.model.ProductRecord
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

object RawJsonStorage {

    private fun rawDir(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        return File(base, "raw_products").apply { mkdirs() }
    }

    private fun exportDir(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        return File(base, "exports").apply { mkdirs() }
    }

    /**
     * Simpan string Raw JSON asli dari Shopee 100% apa adanya (tanpa di-parse / di-edit sedikitpun).
     */
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
        file.writeBytes(rawJson.toByteArray(Charsets.UTF_8))
        return file.absolutePath
    }

    fun readRawResponseBytes(path: String?): ByteArray? {
        if (path.isNullOrBlank()) return null
        val f = File(path)
        return if (f.exists() && f.isFile) {
            try {
                f.readBytes()
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
    }

    fun readRawResponse(path: String?): String? {
        val bytes = readRawResponseBytes(path) ?: return null
        return String(bytes, Charsets.UTF_8)
    }

    fun deleteRawFile(path: String?) {
        if (path.isNullOrBlank()) return
        try {
            val f = File(path)
            if (f.exists()) f.delete()
        } catch (_: Exception) {
        }
    }

    /**
     * Bundel seluruh file Raw JSON asli apa adanya (byte-for-byte tanpa modifikasi) ke dalam .zip
     */
    fun buildRawJsonZipExport(context: Context, products: List<ProductRecord>): File {
        val out = File(exportDir(context), "shopvault_raw_json_${System.currentTimeMillis()}.zip")
        val usedNames = HashSet<String>()

        ZipOutputStream(BufferedOutputStream(FileOutputStream(out))).use { zos ->
            for (p in products) {
                val rawBytes = readRawResponseBytes(p.rawJsonPath) ?: continue
                val baseName = if (!p.shopId.isNullOrBlank() && !p.itemId.isNullOrBlank()) {
                    "${p.sourcePlatform}_${p.shopId}_${p.itemId}.json"
                } else {
                    "product_${p.id}.json"
                }.replace(Regex("[^a-zA-Z0-9._-]"), "_")

                val entryName = if (usedNames.add(baseName)) {
                    baseName
                } else {
                    "id${p.id}_$baseName".also { usedNames.add(it) }
                }

                zos.putNextEntry(ZipEntry(entryName))
                zos.write(rawBytes)
                zos.closeEntry()
            }
        }
        return out
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
