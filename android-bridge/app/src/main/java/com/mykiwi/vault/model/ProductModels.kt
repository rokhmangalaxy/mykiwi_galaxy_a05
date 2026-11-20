package com.mykiwi.vault.model

import org.json.JSONArray
import org.json.JSONObject

data class ProductRecord(
    val id: Long = 0L,
    val canonicalKey: String,
    val sourcePlatform: String,
    val shopId: String?,
    val itemId: String?,
    val affiliateUrl: String?,
    val cleanUrl: String,
    val title: String,
    val brand: String?,
    val description: String,
    val currency: String,
    val priceMin: Long?,
    val priceMax: Long?,
    val originalPrice: Long?,
    val voucherPrice: Long?,
    val discountPercent: Int?,
    val stock: Int?,
    val soldCount: Int?,
    val ratingStar: Double?,
    val ratingCount: Int?,
    val shopName: String?,
    val shopLocation: String?,
    val isOfficialShop: Boolean,
    val videoUrl: String?,
    val videoCoverUrl: String?,
    val videoDurationSec: Int?,
    val coverImageUrl: String?,
    val imagesJson: String,
    val tiersJson: String,
    val variantsJson: String,
    val reviewsJson: String,
    val rawJsonPath: String?,
    val createdAt: Long,
    val updatedAt: Long
) {
    fun imageList(): List<String> {
        return try {
            val arr = JSONArray(imagesJson)
            buildList {
                for (i in 0 until arr.length()) {
                    val v = arr.optString(i)
                    if (v.isNotBlank()) add(v)
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun toJsonObject(): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("canonicalKey", canonicalKey)
            put("sourcePlatform", sourcePlatform)
            put("shopId", shopId ?: JSONObject.NULL)
            put("itemId", itemId ?: JSONObject.NULL)
            put("affiliateUrl", affiliateUrl ?: JSONObject.NULL)
            put("cleanUrl", cleanUrl)
            put("title", title)
            put("brand", brand ?: JSONObject.NULL)
            put("description", description)
            put("currency", currency)
            put("priceMin", priceMin ?: JSONObject.NULL)
            put("priceMax", priceMax ?: JSONObject.NULL)
            put("originalPrice", originalPrice ?: JSONObject.NULL)
            put("voucherPrice", voucherPrice ?: JSONObject.NULL)
            put("discountPercent", discountPercent ?: JSONObject.NULL)
            put("stock", stock ?: JSONObject.NULL)
            put("soldCount", soldCount ?: JSONObject.NULL)
            put("ratingStar", ratingStar ?: JSONObject.NULL)
            put("ratingCount", ratingCount ?: JSONObject.NULL)
            put("shopName", shopName ?: JSONObject.NULL)
            put("shopLocation", shopLocation ?: JSONObject.NULL)
            put("isOfficialShop", isOfficialShop)
            put("videoUrl", videoUrl ?: JSONObject.NULL)
            put("videoCoverUrl", videoCoverUrl ?: JSONObject.NULL)
            put("videoDurationSec", videoDurationSec ?: JSONObject.NULL)
            put("coverImageUrl", coverImageUrl ?: JSONObject.NULL)
            put("images", safeJsonArray(imagesJson))
            put("tiers", safeJsonArray(tiersJson))
            put("variants", safeJsonArray(variantsJson))
            put("topReviews", safeJsonArray(reviewsJson))
            put("rawJsonPath", rawJsonPath ?: JSONObject.NULL)
            put("createdAt", createdAt)
            put("updatedAt", updatedAt)
        }
    }

    companion object {
        private fun safeJsonArray(raw: String): JSONArray {
            return try {
                JSONArray(raw)
            } catch (_: Exception) {
                JSONArray()
            }
        }

        private fun JSONObject.optNullableString(key: String): String? {
            if (isNull(key)) return null
            val v = optString(key, "").trim()
            return v.ifEmpty { null }
        }

        private fun JSONObject.optNullableLong(key: String): Long? {
            if (isNull(key) || !has(key)) return null
            val raw = opt(key)
            return when (raw) {
                is Number -> raw.toLong()
                is String -> raw.toLongOrNull()
                else -> null
            }
        }

        private fun JSONObject.optNullableInt(key: String): Int? {
            return optNullableLong(key)?.toInt()
        }

        private fun JSONObject.optNullableDouble(key: String): Double? {
            if (isNull(key) || !has(key)) return null
            val raw = opt(key)
            return when (raw) {
                is Number -> raw.toDouble()
                is String -> raw.toDoubleOrNull()
                else -> null
            }
        }

        fun fromExtensionJson(
            obj: JSONObject,
            fallbackAffiliateUrl: String?,
            rawJsonPath: String?,
            nowMs: Long = System.currentTimeMillis()
        ): ProductRecord {
            val cleanUrl = obj.optNullableString("cleanUrl")
                ?: fallbackAffiliateUrl
                ?: "https://shopee.co.id"
            val shopId = obj.optNullableString("shopId")
            val itemId = obj.optNullableString("itemId")
            val platform = obj.optNullableString("sourcePlatform") ?: "shopee"
            val canonicalKey = obj.optNullableString("canonicalKey")
                ?: if (!shopId.isNullOrBlank() && !itemId.isNullOrBlank()) {
                    "$platform:$shopId:$itemId"
                } else {
                    "url:$cleanUrl"
                }

            val imagesArr = obj.optJSONArray("images") ?: JSONArray()
            val tiersArr = obj.optJSONArray("tiers") ?: JSONArray()
            val variantsArr = obj.optJSONArray("variants") ?: JSONArray()
            val reviewsArr = obj.optJSONArray("topReviews") ?: JSONArray()

            return ProductRecord(
                canonicalKey = canonicalKey,
                sourcePlatform = platform,
                shopId = shopId,
                itemId = itemId,
                affiliateUrl = obj.optNullableString("affiliateUrl") ?: fallbackAffiliateUrl,
                cleanUrl = cleanUrl,
                title = obj.optNullableString("title") ?: cleanUrl,
                brand = obj.optNullableString("brand"),
                description = obj.optNullableString("description") ?: "",
                currency = obj.optNullableString("currency") ?: "IDR",
                priceMin = obj.optNullableLong("priceMin"),
                priceMax = obj.optNullableLong("priceMax"),
                originalPrice = obj.optNullableLong("originalPrice"),
                voucherPrice = obj.optNullableLong("voucherPrice"),
                discountPercent = obj.optNullableInt("discountPercent"),
                stock = obj.optNullableInt("stock"),
                soldCount = obj.optNullableInt("soldCount"),
                ratingStar = obj.optNullableDouble("ratingStar"),
                ratingCount = obj.optNullableInt("ratingCount"),
                shopName = obj.optNullableString("shopName"),
                shopLocation = obj.optNullableString("shopLocation"),
                isOfficialShop = obj.optBoolean("isOfficialShop", false),
                videoUrl = obj.optNullableString("videoUrl"),
                videoCoverUrl = obj.optNullableString("videoCoverUrl"),
                videoDurationSec = obj.optNullableInt("videoDurationSec"),
                coverImageUrl = obj.optNullableString("coverImageUrl")
                    ?: if (imagesArr.length() > 0) imagesArr.optString(0) else null,
                imagesJson = imagesArr.toString(),
                tiersJson = tiersArr.toString(),
                variantsJson = variantsArr.toString(),
                reviewsJson = reviewsArr.toString(),
                rawJsonPath = rawJsonPath,
                createdAt = nowMs,
                updatedAt = nowMs
            )
        }
    }
}

data class QueueJob(
    val id: Long,
    val rawShareText: String,
    val affiliateUrl: String,
    val targetUrl: String,
    val shopId: String?,
    val itemId: String?,
    val status: String,
    val errorReason: String?,
    val attempts: Int,
    val createdAt: Long,
    val updatedAt: Long
) {
    fun toJsonObject(): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("affiliateUrl", affiliateUrl)
            put("targetUrl", targetUrl)
            put("shopId", shopId ?: JSONObject.NULL)
            put("itemId", itemId ?: JSONObject.NULL)
            put("status", status)
            put("errorReason", errorReason ?: JSONObject.NULL)
            put("attempts", attempts)
            put("createdAt", createdAt)
        }
    }
}

data class QueueStats(
    val totalProducts: Int,
    val queuedCount: Int,
    val processingCount: Int,
    val attentionCount: Int,
    val lastAttentionReason: String?
)
