import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ShopeeParser = require("../kiwi-extension/shopee_parser.js");

console.log("=== 1. Syntax Check Seluruh File JS Ekstensi Kiwi ===");
for (const file of [
  "kiwi-extension/shopee_parser.js",
  "kiwi-extension/page_hook.js",
  "kiwi-extension/content_bridge.js",
  "kiwi-extension/background.js",
  "kiwi-extension/idle.js",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  console.log(`  ✓ ${file} valid`);
}

const manifest = JSON.parse(fs.readFileSync("kiwi-extension/manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 2);
assert.equal(manifest.background.persistent, true);
assert.ok(manifest.permissions.includes("debugger"));
assert.ok(manifest.permissions.includes("cookies"));
assert.ok(manifest.permissions.includes("browsingData"));
assert.ok(manifest.permissions.includes("webRequestBlocking"));
console.log("  ✓ manifest.json valid");

// Check inline JS syntax inside android-bridge/app/src/main/assets/dashboard.html
const dashHtml = fs.readFileSync("android-bridge/app/src/main/assets/dashboard.html", "utf8");
const scriptMatch = dashHtml.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(scriptMatch, "dashboard.html script tag not found");
new Function(scriptMatch[1]);
console.log("  ✓ dashboard.html inline script valid");

// Check inline SYNC_MAIN_WORLD_SCRIPT inside kiwi-extension/content_bridge.js
const cbSrc = fs.readFileSync("kiwi-extension/content_bridge.js", "utf8");
const syncMatch = cbSrc.match(/const SYNC_MAIN_WORLD_SCRIPT = `([\s\S]*?)`;/);
assert.ok(syncMatch, "SYNC_MAIN_WORLD_SCRIPT not found in content_bridge.js");
new Function(syncMatch[1].replace(/\\\\/g, "\\"));
console.log("  ✓ content_bridge.js inline MAIN-world script valid");

console.log("=== 2. Test URL Extractor & Shopee Affiliate Link Formats ===");
const shareText =
  "Temukan Kipas Angin Mini Portable Turbo dengan harga Rp45.000! Dapatkan di Shopee sekarang! https://s.shopee.co.id/7fKabc123.";
const extracted = ShopeeParser.extractFirstUrl(shareText);
assert.equal(extracted, "https://s.shopee.co.id/7fKabc123");
assert.equal(ShopeeParser.isShortShopeeUrl(extracted), true);

const cases = [
  "https://shopee.co.id/product/382368918/8835294847?uls_trackid=abc",
  "https://shopee.co.id/universal-link/product/382368918/8835294847?deep_and_deferred=1",
  "https://shopee.co.id/opaanlp/382368918/8835294847?__mobile__=1",
  "https://shopee.co.id/Kipas-Angin-Mini-Portable-i.382368918.8835294847?sp_atk=123",
  "https://shopee.co.id/universal-link?ulp=https%3A%2F%2Fshopee.co.id%2FKipas-i.382368918.8835294847",
  "https://s.shopee.co.id/an_redir?origin_link=https%3A%2F%2Fshopee.co.id%2Fproduct%2F382368918%2F8835294847",
  "https://shopee.co.id/buyer/login?next=https%3A%2F%2Fshopee.co.id%2Fproduct%2F382368918%2F8835294847",
  "https://shopee.co.id/api/v4/pdp/get_pc?shop_id=382368918&item_id=8835294847",
];

for (const u of cases) {
  const ids = ShopeeParser.extractShopeeIds(u);
  assert.deepEqual(ids, {
    shopId: "382368918",
    itemId: "8835294847",
    domain: "shopee.co.id",
  });
}
assert.equal(ShopeeParser.isShortShopeeUrl("https://id.shp.ee/7xAbCdEf"), true);
assert.equal(
  ShopeeParser.cleanShopeeTargetUrl(
    "https://shopee.co.id/universal-link/ankerindonesia/23156929148?deep_and_deferred=1&is_logged_in=false"
  ),
  "https://shopee.co.id/ankerindonesia/23156929148"
);
assert.equal(
  ShopeeParser.extractLoginNextUrl(
    "https://shopee.co.id/buyer/login?next=https%3A%2F%2Fshopee.co.id%2Fankerindonesia%2F23156929148%3Fsp_atk%3D1"
  ),
  "https://shopee.co.id/ankerindonesia/23156929148"
);
console.log(`  ✓ Semua ${cases.length} pola URL numerik + pola /username/itemId & id.shp.ee berhasil diekstrak`);

console.log("=== 3. Test Parser Response Body Shopee (/api/v4/pdp/get_pc) ===");
const mockPdpResponse = {
  error: 0,
  data: {
    item: {
      item_id: 8835294847,
      shop_id: 382368918,
      title: "Kipas Angin Mini Portable High Speed 5000mAh",
      brand: "CoolPro",
      description: "Kipas angin mini baterai awet hingga 12 jam, cocok untuk outdoor.",
      currency: "IDR",
      price_min: 4500000000, // Rp 45.000 * 100000
      price_max: 5900000000, // Rp 59.000 * 100000
      price_min_before_discount: 9000000000, // Rp 90.000 * 100000
      raw_discount: 50,
      tier_variations: [
        {
          name: "Warna",
          options: ["Putih", "Hitam"],
          images: ["id-11134207-7r98o-putihhash", "id-11134207-7r98o-hitamhash"],
        },
      ],
      models: [
        {
          model_id: 1001,
          name: "Putih",
          price: 4500000000,
          price_before_discount: 9000000000,
          stock: 25,
          has_stock: true,
        },
        {
          model_id: 1002,
          name: "Hitam",
          price: 5900000000,
          price_before_discount: 9000000000,
          stock: 15,
          has_stock: true,
        },
      ],
    },
    product_images: {
      images: ["id-11134207-main1", "id-11134207-main2"],
      shopee_video_info_list: [
        {
          duration: 18,
          thumb_url: "id-11134207-videocover",
          default_format: {
            url: "https://cvf.shopee.co.id/file/api/v4/11110105/mms/id-video-hd.mp4",
            duration: 18,
          },
        },
      ],
    },
    product_price: {
      has_final_price: true,
      price: {
        single_value: 4200000000, // Rp 42.000 setelah voucher toko
      },
    },
    product_review: {
      rating_star: 4.88,
      total_rating_count: 342,
      historical_sold: 1250,
    },
    shop_detailed: {
      name: "CoolPro Official Shop",
      shop_location: "KOTA JAKARTA BARAT",
      is_official_shop: true,
    },
  },
};

const parsed = ShopeeParser.parseShopeePdpJson(JSON.stringify(mockPdpResponse), {
  affiliateUrl: extracted,
  pageUrl: "https://shopee.co.id/product/382368918/8835294847",
});

assert.equal(parsed.canonicalKey, "shopee:382368918:8835294847");
assert.equal(parsed.affiliateUrl, "https://s.shopee.co.id/7fKabc123");
assert.equal(parsed.cleanUrl, "https://shopee.co.id/product/382368918/8835294847");
assert.equal(parsed.priceMin, 45000);
assert.equal(parsed.priceMax, 59000);
assert.equal(parsed.originalPrice, 90000);
assert.equal(parsed.voucherPrice, 42000);
assert.equal(parsed.discountPercent, 50);
assert.equal(parsed.stock, 40);
assert.equal(parsed.soldCount, 1250);
assert.equal(parsed.ratingStar, 4.88);
assert.equal(parsed.isOfficialShop, true);
assert.equal(
  parsed.videoUrl,
  "https://cvf.shopee.co.id/file/api/v4/11110105/mms/id-video-hd.mp4"
);
assert.equal(parsed.images.length, 4);
assert.equal(parsed.variants.length, 2);
console.log("  ✓ Parsing PDP Shopee (harga /100000, varian, video MP4, foto HD, link affiliate) akurat");

const mockRatings = {
  data: {
    ratings: [
      {
        author_username: "rina_99",
        rating_star: 5,
        comment: "Anginnya kencang banget padahal ukurannya kecil!",
        product_items: [{ model_name: "Putih" }],
        images: ["id-review-img1"],
      },
    ],
  },
};
const reviews = ShopeeParser.parseShopeeRatingsJson(mockRatings);
assert.equal(reviews.length, 1);
assert.equal(reviews[0].modelName, "Putih");
console.log("  ✓ Parsing ulasan produk (/api/v4/item/get_ratings) akurat");

const block903 = ShopeeParser.detectBlockedOrLoginState(
  "https://shopee.co.id/product/1/2",
  { error: 90309999 }
);
assert.equal(block903.blocked, true);
assert.equal(block903.status, "RATE_LIMITED");

const nonFalsePositive = ShopeeParser.detectBlockedOrLoginState(
  "https://shopee.co.id/universal-link/product/1/2?is_logged_in=false",
  null
);
assert.equal(nonFalsePositive.blocked, false);

const trueLoginPath = ShopeeParser.detectBlockedOrLoginState(
  "https://shopee.co.id/buyer/login?next=https%3A%2F%2Fshopee.co.id%2Fproduct%2F1%2F2",
  null
);
assert.equal(trueLoginPath.blocked, true);
assert.equal(trueLoginPath.status, "NEED_LOGIN");
console.log("  ✓ Deteksi anti-bot 90309999 & filter anti-false-positive NEED_LOGIN bekerja");

console.log("=== 4. Validasi Seluruh XML Android & Struktur Kotlin ===");
execFileSync(
  "python3",
  [
    "-c",
    `
import glob, xml.etree.ElementTree as ET
xml_files = glob.glob("android-bridge/**/*.xml", recursive=True)
assert len(xml_files) >= 9, f"Expected >=9 XML files, found {len(xml_files)}"
for xf in xml_files:
    ET.parse(xf)
print(f"  ✓ Semua {len(xml_files)} file XML Android valid & well-formed")
`,
  ],
  { stdio: "inherit" }
);

const ktFiles = execFileSync("find", ["android-bridge", "-name", "*.kt"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
assert.ok(ktFiles.length >= 8);
function verifyKotlinBraces(code, filePath) {
  const stack = ["CODE"]; // "CODE" or { type: "TEMPLATE", braceDepth: number }
  let depth = 0;
  let i = 0;
  const n = code.length;

  while (i < n) {
    const top = stack[stack.length - 1];
    if (top === "STR") {
      if (code[i] === "\\") {
        i += 2;
        continue;
      }
      if (code[i] === "$" && code[i + 1] === "{") {
        stack.push({ type: "TPL_EXPR", baseDepth: depth });
        depth++;
        i += 2;
        continue;
      }
      if (code[i] === '"') {
        stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // CODE or TPL_EXPR mode
    if (code[i] === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (code[i] === '"' && code[i + 1] === '"' && code[i + 2] === '"') {
      i += 3;
      while (i < n && !(code[i] === '"' && code[i + 1] === '"' && code[i + 2] === '"')) {
        if (code[i] === "$" && code[i + 1] === "{") {
          // skip balanced template expr inside raw string
          i += 2;
          let td = 1;
          while (i < n && td > 0) {
            if (code[i] === "{") td++;
            else if (code[i] === "}") td--;
            i++;
          }
          continue;
        }
        i++;
      }
      i += 3;
      continue;
    }
    if (code[i] === '"') {
      stack.push("STR");
      i++;
      continue;
    }
    if (code[i] === "'") {
      i++;
      if (code[i] === "\\") i += 2;
      else i++;
      if (code[i] === "'") i++;
      continue;
    }
    if (code[i] === "{") {
      depth++;
    } else if (code[i] === "}") {
      depth--;
      assert.ok(depth >= 0, `Extra closing brace in ${filePath} at offset ${i}`);
      if (typeof top === "object" && top.type === "TPL_EXPR" && depth === top.baseDepth) {
        stack.pop();
      }
    }
    i++;
  }
  assert.equal(depth, 0, `Unbalanced braces (depth=${depth}) in ${filePath}`);
  assert.equal(stack.length, 1, `Unclosed string/template in ${filePath}`);
}

for (const kf of ktFiles) {
  verifyKotlinBraces(fs.readFileSync(kf, "utf8"), kf);
}
console.log(`  ✓ Semua ${ktFiles.length} file Kotlin memiliki struktur blok seimbang`);
console.log("\nSEMUA TEST LULUS 100%!");
