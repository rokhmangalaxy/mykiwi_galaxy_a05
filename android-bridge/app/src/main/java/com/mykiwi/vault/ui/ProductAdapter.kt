package com.mykiwi.vault.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.mykiwi.vault.R
import com.mykiwi.vault.model.ProductRecord
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ProductAdapter(
    private val onItemClick: (ProductRecord) -> Unit,
    private val onCopyAffiliateClick: (ProductRecord) -> Unit
) : RecyclerView.Adapter<ProductAdapter.ProductViewHolder>() {

    private val items = mutableListOf<ProductRecord>()
    private val idrFormat = NumberFormat.getNumberInstance(Locale("id", "ID"))
    private val dateFormat = SimpleDateFormat("dd MMM HH:mm", Locale("id", "ID"))

    fun submitList(newItems: List<ProductRecord>) {
        items.clear()
        items.addAll(newItems)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ProductViewHolder {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_product, parent, false)
        return ProductViewHolder(v)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: ProductViewHolder, position: Int) {
        holder.bind(items[position])
    }

    inner class ProductViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvShopBadge: TextView = itemView.findViewById(R.id.tvShopBadge)
        private val tvMediaBadges: TextView = itemView.findViewById(R.id.tvMediaBadges)
        private val tvTitle: TextView = itemView.findViewById(R.id.tvTitle)
        private val tvPrice: TextView = itemView.findViewById(R.id.tvPrice)
        private val tvMetaStats: TextView = itemView.findViewById(R.id.tvMetaStats)
        private val tvTimestamp: TextView = itemView.findViewById(R.id.tvTimestamp)
        private val btnCopyAffiliate: MaterialButton = itemView.findViewById(R.id.btnCopyAffiliate)

        fun bind(item: ProductRecord) {
            val shopLabel = buildString {
                append(item.shopName ?: item.sourcePlatform.uppercase())
                if (item.isOfficialShop) append(" ✓ Mall")
                if (!item.shopLocation.isNullOrBlank()) append(" • ${item.shopLocation}")
            }
            tvShopBadge.text = shopLabel

            val imgCount = item.imageList().size
            val mediaParts = mutableListOf<String>()
            if (!item.videoUrl.isNullOrBlank()) mediaParts.add("🎬 MP4")
            if (imgCount > 0) mediaParts.add("🖼️ $imgCount Foto")
            tvMediaBadges.text = mediaParts.joinToString(" • ")

            tvTitle.text = item.title

            val pMin = item.priceMin
            val pMax = item.priceMax
            tvPrice.text = when {
                pMin != null && pMax != null && pMax > pMin ->
                    "Rp ${idrFormat.format(pMin)} - ${idrFormat.format(pMax)}"
                pMin != null ->
                    "Rp ${idrFormat.format(pMin)}"
                else -> "Harga tidak tersedia"
            }

            val statsParts = mutableListOf<String>()
            item.ratingStar?.let { statsParts.add("⭐ ${String.format(Locale.US, "%.1f", it)}") }
            item.soldCount?.let { statsParts.add("Terjual ${idrFormat.format(it)}") }
            item.stock?.let { statsParts.add("Stok $it") }
            tvMetaStats.text = statsParts.joinToString(" • ")

            tvTimestamp.text = dateFormat.format(Date(item.updatedAt))

            itemView.setOnClickListener { onItemClick(item) }
            btnCopyAffiliate.setOnClickListener { onCopyAffiliateClick(item) }
        }
    }
}
