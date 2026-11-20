package com.mykiwi.vault.ui

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.button.MaterialButton
import com.mykiwi.vault.R
import com.mykiwi.vault.data.RawJsonStorage
import com.mykiwi.vault.data.VaultDatabase
import com.mykiwi.vault.service.VaultBridgeService
import com.mykiwi.vault.util.ShareLinkExtractor
import java.io.File
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var db: VaultDatabase
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private lateinit var tvKiwiStatus: TextView
    private lateinit var tvQueueSummary: TextView
    private lateinit var tvQueueAlert: TextView
    private lateinit var btnOpenKiwi: MaterialButton
    private lateinit var btnAddManual: MaterialButton
    private lateinit var btnExportAll: MaterialButton
    private lateinit var btnRetryFailed: MaterialButton
    private lateinit var etSearch: EditText
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var rvProducts: RecyclerView
    private lateinit var tvEmptyState: TextView
    private lateinit var adapter: ProductAdapter

    private val vaultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            refreshDashboard()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        db = VaultDatabase.getInstance(this)
        bindViews()
        requestNotificationPermissionIfNeeded()

        // Pastikan service jembatan selalu aktif saat aplikasi dibuka
        VaultBridgeService.startOrWake(this, VaultBridgeService.ACTION_WAKE_QUEUE)
    }

    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(
            this,
            vaultReceiver,
            IntentFilter(VaultBridgeService.ACTION_VAULT_UPDATED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        refreshDashboard()
    }

    override fun onStop() {
        try {
            unregisterReceiver(vaultReceiver)
        } catch (_: Exception) {
        }
        super.onStop()
    }

    override fun onDestroy() {
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun bindViews() {
        tvKiwiStatus = findViewById(R.id.tvKiwiStatus)
        tvQueueSummary = findViewById(R.id.tvQueueSummary)
        tvQueueAlert = findViewById(R.id.tvQueueAlert)
        btnOpenKiwi = findViewById(R.id.btnOpenKiwi)
        btnAddManual = findViewById(R.id.btnAddManual)
        btnExportAll = findViewById(R.id.btnExportAll)
        btnRetryFailed = findViewById(R.id.btnRetryFailed)
        etSearch = findViewById(R.id.etSearch)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        rvProducts = findViewById(R.id.rvProducts)
        tvEmptyState = findViewById(R.id.tvEmptyState)

        adapter = ProductAdapter(
            onItemClick = { product ->
                startActivity(
                    Intent(this, ProductDetailActivity::class.java).apply {
                        putExtra(ProductDetailActivity.EXTRA_PRODUCT_ID, product.id)
                    }
                )
            },
            onCopyAffiliateClick = { product ->
                val link = product.affiliateUrl ?: product.cleanUrl
                copyToClipboard("Link Affiliate", link)
            }
        )

        rvProducts.layoutManager = LinearLayoutManager(this)
        rvProducts.adapter = adapter

        swipeRefresh.setOnRefreshListener {
            VaultBridgeService.startOrWake(this, VaultBridgeService.ACTION_WAKE_QUEUE)
            refreshDashboard()
        }

        btnOpenKiwi.setOnClickListener {
            openKiwiBrowser()
        }

        btnAddManual.setOnClickListener {
            showManualAddDialog()
        }

        btnExportAll.setOnClickListener {
            showExportChooserDialog()
        }

        btnRetryFailed.setOnClickListener {
            VaultBridgeService.startOrWake(this, VaultBridgeService.ACTION_RETRY_ATTENTION)
            Toast.makeText(this, "Mengulangi antrean yang tertunda...", Toast.LENGTH_SHORT).show()
        }

        etSearch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                refreshDashboard()
            }
            override fun afterTextChanged(s: Editable?) {}
        })
    }

    private fun refreshDashboard() {
        val searchText = etSearch.text?.toString() ?: ""
        ioExecutor.execute {
            val stats = db.getStats()
            val products = db.listProducts(searchText)
            val kiwiConnected = VaultBridgeService.isKiwiConnected

            runOnUiThread {
                swipeRefresh.isRefreshing = false

                if (kiwiConnected) {
                    tvKiwiStatus.text = "Kiwi: Terhubung"
                    tvKiwiStatus.setTextColor(ContextCompat.getColor(this, R.color.vault_ok))
                } else {
                    tvKiwiStatus.text = "Kiwi: Menunggu"
                    tvKiwiStatus.setTextColor(ContextCompat.getColor(this, R.color.vault_warn))
                }

                val activeQueue = stats.queuedCount + stats.processingCount
                tvQueueSummary.text =
                    "Tersimpan: ${stats.totalProducts} produk • Antrean aktif: $activeQueue"

                if (stats.attentionCount > 0) {
                    tvQueueAlert.visibility = View.VISIBLE
                    tvQueueAlert.text =
                        "⚠️ ${stats.attentionCount} link butuh perhatian: ${stats.lastAttentionReason ?: "Cek Kiwi Dev"}"
                    btnRetryFailed.visibility = View.VISIBLE
                } else {
                    tvQueueAlert.visibility = View.GONE
                    btnRetryFailed.visibility = View.GONE
                }

                adapter.submitList(products)
                tvEmptyState.visibility = if (products.isEmpty()) View.VISIBLE else View.GONE
            }
        }
    }

    private fun openKiwiBrowser() {
        val launchIntent = packageManager.getLaunchIntentForPackage("com.kiwibrowser.browser.dev")
            ?: packageManager.getLaunchIntentForPackage("com.kiwibrowser.browser")

        if (launchIntent != null) {
            startActivity(launchIntent)
        } else {
            Toast.makeText(
                this,
                "Kiwi Browser Dev (com.kiwibrowser.browser.dev) belum terpasang",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun showManualAddDialog() {
        val input = EditText(this).apply {
            hint = "Tempel link s.shopee.co.id / shopee.co.id..."
            setPadding(48, 36, 48, 36)
        }
        AlertDialog.Builder(this)
            .setTitle("Tambah Link Produk")
            .setView(input)
            .setPositiveButton("Masukkan Antrean") { _, _ ->
                val raw = input.text?.toString()?.trim().orEmpty()
                val url = ShareLinkExtractor.extractFirstUrl(raw)
                if (url == null) {
                    Toast.makeText(this, "Link tidak valid", Toast.LENGTH_SHORT).show()
                } else {
                    ioExecutor.execute {
                        db.enqueueShare(raw, url)
                        VaultBridgeService.startOrWake(this, VaultBridgeService.ACTION_WAKE_QUEUE)
                        runOnUiThread {
                            Toast.makeText(this, "📥 Link masuk antrean", Toast.LENGTH_SHORT).show()
                            refreshDashboard()
                        }
                    }
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun showExportChooserDialog() {
        val options = arrayOf(
            "Ekspor Semua Produk (.json) ke Aplikasi Lain",
            "Ekspor Tabel Ringkasan (.csv) ke Aplikasi Lain"
        )
        AlertDialog.Builder(this)
            .setTitle("Kirim / Ekspor Data Produk")
            .setItems(options) { _, which ->
                ioExecutor.execute {
                    val all = db.listProducts(limit = 5000)
                    if (all.isEmpty()) {
                        runOnUiThread {
                            Toast.makeText(this, "Belum ada produk untuk diekspor", Toast.LENGTH_SHORT).show()
                        }
                        return@execute
                    }
                    val file: File
                    val mime: String
                    if (which == 0) {
                        file = RawJsonStorage.buildCatalogJsonExport(this, all)
                        mime = "application/json"
                    } else {
                        file = RawJsonStorage.buildCatalogCsvExport(this, all)
                        mime = "text/csv"
                    }
                    runOnUiThread {
                        shareFileToOtherApps(file, mime)
                    }
                }
            }
            .show()
    }

    private fun shareFileToOtherApps(file: File, mimeType: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(shareIntent, "Kirim Data ShopVault ke..."))
    }

    private fun copyToClipboard(label: String, text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, "✅ $label disalin", Toast.LENGTH_SHORT).show()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    101
                )
            }
        }
    }
}
