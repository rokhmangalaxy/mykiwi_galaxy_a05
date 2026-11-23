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
    private val USERNAME_SLUG_REGEX = Regex("""^[a-zA-Z0-9_.-]{2,64}$""")

    private val RESERVED_FIRST_SEGMENTS = setOf(
        "product", "universal-link", "opaanlp", "buyer", "verify", "api",
        "search", "cart", "checkout", "user", "m", "mall", "flash_sale",
        "campaigns", "daily_discover", "portal", "seller", "edu", "help",
        "legaldoc", "blog", "events", "an_redir"
    )

    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"

    fun extractFirstUrl(rawShareText: String?): String? {
        if (rawShareText.isNullOrBlank()) return null
        val match = URL_REGEX.find(rawShareText) ?: return null
        return match.value.trimEnd('.', ',', ';', '!', '?')
    }

    fun extractShopeeIds(urlStr: String?, depth: Int = 0): Triple<String, String, String>? {
        if (urlStr.isNullOrBlank() || depth > 4) return null

        val uri = try {
            Uri.parse(urlStr)
        } catch (_: Exception) {
            return null
        }

        for (param in listOf("origin_link", "ulp", "next", "url", "redirect", "target", "dl_target_url", "path")) {
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

    fun extractShopeeUsernameItem(urlStr: String?, depth: Int = 0): Triple<String, String, String>? {
        if (urlStr.isNullOrBlank() || depth > 4) return null

        val uri = try {
            Uri.parse(urlStr)
        } catch (_: Exception) {
            return null
        }

        for (param in listOf("origin_link", "ulp", "next", "url", "redirect", "target", "dl_target_url")) {
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
                val found = extractShopeeUsernameItem(decoded, depth + 1)
                if (found != null) return found
            }
        }

        val host = (uri.host ?: "").lowercase()
        if (!host.contains("shopee.") || isShortShopeeUrl(urlStr)) return null

        val rawPath = (uri.path ?: "").removePrefix("/universal-link")
        val segments = rawPath.split('/').filter { it.isNotBlank() }
        if (segments.size == 2) {
            val shopUsername = segments[0]
            val itemId = segments[1]
            if (shopUsername.lowercase() !in RESERVED_FIRST_SEGMENTS &&
                USERNAME_SLUG_REGEX.matches(shopUsername) &&
                itemId.length >= 6 &&
                itemId.all { it.isDigit() }
            ) {
                return Triple(shopUsername, itemId, normalizeShopeeDomain(host))
            }
        }
        return null
    }

    fun cleanShopeeLandingUrl(urlStr: String, depth: Int = 0): String {
        if (depth > 4) return urlStr

        extractShopeeIds(urlStr)?.let { (shopId, itemId, domain) ->
            return "https://$domain/product/$shopId/$itemId"
        }

        extractShopeeUsernameItem(urlStr)?.let { (shopUser, itemId, domain) ->
            return "https://$domain/$shopUser/$itemId"
        }

        val uri = try {
            Uri.parse(urlStr)
        } catch (_: Exception) {
            return urlStr
        }

        for (param in listOf("origin_link", "ulp", "dl_target_url")) {
            val nested = try {
                uri.getQueryParameter(param)
            } catch (_: Exception) {
                null
            }
            if (!nested.isNullOrBlank() && nested.startsWith("http", ignoreCase = true)) {
                return cleanShopeeLandingUrl(nested, depth + 1)
            }
        }

        val host = (uri.host ?: "").lowercase()
        val path = uri.path ?: ""
        if (host.contains("shopee.") && !isShortShopeeUrl(urlStr) &&
            path.startsWith("/universal-link/", ignoreCase = true)
        ) {
            val stripped = path.removePrefix("/universal-link").ifBlank { "/" }
            if (!stripped.startsWith("/buyer/login", ignoreCase = true)) {
                return "https://${normalizeShopeeDomain(host)}$stripped"
            }
        }

        return urlStr
    }

    fun isShortShopeeUrl(urlStr: String): Boolean {
        val host = try {
            Uri.parse(urlStr).host?.lowercase() ?: ""
        } catch (_: Exception) {
            ""
        }
        return host.startsWith("s.shopee.") ||
            host == "shp.ee" ||
            host.endsWith(".shp.ee") ||
            host == "shope.ee" ||
            host.endsWith(".shope.ee")
    }

    private fun normalizeShopeeDomain(host: String): String {
        val match = Regex("""shopee\.[a-z.]+$""").find(host)
        return match?.value ?: "shopee.co.id"
    }

    private fun extractDestinationFromShortenerHtml(html: String): String? {
        val unescaped = html
            .replace("\\u002F", "/", ignoreCase = true)
            .replace("\\/", "/")
            .replace("&amp;", "&")

        for (m in URL_REGEX.findAll(unescaped)) {
            val candidate = m.value.trimEnd('.', ',', ';', '!', '?', '"', '\'')
            val lower = candidate.lowercase()
            if (lower.contains("shopee.") &&
                !isShortShopeeUrl(candidate) &&
                !lower.contains("susercontent.com") &&
                !lower.contains("shopeemobile.com")
            ) {
                return candidate
            }
        }
        return null
    }

    /**
     * Resolusi shortlink affiliate (s.shopee.co.id / id.shp.ee / shp.ee) maksimal 5 hop.
     * PENTING: Hanya lakukan HTTP hop pada domain shortlink! Begitu mendapatkan URL tujuan
     * di domain utama shopee.co.id, HENTIKAN HttpURLConnection (karena Android app tidak memegang
     * cookie login Shopee dan request tanpa cookie ke shopee.co.id akan dilempar ke /buyer/login).
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

        extractShopeeUsernameItem(originalUrl)?.let { (shopUser, itemId, domain) ->
            return ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = "https://$domain/$shopUser/$itemId",
                shopId = null,
                itemId = itemId
            )
        }

        if (!isShortShopeeUrl(originalUrl)) {
            return ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = cleanShopeeLandingUrl(originalUrl),
                shopId = null,
                itemId = null
            )
        }

        var currentUrl = originalUrl
        for (hop in 0 until 5) {
            if (!isShortShopeeUrl(currentUrl)) {
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
                    setRequestProperty(
                        "Sec-CH-UA",
                        "\"Not A(Brand\";v=\"8\", \"Chromium\";v=\"132\", \"Google Chrome\";v=\"132\""
                    )
                    setRequestProperty("Sec-CH-UA-Mobile", "?0")
                    setRequestProperty("Sec-CH-UA-Platform", "\"Windows\"")
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

                    extractShopeeUsernameItem(resolvedNext)?.let { (shopUser, itemId, domain) ->
                        return ResolvedShopeeLink(
                            affiliateUrl = originalUrl,
                            targetUrl = "https://$domain/$shopUser/$itemId",
                            shopId = null,
                            itemId = itemId
                        )
                    }

                    currentUrl = resolvedNext
                    if (!isShortShopeeUrl(currentUrl)) {
                        break
                    }
                } else if (code == 200) {
                    val snippet = conn.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                        val buf = CharArray(16384)
                        val n = reader.read(buf)
                        if (n > 0) String(buf, 0, n) else ""
                    }
                    val htmlDest = extractDestinationFromShortenerHtml(snippet)
                    if (!htmlDest.isNullOrBlank()) {
                        currentUrl = htmlDest
                    }
                    break
                } else {
                    break
                }
            } catch (_: Exception) {
                break
            } finally {
                conn?.disconnect()
            }
        }

        extractShopeeIds(currentUrl)?.let { (shopId, itemId, domain) ->
            return ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = "https://$domain/product/$shopId/$itemId",
                shopId = shopId,
                itemId = itemId
            )
        }

        extractShopeeUsernameItem(currentUrl)?.let { (shopUser, itemId, domain) ->
            return ResolvedShopeeLink(
                affiliateUrl = originalUrl,
                targetUrl = "https://$domain/$shopUser/$itemId",
                shopId = null,
                itemId = itemId
            )
        }

        val cleanedCurrent = cleanShopeeLandingUrl(currentUrl)
        val lowerCurrent = cleanedCurrent.lowercase()
        val isLoginOrVerifyTrap = lowerCurrent.contains("/buyer/login") ||
            lowerCurrent.contains("/buyer/signin") ||
            lowerCurrent.contains("/verify/")

        val safeTarget = if (cleanedCurrent.startsWith("http", ignoreCase = true) && !isLoginOrVerifyTrap) {
            cleanedCurrent
        } else {
            originalUrl
        }

        return ResolvedShopeeLink(
            affiliateUrl = originalUrl,
            targetUrl = safeTarget,
            shopId = null,
            itemId = null
        )
    }
}
