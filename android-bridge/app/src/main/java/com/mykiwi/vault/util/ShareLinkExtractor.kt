package com.mykiwi.vault.util

import android.net.Uri
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

data class ResolvedShopeeLink(
    val affiliateUrl: String,
    val targetUrl: String,
    val shopId: String?,
    val itemId: String?
)

object ShareLinkExtractor {
    private val URL_REGEX = Regex("""https?://[^\s<>"')\]}]+""", RegexOption.IGNORE_CASE)
    private val PRODUCT_PATH_REGEX = Regex("""/product/(\d+)/(\d+)""", RegexOption.IGNORE_CASE)
    private val OPAANLP_PATH_REGEX = Regex("""/opaanlp/(\d+)/(\d+)""", RegexOption.IGNORE_CASE)
    private val SLUG_IDS_REGEX = Regex("""(?:-i|/i)\.(\d+)\.(\d+)(?:$|[/?#])""", RegexOption.IGNORE_CASE)

    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"

    fun extractFirstUrl(rawShareText: String?): String? {
        if (rawShareText.isNullOrBlank()) return null
        val match = URL_REGEX.find(rawShareText) ?: return null
        return match.value.trimEnd('.', ',', ';', '!', '?')
    }

    fun extractShopeeIds(urlStr: String?, depth: Int = 0): Triple<String, String, String>? {
        if (urlStr.isNullOrBlank() || depth > 3) return null

        val uri = try {
            Uri.parse(urlStr)
        } catch (_: Exception) {
            return null
        }

        // 1. Check nested redirect query parameters (ulp, url, redirect, target, dl_target_url)
        for (param in listOf("ulp", "url", "redirect", "target", "dl_target_url", "path")) {
            val nested = try {
                uri.getQueryParameter(param)
            } catch (_: Exception) {
                null
            }
            if (!nested.isNullOrBlank()) {
                val decoded = try {
                    URLDecoder.decode(nested, "UTF-8")
                } catch (_: Exception) {
                    nested
                }
                val nestedIds = extractShopeeIds(decoded, depth + 1)
                if (nestedIds != null) return nestedIds
            }
        }

        val host = (uri.host ?: "").lowercase()
        val domain = normalizeShopeeDomain(host)
        val path = uri.path ?: urlStr

        PRODUCT_PATH_REGEX.find(path)?.let { m ->
            return Triple(m.groupValues[1], m.groupValues[2], domain)
        }

        OPAANLP_PATH_REGEX.find(path)?.let { m ->
            return Triple(m.groupValues[1], m.groupValues[2], domain)
        }

        SLUG_IDS_REGEX.find(path)?.let { m ->
            return Triple(m.groupValues[1], m.groupValues[2], domain)
        }

        val shopParam = try {
            uri.getQueryParameter("shop_id") ?: uri.getQueryParameter("shopid")
        } catch (_: Exception) {
            null
        }
        val itemParam = try {
            uri.getQueryParameter("item_id") ?: uri.getQueryParameter("itemid")
        } catch (_: Exception) {
            null
        }

        if (!shopParam.isNullOrBlank() && !itemParam.isNullOrBlank() &&
            shopParam.all { it.isDigit() } && itemParam.all { it.isDigit() }
        ) {
            return Triple(shopParam, itemParam, domain)
        }

        return null
    }

    fun isShortShopeeUrl(urlStr: String): Boolean {
        val host = try {
            Uri.parse(urlStr).host?.lowercase() ?: ""
        } catch (_: Exception) {
            ""
        }
        return host.startsWith("s.shopee.") || host.endsWith("shp.ee") || host.endsWith("shope.ee")
    }

    private fun normalizeShopeeDomain(host: String): String {
        val match = Regex("""shopee\.[a-z.]+$""").find(host)
        return match?.value ?: "shopee.co.id"
    }

    /**
     * Ikuti redirect link pendek affiliate (s.shopee.co.id / shp.ee) maksimal 5 hop secara manual
     * tanpa melempar intent ke aplikasi Shopee. Begitu shop_id & item_id ditemukan, langsung
     * kembalikan URL web bersih: https://shopee.co.id/product/{shopId}/{itemId}
     */
    fun resolveToCleanTarget(originalUrl: String): ResolvedShopeeLink {
        extractShopeeIds(originalUrl)?.let { (shopId, itemId, domain) ->
            return ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = "https://$domain/product/$shopId/$itemId",
                shopId = shopId,
                itemId = itemId
            )
        }

        if (!isShortShopeeUrl(originalUrl)) {
            return ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = originalUrl,
                shopId = null,
                itemId = null
            )
        }

        var currentUrl = originalUrl
        for (hop in 0 until 5) {
            if (!currentUrl.startsWith("http://", ignoreCase = true) &&
                !currentUrl.startsWith("https://", ignoreCase = true)
            ) {
                break
            }

            var conn: HttpURLConnection? = null
            try {
                conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    requestMethod = "GET"
                    connectTimeout = 6000
                    readTimeout = 6000
                    setRequestProperty("User-Agent", DESKTOP_UA)
                    setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*")
                }
                val code = conn.responseCode
                val location = conn.getHeaderField("Location")

                if (code in 300..399 && !location.isNullOrBlank()) {
                    val resolvedNext = if (location.startsWith("/")) {
                        val base = URL(currentUrl)
                        "${base.protocol}://${base.host}$location"
                    } else {
                        location
                    }

                    extractShopeeIds(resolvedNext)?.let { (shopId, itemId, domain) ->
                        return ResolvedShopeeLink(
                            affiliateUrl = originalUrl,
                            targetUrl = "https://$domain/product/$shopId/$itemId",
                            shopId = shopId,
                            itemId = itemId
                        )
                    }
                    currentUrl = resolvedNext
                } else {
                    break
                }
            } catch (_: Exception) {
                break
            } finally {
                conn?.disconnect()
            }
        }

        val finalIds = extractShopeeIds(currentUrl)
        return if (finalIds != null) {
            ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = "https://${finalIds.third}/product/${finalIds.first}/${finalIds.second}",
                shopId = finalIds.first,
                itemId = finalIds.second
            )
        } else {
            val safeTarget = if (currentUrl.startsWith("http", ignoreCase = true)) {
                currentUrl
            } else {
                originalUrl
            }
            ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = safeTarget,
                shopId = null,
                itemId = null
            )
        }
    }
}
