// Mevcut haberler.json'a yer fotoğrafı ekler, app/veri.js'i yeniler
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
  } catch (e) { console.log("   foto hatası:", yer, e.message); }
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


const d = JSON.parse(readFileSync("haberler.json", "utf8"));
await fotolariEkle(d.gecen);
writeFileSync("haberler.json", JSON.stringify(d, null, 2));
if (existsSync("app")) writeFileSync("app/veri.js", "window.HABERLER = " + JSON.stringify({ tarih: d.tarih, gecen: d.gecen }) + ";\n");
