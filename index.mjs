// index.mjs
import 'dotenv/config';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { loadState, getEntry, setEntry } from './productStore.mjs';

// ====== Env helpers ======
function parseList(val) {
  if (!val) return [];
  // support JSON array too, maar standaard is het "a,b,c"
  try {
    const p = JSON.parse(val);
    if (Array.isArray(p)) return p.map(x => String(x).trim()).filter(Boolean);
  } catch {}
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
}

const TOKEN = process.env.DISCORD_TOKEN;
const SHOPS = parseList(process.env.SHOPS);
const CHANNELS = parseList(process.env.CHANNELS);
const KEYWORDS = parseList(process.env.KEYWORDS || 'vinyl,lp,cd,compact disc,schallplatte');
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60);
const TZ = process.env.TIMEZONE || 'Europe/Amsterdam';
const CURRENCY = process.env.CURRENCY || 'EUR';

if (!TOKEN) throw new Error('DISCORD_TOKEN ontbreekt');
if (SHOPS.length === 0 || SHOPS.length !== CHANNELS.length) {
  throw new Error('SHOPS en CHANNELS moeten aanwezig zijn en even lang zijn');
}

// ====== Discord ======
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  console.log(`Bot online als ${client.user.tag}`);
  loadState(); // laad lokale state
  await runOnce();
  setInterval(runOnce, CHECK_INTERVAL * 1000);
});

client.login(TOKEN);

// ====== Helpers ======
function originOnly(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url.replace(/^(https?:\/\/[^/]+).*/, '$1');
  }
}
function nlDate(d) {
  return new Intl.DateTimeFormat('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: TZ }).format(d);
}
function asPriceString(val) {
  if (val == null) return '';
  const s = String(val);
  if (/^\d+$/.test(s)) return (parseInt(s, 10) / 100).toFixed(2); // centen naar euro
  const n = Number(s);
  return Number.isNaN(n) ? s : n.toFixed(2);
}
function textMatchesKeywords(...parts) {
  const txt = parts.filter(Boolean).join(' ').toLowerCase();
  return KEYWORDS.some(k => txt.includes(k));
}
function isWantedProduct(product) {
  const tags = Array.isArray(product?.tags) ? product.tags.join(' ') : String(product?.tags || '');
  return textMatchesKeywords(product?.title, product?.product_type, tags);
}
function productAvailable(product) {
  return Array.isArray(product?.variants) && product.variants.some(v => v?.available);
}
function productKey(shop, product) {
  return `${originOnly(shop)}|${product.handle || product.id}`;
}

// ====== Fetch products with fallback ======
async function fetchProducts(base) {
  base = originOnly(base);

  // 1) snelle route
  try {
    const url = `${base}/products.json?limit=250`;
    const r = await fetch(url, { headers: { 'user-agent': 'MerchBot/3.3' } });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data.products) && data.products.length) return data.products;
    }
  } catch {}

  // 2) fallback via sitemap + product.js
  return await fetchProductsViaSitemap(base);
}
async function fetchProductsViaSitemap(base) {
  try {
    const sm = await fetch(`${base}/sitemap.xml`, { headers: { 'user-agent': 'MerchBot/3.3' } });
    if (!sm.ok) return [];
    const xml = await sm.text();
    const productMaps = Array.from(xml.matchAll(/<loc>([^<]+sitemap_products[^<]+)<\/loc>/g)).map(m => m[1]).slice(0, 2);
    if (!productMaps.length) return [];

    const productUrls = [];
    for (const mapUrl of productMaps) {
      try {
        const r = await fetch(mapUrl, { headers: { 'user-agent': 'MerchBot/3.3' } });
        if (!r.ok) continue;
        const x = await r.text();
        const urls = Array.from(x.matchAll(/<loc>([^<]+)<\/loc>/g))
          .map(m => m[1])
          .filter(u => /\/products\//.test(u));
        productUrls.push(...urls);
      } catch {}
    }

    const out = [];
    for (const u of productUrls) {
      const m = u.match(/\/products\/([^/?#]+)/);
      const handle = m ? m[1] : null;
      if (!handle) continue;
      try {
        const pj = await fetch(`${base}/products/${handle}.js`, { headers: { 'user-agent': 'MerchBot/3.3' } });
        if (!pj.ok) continue;
        const pjs = await pj.json();
        out.push(normalizeProductJsToProductsJson(pjs));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
function normalizeProductJsToProductsJson(pjs) {
  const images = Array.isArray(pjs?.images)
    ? pjs.images.map(src => ({ src }))
    : pjs?.featured_image ? [{ src: pjs.featured_image }] : [];
  const variants = Array.isArray(pjs?.variants)
    ? pjs.variants.map(v => ({
        id: v.id,
        title: v.title,
        price: asPriceString(v.price),
        available: !!v.available
      }))
    : [];
  return {
    id: pjs?.id ?? pjs?.product_id ?? String(pjs?.handle || Math.random()),
    title: pjs?.title || 'Product',
    handle: pjs?.handle,
    images,
    image: images[0] || null,
    published_at: pjs?.published_at || null,
    variants,
    product_type: pjs?.type || pjs?.product_type || '',
    tags: pjs?.tags || []
  };
}

// ====== Discord builders ======
function buildEmbed(shop, product, statusNote) {
  const base = originOnly(shop);
  const available = productAvailable(product);
  const title = available ? product.title : `~~${product.title}~~ (SOLD OUT)`;
  const descLines = (product.variants || []).slice(0, 5).map(v =>
    `${v.title}  €${asPriceString(v.price)}  ${v.available ? '🟢 In stock' : '🔴 Sold out'}`
  );

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(`${base}/products/${product.handle}`)
    .setDescription(descLines.join('\n'))
    .setColor(available ? 0x57F287 : 0xED4245)
    .addFields({ name: 'Updated', value: nlDate(new Date()), inline: true });

  if (product.image?.src) embed.setThumbnail(product.image.src);
  if (statusNote) embed.addFields({ name: 'Status', value: statusNote, inline: true });
  return embed;
}
function buildButtons(shop, product) {
  const base = originOnly(shop);
  const rows = [];
  // knoppen alleen voor beschikbare varianten, max 2 varianten per bericht
  const avail = (product.variants || []).filter(v => v.available).slice(0, 2);
  if (avail.length === 0) {
    // fallback: View Product
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('View Product').setStyle(ButtonStyle.Link).setURL(`${base}/products/${product.handle}`)
    ));
    return rows;
  }
  for (const v of avail) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`${v.title} (1x €${asPriceString(v.price)})`).setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:1`),
        new ButtonBuilder().setLabel(`${v.title} (2x €${asPriceString(v.price)})`).setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:2`),
        new ButtonBuilder().setLabel(`${v.title} (4x €${asPriceString(v.price)})`).setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:4`)
      )
    );
  }
  return rows;
}

// ====== Core flow ======
async function runOnce() {
  for (let i = 0; i < SHOPS.length; i++) {
    const shop = SHOPS[i];
    const channelId = CHANNELS[i];
    try {
      await handleShop(shop, channelId);
    } catch (e) {
      console.error('Fout voor', shop, e.message);
    }
  }
}

async function handleShop(shop, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) return;
  const products = await fetchProducts(shop);

  // Oudste eerst, natuurlijke tijdlijn
  products.sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0));

  for (const p of products) {
    if (!isWantedProduct(p)) continue;

    const key = productKey(shop, p);
    const prev = getEntry(key);
    const nowAvail = productAvailable(p);

    if (!prev) {
      // Eerste keer gezien
      if (nowAvail) {
        // Nieuw beschikbaar → post NIEUW bericht
        const embed = buildEmbed(shop, p, 'nieuw');
        const buttons = buildButtons(shop, p);
        const msg = await channel.send({ embeds: [embed], components: buttons });
        setEntry(key, { available: true, messageId: msg.id, updatedAt: Date.now() });
      } else {
        // Sold out bij eerste ontdekking → NIET posten, alleen registreren
        setEntry(key, { available: false, messageId: null, updatedAt: Date.now() });
      }
      continue;
    }

    // Was sold out en nu beschikbaar → RESTOCK
    if (prev.available === false && nowAvail === true) {
      if (prev.messageId) {
        // Er was al eens gepost, update dat bericht naar in stock
        try {
          const msg = await channel.messages.fetch(prev.messageId);
          await msg.edit({ embeds: [buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
          setEntry(key, { available: true, updatedAt: Date.now() });
        } catch {
          // als oud bericht weg is, post nieuw
          const msg = await channel.send({ embeds: [buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
          setEntry(key, { available: true, messageId: msg.id, updatedAt: Date.now() });
        }
      } else {
        // Nooit eerder gepost, restock mag als nieuw bericht
        const msg = await channel.send({ embeds: [buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
        setEntry(key, { available: true, messageId: msg.id, updatedAt: Date.now() });
      }
      continue;
    }

    // Was in stock en nu sold out → zelfde bericht updaten met doorgestreept
    if (prev.available === true && nowAvail === false) {
      if (prev.messageId) {
        try {
          const msg = await channel.messages.fetch(prev.messageId);
          await msg.edit({ embeds: [buildEmbed(shop, p, 'sold out')], components: buildButtons(shop, { ...p, variants: [] }) });
        } catch {
          // als het oude bericht weg is, niets posten, alleen status bijwerken
        }
      }
      setEntry(key, { available: false, updatedAt: Date.now() });
      continue;
    }

    // Geen statuswijziging → niets doen
  }
}
