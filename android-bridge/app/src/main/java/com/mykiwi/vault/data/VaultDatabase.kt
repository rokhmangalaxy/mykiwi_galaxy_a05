package com.mykiwi.vault.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.mykiwi.vault.model.ProductRecord
import com.mykiwi.vault.model.QueueJob
import com.mykiwi.vault.model.QueueStats

class VaultDatabase private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                canonical_key TEXT NOT NULL UNIQUE,
                source_platform TEXT NOT NULL,
                shop_id TEXT,
                item_id TEXT,
                affiliate_url TEXT,
                clean_url TEXT NOT NULL,
                title TEXT NOT NULL,
                brand TEXT,
                description TEXT NOT NULL DEFAULT '',
                currency TEXT NOT NULL DEFAULT 'IDR',
                price_min INTEGER,
                price_max INTEGER,
                original_price INTEGER,
                voucher_price INTEGER,
                discount_percent INTEGER,
                stock INTEGER,
                sold_count INTEGER,
                rating_star REAL,
                rating_count INTEGER,
                shop_name TEXT,
                shop_location TEXT,
                is_official_shop INTEGER NOT NULL DEFAULT 0,
                video_url TEXT,
                video_cover_url TEXT,
                video_duration_sec INTEGER,
                cover_image_url TEXT,
                images_json TEXT NOT NULL DEFAULT '[]',
                tiers_json TEXT NOT NULL DEFAULT '[]',
                variants_json TEXT NOT NULL DEFAULT '[]',
                reviews_json TEXT NOT NULL DEFAULT '[]',
                raw_json_path TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX idx_products_updated ON products(updated_at DESC)")
        db.execSQL("CREATE INDEX idx_products_shop_item ON products(shop_id, item_id)")

        db.execSQL(
            """
            CREATE TABLE capture_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                raw_share_text TEXT NOT NULL,
                affiliate_url TEXT NOT NULL,
                target_url TEXT NOT NULL,
                shop_id TEXT,
                item_id TEXT,
                status TEXT NOT NULL,
                error_reason TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                product_id INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX idx_queue_status ON capture_queue(status, created_at ASC)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Schema v1
    }

    @Synchronized
    fun enqueueShare(
        rawShareText: String,
        affiliateUrl: String,
        initialTargetUrl: String = affiliateUrl,
        status: String = STATUS_RESOLVING
    ): Long {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put("raw_share_text", rawShareText)
            put("affiliate_url", affiliateUrl)
            put("target_url", initialTargetUrl)
            put("status", status)
            put("attempts", 0)
            put("created_at", now)
            put("updated_at", now)
        }
        return writableDatabase.insert("capture_queue", null, values)
    }

    @Synchronized
    fun markQueueResolved(
        queueId: Long,
        targetUrl: String,
        shopId: String?,
        itemId: String?
    ) {
        val values = ContentValues().apply {
            put("target_url", targetUrl)
            put("shop_id", shopId)
            put("item_id", itemId)
            put("status", STATUS_QUEUED)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update("capture_queue", values, "id = ?", arrayOf(queueId.toString()))
    }

    @Synchronized
    fun listResolvingJobs(): List<QueueJob> {
        val list = mutableListOf<QueueJob>()
        readableDatabase.rawQuery(
            "SELECT * FROM capture_queue WHERE status = ? ORDER BY created_at ASC",
            arrayOf(STATUS_RESOLVING)
        ).use { c ->
            while (c.moveToNext()) {
                list.add(readQueueJob(c))
            }
        }
        return list
    }

    /**
     * Ambil 1 job berikutnya untuk diproses oleh Ekstensi Kiwi Dev.
     * Juga otomatis me-recover job PROCESSING yang gantung > 60 detik.
     */
    @Synchronized
    fun claimNextQueuedJob(): QueueJob? {
        val db = writableDatabase
        val now = System.currentTimeMillis()
        val staleCutoff = now - 60_000L

        // Reset stale PROCESSING jobs back to QUEUED (max 3 attempts)
        val recoverValues = ContentValues().apply {
            put("status", STATUS_QUEUED)
            put("updated_at", now)
        }
        db.update(
            "capture_queue",
            recoverValues,
            "status = ? AND updated_at < ? AND attempts < 3",
            arrayOf(STATUS_PROCESSING, staleCutoff.toString())
        )

        var claimed: QueueJob? = null
        db.beginTransaction()
        try {
            db.rawQuery(
                "SELECT * FROM capture_queue WHERE status = ? ORDER BY created_at ASC LIMIT 1",
                arrayOf(STATUS_QUEUED)
            ).use { c ->
                if (c.moveToFirst()) {
                    val job = readQueueJob(c)
                    val upd = ContentValues().apply {
                        put("status", STATUS_PROCESSING)
                        put("attempts", job.attempts + 1)
                        put("updated_at", now)
                    }
                    db.update("capture_queue", upd, "id = ?", arrayOf(job.id.toString()))
                    claimed = job.copy(
                        status = STATUS_PROCESSING,
                        attempts = job.attempts + 1,
                        updatedAt = now
                    )
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return claimed
    }

    @Synchronized
    fun getQueueJobById(jobId: Long): QueueJob? {
        readableDatabase.rawQuery(
            "SELECT * FROM capture_queue WHERE id = ? LIMIT 1",
            arrayOf(jobId.toString())
        ).use { c ->
            return if (c.moveToFirst()) readQueueJob(c) else null
        }
    }

    @Synchronized
    fun completeQueueJob(jobId: Long, savedProductId: Long) {
        val values = ContentValues().apply {
            put("status", STATUS_COMPLETED)
            put("product_id", savedProductId)
            put("error_reason", null as String?)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update("capture_queue", values, "id = ?", arrayOf(jobId.toString()))
    }

    @Synchronized
    fun failQueueJob(jobId: Long, status: String, reason: String?) {
        val safeStatus = when (status) {
            STATUS_NEED_LOGIN, STATUS_CAPTCHA, STATUS_RATE_LIMITED, STATUS_FAILED -> status
            else -> STATUS_FAILED
        }
        val values = ContentValues().apply {
            put("status", safeStatus)
            put("error_reason", reason)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update("capture_queue", values, "id = ?", arrayOf(jobId.toString()))
    }

    @Synchronized
    fun retryAttentionJobs(): Int {
        val values = ContentValues().apply {
            put("status", STATUS_QUEUED)
            put("attempts", 0)
            put("error_reason", null as String?)
            put("updated_at", System.currentTimeMillis())
        }
        return writableDatabase.update(
            "capture_queue",
            values,
            "status IN (?, ?, ?, ?)",
            arrayOf(STATUS_NEED_LOGIN, STATUS_CAPTCHA, STATUS_RATE_LIMITED, STATUS_FAILED)
        )
    }

    @Synchronized
    fun upsertProduct(record: ProductRecord): Long {
        val db = writableDatabase
        val now = System.currentTimeMillis()

        var existingId: Long? = null
        var existingCreatedAt: Long = now
        var existingAffiliateUrl: String? = null

        db.rawQuery(
            "SELECT id, created_at, affiliate_url FROM products WHERE canonical_key = ? LIMIT 1",
            arrayOf(record.canonicalKey)
        ).use { c ->
            if (c.moveToFirst()) {
                existingId = c.getLong(0)
                existingCreatedAt = c.getLong(1)
                existingAffiliateUrl = if (c.isNull(2)) null else c.getString(2)
            }
        }

        val preservedAffiliate = if (!record.affiliateUrl.isNullOrBlank()) {
            record.affiliateUrl
        } else {
            existingAffiliateUrl
        }

        val values = ContentValues().apply {
            put("canonical_key", record.canonicalKey)
            put("source_platform", record.sourcePlatform)
            put("shop_id", record.shopId)
            put("item_id", record.itemId)
            put("affiliate_url", preservedAffiliate)
            put("clean_url", record.cleanUrl)
            put("title", record.title)
            put("brand", record.brand)
            put("description", record.description)
            put("currency", record.currency)
            putNullableLong("price_min", record.priceMin)
            putNullableLong("price_max", record.priceMax)
            putNullableLong("original_price", record.originalPrice)
            putNullableLong("voucher_price", record.voucherPrice)
            putNullableInt("discount_percent", record.discountPercent)
            putNullableInt("stock", record.stock)
            putNullableInt("sold_count", record.soldCount)
            if (record.ratingStar != null) put("rating_star", record.ratingStar) else putNull("rating_star")
            putNullableInt("rating_count", record.ratingCount)
            put("shop_name", record.shopName)
            put("shop_location", record.shopLocation)
            put("is_official_shop", if (record.isOfficialShop) 1 else 0)
            put("video_url", record.videoUrl)
            put("video_cover_url", record.videoCoverUrl)
            putNullableInt("video_duration_sec", record.videoDurationSec)
            put("cover_image_url", record.coverImageUrl)
            put("images_json", record.imagesJson)
            put("tiers_json", record.tiersJson)
            put("variants_json", record.variantsJson)
            put("reviews_json", record.reviewsJson)
            put("raw_json_path", record.rawJsonPath)
            put("created_at", existingCreatedAt)
            put("updated_at", now)
        }

        return if (existingId != null) {
            db.update("products", values, "id = ?", arrayOf(existingId.toString()))
            existingId!!
        } else {
            db.insertOrThrow("products", null, values)
        }
    }

    @Synchronized
    fun listProducts(searchQuery: String? = null, limit: Int = 500): List<ProductRecord> {
        val list = mutableListOf<ProductRecord>()
        val q = searchQuery?.trim() ?: ""
        val cursor = if (q.isEmpty()) {
            readableDatabase.rawQuery(
                "SELECT * FROM products ORDER BY updated_at DESC LIMIT ?",
                arrayOf(limit.toString())
            )
        } else {
            val like = "%$q%"
            readableDatabase.rawQuery(
                """
                SELECT * FROM products
                WHERE title LIKE ? OR shop_name LIKE ? OR item_id LIKE ? OR shop_id LIKE ?
                ORDER BY updated_at DESC LIMIT ?
                """.trimIndent(),
                arrayOf(like, like, like, like, limit.toString())
            )
        }
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(readProduct(c))
            }
        }
        return list
    }

    @Synchronized
    fun getProductById(productId: Long): ProductRecord? {
        readableDatabase.rawQuery(
            "SELECT * FROM products WHERE id = ? LIMIT 1",
            arrayOf(productId.toString())
        ).use { c ->
            return if (c.moveToFirst()) readProduct(c) else null
        }
    }

    @Synchronized
    fun deleteProduct(context: Context, productId: Long): Boolean {
        val existing = getProductById(productId) ?: return false
        RawJsonStorage.deleteRawFile(existing.rawJsonPath)
        val rows = writableDatabase.delete("products", "id = ?", arrayOf(productId.toString()))
        return rows > 0
    }

    @Synchronized
    fun getStats(): QueueStats {
        val db = readableDatabase
        val totalProducts = scalarInt(db, "SELECT COUNT(*) FROM products")
        val queuedCount = scalarInt(
            db,
            "SELECT COUNT(*) FROM capture_queue WHERE status IN (?, ?)",
            arrayOf(STATUS_RESOLVING, STATUS_QUEUED)
        )
        val processingCount = scalarInt(
            db,
            "SELECT COUNT(*) FROM capture_queue WHERE status = ?",
            arrayOf(STATUS_PROCESSING)
        )
        val attentionCount = scalarInt(
            db,
            "SELECT COUNT(*) FROM capture_queue WHERE status IN (?, ?, ?, ?)",
            arrayOf(STATUS_NEED_LOGIN, STATUS_CAPTCHA, STATUS_RATE_LIMITED, STATUS_FAILED)
        )
        var lastReason: String? = null
        if (attentionCount > 0) {
            db.rawQuery(
                """
                SELECT status, error_reason FROM capture_queue
                WHERE status IN (?, ?, ?, ?)
                ORDER BY updated_at DESC LIMIT 1
                """.trimIndent(),
                arrayOf(STATUS_NEED_LOGIN, STATUS_CAPTCHA, STATUS_RATE_LIMITED, STATUS_FAILED)
            ).use { c ->
                if (c.moveToFirst()) {
                    val st = c.getString(0)
                    val r = if (c.isNull(1)) null else c.getString(1)
                    lastReason = r ?: st
                }
            }
        }
        return QueueStats(
            totalProducts = totalProducts,
            queuedCount = queuedCount,
            processingCount = processingCount,
            attentionCount = attentionCount,
            lastAttentionReason = lastReason
        )
    }

    private fun scalarInt(db: SQLiteDatabase, sql: String, args: Array<String>? = null): Int {
        db.rawQuery(sql, args).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    private fun ContentValues.putNullableLong(key: String, value: Long?) {
        if (value != null) put(key, value) else putNull(key)
    }

    private fun ContentValues.putNullableInt(key: String, value: Int?) {
        if (value != null) put(key, value) else putNull(key)
    }

    private fun readQueueJob(c: Cursor): QueueJob {
        return QueueJob(
            id = c.getLong(c.getColumnIndexOrThrow("id")),
            rawShareText = c.getString(c.getColumnIndexOrThrow("raw_share_text")),
            affiliateUrl = c.getString(c.getColumnIndexOrThrow("affiliate_url")),
            targetUrl = c.getString(c.getColumnIndexOrThrow("target_url")),
            shopId = c.getNullableString("shop_id"),
            itemId = c.getNullableString("item_id"),
            status = c.getString(c.getColumnIndexOrThrow("status")),
            errorReason = c.getNullableString("error_reason"),
            attempts = c.getInt(c.getColumnIndexOrThrow("attempts")),
            createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
            updatedAt = c.getLong(c.getColumnIndexOrThrow("updated_at"))
        )
    }

    private fun readProduct(c: Cursor): ProductRecord {
        return ProductRecord(
            id = c.getLong(c.getColumnIndexOrThrow("id")),
            canonicalKey = c.getString(c.getColumnIndexOrThrow("canonical_key")),
            sourcePlatform = c.getString(c.getColumnIndexOrThrow("source_platform")),
            shopId = c.getNullableString("shop_id"),
            itemId = c.getNullableString("item_id"),
            affiliateUrl = c.getNullableString("affiliate_url"),
            cleanUrl = c.getString(c.getColumnIndexOrThrow("clean_url")),
            title = c.getString(c.getColumnIndexOrThrow("title")),
            brand = c.getNullableString("brand"),
            description = c.getString(c.getColumnIndexOrThrow("description")),
            currency = c.getString(c.getColumnIndexOrThrow("currency")),
            priceMin = c.getNullableLong("price_min"),
            priceMax = c.getNullableLong("price_max"),
            originalPrice = c.getNullableLong("original_price"),
            voucherPrice = c.getNullableLong("voucher_price"),
            discountPercent = c.getNullableInt("discount_percent"),
            stock = c.getNullableInt("stock"),
            soldCount = c.getNullableInt("sold_count"),
            ratingStar = c.getNullableDouble("rating_star"),
            ratingCount = c.getNullableInt("rating_count"),
            shopName = c.getNullableString("shop_name"),
            shopLocation = c.getNullableString("shop_location"),
            isOfficialShop = c.getInt(c.getColumnIndexOrThrow("is_official_shop")) == 1,
            videoUrl = c.getNullableString("video_url"),
            videoCoverUrl = c.getNullableString("video_cover_url"),
            videoDurationSec = c.getNullableInt("video_duration_sec"),
            coverImageUrl = c.getNullableString("cover_image_url"),
            imagesJson = c.getString(c.getColumnIndexOrThrow("images_json")),
            tiersJson = c.getString(c.getColumnIndexOrThrow("tiers_json")),
            variantsJson = c.getString(c.getColumnIndexOrThrow("variants_json")),
            reviewsJson = c.getString(c.getColumnIndexOrThrow("reviews_json")),
            rawJsonPath = c.getNullableString("raw_json_path"),
            createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
            updatedAt = c.getLong(c.getColumnIndexOrThrow("updated_at"))
        )
    }

    private fun Cursor.getNullableString(col: String): String? {
        val idx = getColumnIndexOrThrow(col)
        return if (isNull(idx)) null else getString(idx)
    }

    private fun Cursor.getNullableLong(col: String): Long? {
        val idx = getColumnIndexOrThrow(col)
        return if (isNull(idx)) null else getLong(idx)
    }

    private fun Cursor.getNullableInt(col: String): Int? {
        val idx = getColumnIndexOrThrow(col)
        return if (isNull(idx)) null else getInt(idx)
    }

    private fun Cursor.getNullableDouble(col: String): Double? {
        val idx = getColumnIndexOrThrow(col)
        return if (isNull(idx)) null else getDouble(idx)
    }

    companion object {
        private const val DB_NAME = "shopvault.db"
        private const val DB_VERSION = 1

        const val STATUS_RESOLVING = "RESOLVING"
        const val STATUS_QUEUED = "QUEUED"
        const val STATUS_PROCESSING = "PROCESSING"
        const val STATUS_COMPLETED = "COMPLETED"
        const val STATUS_NEED_LOGIN = "NEED_LOGIN"
        const val STATUS_CAPTCHA = "CAPTCHA"
        const val STATUS_RATE_LIMITED = "RATE_LIMITED"
        const val STATUS_FAILED = "FAILED"

        @Volatile
        private var INSTANCE: VaultDatabase? = null

        fun getInstance(context: Context): VaultDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: VaultDatabase(context).also { INSTANCE = it }
            }
        }
    }
}
