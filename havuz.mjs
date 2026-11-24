// Garip Dünya — Haber Havuzu v0
// Dünyanın dört bir yanından garip haber manşetlerini çeker,
// AI ile puanlar, hassas olanları eler, Türkçe özet yazar.
// Çıktı: haberler.json + haberler.html (tarayıcıda aç)
//
// Çalıştırma (PowerShell):
//   $env:ANTHROPIC_API_KEY="sk-ant-..."
//   node havuz.mjs

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

// .env dosyası varsa oradan oku (ANTHROPIC_API_KEY=sk-ant-...)
if (existsSync(".env")) {
  for (const satir of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = satir.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-5-5"; // ucuz ve hızlı model
const SAAT_LIMITI = 72;           // son kaç saatin haberleri
const PAKET = 15;                 // AI'a tek seferde kaç manşet

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY yok. Klasördeki .env dosyasına ANTHROPIC_API_KEY=sk-ant-... satırını yaz.");
  process.exit(1);
}

// --- 1. KAYNAKLAR: farklı dil ve ülkelerden "garip haber" aramaları ---
const gn = (q, hl, gl) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;

const KAYNAKLAR = [
  { ad: "UPI Odd News", url: "https://rss.upi.com/news/odd_news.rss" },
  { ad: "ABD", url: gn("bizarre OR weird news", "en-US", "US") },
  { ad: "İngiltere", url: gn("bizarre", "en-GB", "GB") },
  { ad: "Avustralya", url: gn("bizarre", "en-AU", "AU") },
  { ad: "Hindistan", url: gn("bizarre", "en-IN", "IN") },
  { ad: "Meksika", url: gn("insólito", "es-419", "MX") },
  { ad: "İspanya", url: gn("insólito", "es", "ES") },
  { ad: "Brezilya", url: gn("inusitado", "pt-BR", "BR") },
  { ad: "Fransa", url: gn("insolite", "fr", "FR") },
  { ad: "Almanya", url: gn("kurios", "de", "DE") },
  { ad: "İtalya", url: gn("curioso", "it", "IT") },
  { ad: "Japonya", url: gn("珍事", "ja", "JP") },
];

// --- 2. RSS çek ve ayrıştır (kütüphanesiz, basit) ---
const etiket = (xml, t) => {
  const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
};

async function kaynakCek(k) {
  try {
    const r = await fetch(k.url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    const ogeler = xml.split("<item>").slice(1).map((p) => {
      const parca = p.split("</item>")[0];
      return {
        baslik: etiket(parca, "title"),
        link: etiket(parca, "link"),
        tarih: etiket(parca, "pubDate"),
        yayinci: etiket(parca, "source") || k.ad,
        kaynakGrubu: k.ad,
      };
    }).map((h) => {
      // Google News başlık sonu: "Başlık - Yayıncı" → yayıncı adını başlıktan at
      const ek = " - " + h.yayinci;
      if (h.baslik.endsWith(ek)) h.baslik = h.baslik.slice(0, -ek.length);
      return h;
    });
    console.log(`  ✓ ${k.ad}: ${ogeler.length} manşet`);
    return ogeler;
  } catch (e) {
    console.log(`  ✗ ${k.ad}: ${e.message}`);
    return [];
  }
}

// --- 3. AI ile puanla, ele, özetle ---
const TALIMAT = `Sen "Garip Dünya" uygulamasının haber editörüsün. Uygulama dünyanın dört bir yanından GERÇEK, garip ve komik haberleri Türk kullanıcılara sunuyor.

Sana numaralı haber manşetleri vereceğim. Her biri için değerlendirme yap.

ELE (elendi = true) eğer haber şunlardan birini içeriyorsa:
- ölüm, ciddi yaralanma, şiddet, cinayet, istismar, intihar
- trajedi, kaza mağdurları, doğal afet kurbanları
- çocuklarla ilgili olumsuz olaylar
- siyaset, savaş, din tartışmaları
- tiksindirici içerik (dışkı, idrar, kusmuk vb.)
- sıradan, ünlü olmayan bir kişiyi rezil eden / teşhir eden içerik (linç riski)
- garip ya da komik değil, sıradan haber (ekonomi, spor sonucu, hava durumu vb.)
- spor haberleri: maç olayları, sporcu açıklamaları, "tuhaf gol" vb. ELE. Sadece spor dışı insanların da güleceği gerçekten absürt olaylar kalsın.
- ünlülerin magazin/dedikodu haberleri
- aynı olayın listede daha önce geçmiş tekrarı

Elenmeyenler için:
- gariplik: 1-10 (ne kadar "bu da olur mu?" dedirtiyor)
- komiklik: 1-10
- baslik_tr: kısa, merak uyandıran Türkçe başlık (en fazla 12 kelime)
- punchline: 2-4 kelimelik vurucu Türkçe espri (örn. "Teşhis: şişme.")
- ozet_tr: 1-2 cümle esprili Türkçe özet
- ulke_en, sehir_en: aynı yerlerin İngilizce Wikipedia adları (örn. "France", "Lourdes").
- ulke, sehir: haberin GEÇTİĞİ yer. Manşette yoksa yayıncıdan ve dilden çıkar (örn. Toronto Sun → Kanada, Clarín → Arjantin). Gerçekten bilinemiyorsa boş bırak.

TÜRKÇE YAZIM (çeviri değil, yeniden yazım):
- Kelime kelime çevirme, kaynağın cümle yapısını taşıma. Haberi anla, Türkçede sıfırdan anlat.
- Yabancı kalıpları taşıma ("X de Y olmak ister", "tarihe geçti", "bizarre" kelimesini çevirmek). Deyimin Türkçe karşılığını bul.
- Özetlerde duyulan geçmiş kip (-mış) kullan: "Kasayı boşaltmış, bira içmiş, yerleri silip çıkmış."
- Kısa, doğal cümle; yüklem sonda; gereksiz "bir" ve edilgen yapı yok.
- Birimleri Türkiye'ye çevir (feet→metre, pound→kilo, °F→°C); yer adlarına doğru ek getir (Toronto'da).
- Punchline bir Türkün arkadaşına söyleyeceği gerçek bir laf olsun; virgülle sıralanmış kelime yığını olmasın.
- Kötü→iyi: "Keçi de güzel olmak ister." → "Podyumda keçiler var." | "Ayık olmayan hırsızlar kapı paspasıyla kaçtı" → "Kafayı bulan hırsızlar paspası alıp kaçmış." | "Kaçak internet, sınır yok" → "Koğuşa Starlink kurmuşlar."

KRİTİK KURAL: Sadece manşette yazan bilgiyi kullan. Manşette olmayan hiçbir detayı uydurma, ima etme ya da soru şeklinde öne sürme (punchline ve başlık dahil). Emin değilsen daha genel yaz.

SADECE şu formatta JSON dizisi döndür, başka hiçbir şey yazma:
[{"id":0,"elendi":false,"eleme_nedeni":"","gariplik":8,"komiklik":7,"baslik_tr":"...","punchline":"...","ozet_tr":"...","ulke":"...","sehir":"...","ulke_en":"...","sehir_en":"..."}]`;

async function aiDegerlendir(paket) {
  const liste = paket.map((h, i) => `${i}. [${h.yayinci}] ${h.baslik}`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: TALIMAT,
      messages: [{ role: "user", content: liste }],
    }),
  });
  if (!r.ok) throw new Error(`API hatası ${r.status}: ${await r.text()}`);
  const veri = await r.json();
  const metin = veri.content.map((c) => c.text || "").join("");
  const json = metin.slice(metin.indexOf("["), metin.lastIndexOf("]") + 1);
  return JSON.parse(json);
}

// Hata olursa paketi ikiye bölüp tekrar dene
async function guvenliDegerlendir(paket) {
  try {
    return (await aiDegerlendir(paket)).map((p) => ({ ...paket[p.id], ...p, id: undefined })).filter((x) => x.baslik);
  } catch (e) {
    if (paket.length <= 3) { console.log(`   ✗ ${paket.length} haber atlandı: ${e.message.slice(0, 80)}`); return []; }
    const orta = Math.ceil(paket.length / 2);
    return [...await guvenliDegerlendir(paket.slice(0, orta)), ...await guvenliDegerlendir(paket.slice(orta))];
  }
}


// --- Fotoğraf: haberin geçtiği yerin serbest lisanslı fotoğrafı (Wikimedia Commons) ---
// Haberin kendi fotoğrafı KULLANILMAZ (telif). Sadece şehir/ülkenin CC veya kamu malı fotoğrafı.
const UA = { "User-Agent": "GaripDunya/0.1 (https://github.com/alperkoc-proj/garip-dunya)" };
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
async function jsonAl(url) {
  for (let deneme = 0; deneme < 4; deneme++) {
    const r = await fetch(url, { headers: UA });
    if (r.status === 429 || r.status === 503) { await bekle(4000 * (deneme + 1)); continue; }
    const metin = await r.text();
    try { return JSON.parse(metin); } catch { await bekle(4000 * (deneme + 1)); }
  }
  throw new Error("Wikimedia yanıt vermedi");
}
const fotoOnbellek = new Map();
async function fotoBul(yer) {
  if (!yer) return null;
  if (fotoOnbellek.has(yer)) return fotoOnbellek.get(yer);
  let sonuc = null;
  try {
    const ozet = await jsonAl(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(yer)}`);
    const kaynak = ozet.originalimage?.source;
    if (kaynak && /\.(jpe?g|png)(\?|$)/i.test(kaynak)) {
      const dosya = decodeURIComponent(kaynak.split("?")[0].split("/").pop());
      const m = await jsonAl(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=extmetadata|url&iiurlwidth=800&titles=File:${encodeURIComponent(dosya)}`);
      const i = Object.values(m.query?.pages || {})[0]?.imageinfo?.[0];
      const lisans = i?.extmetadata?.LicenseShortName?.value || "";
      if (i?.thumburl && /cc|public domain|pd/i.test(lisans)) {
        const yazar = (i.extmetadata?.Artist?.value || "").replace(/<[^>]+>/g, "").trim().slice(0, 60);
        sonuc = { url: i.thumburl, lisans, yazar, sayfa: i.descriptionurl, yer: ozet.title };
      }
    }
  } catch {}
  // Wikipedia sayfa görseli yoksa (ör. ülke sayfasında bayrak): Commons'ta manzara fotoğrafı ara
  if (!sonuc) {
    try {
      const m = await jsonAl(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent("filetype:bitmap " + yer + " landscape")}&prop=imageinfo&iiprop=extmetadata|url|size&iiurlwidth=800`);
      const adaylar = Object.values(m.query?.pages || {}).sort((a, b) => a.index - b.index);
      for (const p of adaylar) {
        const i = p.imageinfo?.[0];
        const lisans = i?.extmetadata?.LicenseShortName?.value || "";
        if (i?.thumburl && i.width > i.height && /cc|public domain|pd/i.test(lisans) && !/gfdl/i.test(lisans)) {
          const yazar = (i.extmetadata?.Artist?.value || "").replace(/<[^>]+>/g, "").trim().slice(0, 60);
          sonuc = { url: i.thumburl, lisans, yazar, sayfa: i.descriptionurl, yer };
          break;
        }
      }
    } catch {}
  }
  fotoOnbellek.set(yer, sonuc);
  return sonuc;
}
async function fotolariEkle(liste) {
  if (existsSync("app")) mkdirSync("app/foto", { recursive: true });
  for (const h of liste) {
    const f = (await fotoBul(h.sehir_en || h.sehir)) || (await fotoBul(h.ulke_en || h.ulke));
    if (!f) continue;
    h.foto = { ...f };
    if (existsSync("app")) {
      const ad = createHash("md5").update(f.url).digest("hex").slice(0, 12) + ".jpg";
      if (!existsSync(`app/foto/${ad}`)) {
        try { const r = await fetch(f.url, { headers: UA }); if (r.ok) writeFileSync(`app/foto/${ad}`, Buffer.from(await r.arrayBuffer())); } catch {}
      }
      if (existsSync(`app/foto/${ad}`)) h.foto.dosya = `foto/${ad}`;
    }
    await bekle(1200);
  }
  console.log(`   Fotoğraf: ${liste.filter((h) => h.foto).length}/${liste.length} habere serbest lisanslı yer fotoğrafı bulundu.`);
}

// --- 4. Ana akış ---
// Önce canlı kaynaklardan çek; hiçbir şey gelmezse yedek ham.json'u kullan
console.log("1) Kaynaklar çekiliyor...");
let ham = [];
for (const k of KAYNAKLAR) { ham.push(...await kaynakCek(k)); await new Promise((r) => setTimeout(r, 1500)); }
const HAM_DOSYA = ham.length === 0 && existsSync("ham.json");
if (HAM_DOSYA) {
  console.log("   Canlı kaynaklara ulaşılamadı, yedek ham.json kullanılıyor.");
  ham = JSON.parse(readFileSync("ham.json", "utf8"));
}
const SAAT = HAM_DOSYA ? 14 * 24 : SAAT_LIMITI;

const simdi = Date.now();
const gorulen = new Set();
const haberler = ham.filter((h) => {
  if (!h.baslik) return false;
  const anahtar = h.baslik.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 60);
  if (gorulen.has(anahtar)) return false;
  gorulen.add(anahtar);
  const t = Date.parse(h.tarih);
  return isNaN(t) || simdi - t < SAAT * 3600 * 1000;
});
console.log(`   ${ham.length} manşet → tekrarsız ve güncel: ${haberler.length}`);

console.log("2) AI değerlendiriyor...");
const sonuc = [];
for (let i = 0; i < haberler.length; i += PAKET) {
  const paket = haberler.slice(i, i + PAKET);
  sonuc.push(...await guvenliDegerlendir(paket));
  console.log(`   ${Math.min(i + PAKET, haberler.length)}/${haberler.length}`);
}

const nadirlik = (h) => {
  const s = Math.max(h.gariplik || 0, h.komiklik || 0);
  return s >= 9 ? "efsanevi" : s >= 7 ? "tuhaf" : "sıradan";
};
const gecen = sonuc.filter((h) => !h.elendi)
  .map((h) => ({ ...h, nadirlik: nadirlik(h) }))
  .sort((a, b) => (b.gariplik + b.komiklik) - (a.gariplik + a.komiklik));
// Ülke başına üst sınır: tek bir ülke listeyi domine etmesin
const ULKE_SINIRI = 6;
const ulkeSayac = {};
const gecenSinirli = gecen.filter((h) => {
  if (!h.ulke) return true;
  ulkeSayac[h.ulke] = (ulkeSayac[h.ulke] || 0) + 1;
  return ulkeSayac[h.ulke] <= ULKE_SINIRI;
});
gecen.length = 0; gecen.push(...gecenSinirli);
const elenen = sonuc.filter((h) => h.elendi);
console.log("3) Fotoğraflar aranıyor...");
await fotolariEkle(gecen);

writeFileSync("haberler.json", JSON.stringify({ tarih: new Date().toISOString(), gecen, elenen }, null, 2));
// Uygulama dosyası (app/index.html bunu okur)
if (existsSync("app")) writeFileSync("app/veri.js", "window.HABERLER = " + JSON.stringify({ tarih: new Date().toISOString(), gecen }) + ";\n");

// --- 5. Göz atmak için basit HTML ---
const renk = { efsanevi: "#8B5CF6", tuhaf: "#F97316", "sıradan": "#71717A" };
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kart = (h) => `<div class="k" style="border-color:${renk[h.nadirlik]}">
<div class="ust"><span class="n" style="background:${renk[h.nadirlik]}">${h.nadirlik}</span>${esc([h.sehir, h.ulke].filter(Boolean).join(", "))} · G${h.gariplik} K${h.komiklik}</div>
<div class="p">${esc(h.punchline)}</div><h3>${esc(h.baslik_tr)}</h3><p>${esc(h.ozet_tr)}</p>
<div class="o">${esc(h.baslik)}</div><a href="${esc(h.link)}" target="_blank">${esc(h.yayinci)} →</a></div>`;
const html = `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Garip Dünya — Havuz</title><style>
body{background:#0E0E12;color:#F4F4F5;font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:20px}
.k{background:#17171C;border:2px solid;border-radius:18px;padding:16px;margin:14px 0}
.ust{font-size:13px;color:#A1A1AA;display:flex;gap:8px;align-items:center}
.n{color:#fff;font-weight:700;padding:3px 9px;border-radius:99px;font-size:12px}
.p{font-size:28px;font-weight:800;margin:10px 0 4px}h3{margin:4px 0}p{color:#D4D4D8}
.o{font-size:13px;color:#A1A1AA;font-style:italic;margin:8px 0}a{color:#C4B5FD}
details{color:#A1A1AA;margin-top:30px}li{margin:6px 0}</style>
<h1>Garip Dünya — ${gecen.length} haber</h1><p>${new Date().toLocaleString("tr-TR")} · ${elenen.length} haber elendi</p>
${gecen.map(kart).join("")}
<details><summary>Elenenler (${elenen.length})</summary><ul>${elenen.map((h) => `<li>${esc(h.baslik)} — <b>${esc(h.eleme_nedeni)}</b></li>`).join("")}</ul></details>
</html>`;
writeFileSync("haberler.html", html);

console.log(`\n✅ Bitti: ${gecen.length} haber geçti (${gecen.filter((h) => h.nadirlik === "efsanevi").length} efsanevi), ${elenen.length} elendi.`);
console.log("   haberler.html dosyasını tarayıcıda aç.");
