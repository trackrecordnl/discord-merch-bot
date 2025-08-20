import 'dotenv/config';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { loadState, saveState } from './productStore.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const SHOPS = process.env.SHOPS.split(',');
const CHANNELS = process.env.CHANNELS.split(',');

if (!TOKEN) throw new Error("DISCORD_TOKEN ontbreekt");
if (SHOPS.length !== CHANNELS.length) throw new Error("Aantal SHOPS en CHANNELS komt niet overeen");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const state = loadState();

client.once('ready', () => {
  console.log(`Bot online als ${client.user.tag}`);
  checkAll();
  setInterval(checkAll, 60 * 1000); // elke minuut
});

async function checkAll() {
  for (let i = 0; i < SHOPS.length; i++) {
    const shop = SHOPS[i];
    const channelId = CHANNELS[i];
    try {
      const products = await fetchProducts(shop);

      for (const product of products) {
        if (!product.product_type) continue;
        const type = product.product_type.toLowerCase();
        if (!(type.includes("vinyl") || type.includes("cd"))) continue;

        const available = product.variants.some(v => v.available);
        const key = `${shop}-${product.id}`;
        const existing = state[key];

        if (!existing) {
          // Nieuw product → opslaan + posten
          await postProduct(shop, channelId, product);
          state[key] = { available, messageId: null };
        } else if (existing.available !== available) {
          // Alleen updaten als voorraadstatus is veranderd
          await updateProduct(shop, channelId, product, existing.messageId);
          state[key].available = available;
        }
      }
      saveState(state);
    } catch (err) {
      console.error(`Fout bij ${shop}:`, err.message);
    }
  }
}

async function fetchProducts(shop) {
  const base = originOnly(shop);

  // 1. Probeer products.json
  try {
    const url = `${base}/products.json?limit=250`;
    const res = await fetch(url, { headers: { "user-agent": "MerchBot/3.2" }});
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.products) && data.products.length > 0) {
        return data.products;
      }
    }
  } catch { /* fallback */ }

  // 2. Fallback via sitemap + product.js
  return await fetchProductsViaSitemap(base);
}

async function fetchProductsViaSitemap(base) {
  const sm = await fetch(`${base}/sitemap.xml`, { headers: { "user-agent": "MerchBot/3.2" }});
  if (!sm.ok) return [];
  const xml = await sm.text();

  const productMaps = Array.from(xml.matchAll(/<loc>([^<]+sitemap_products[^<]+)<\/loc>/g)).map(m => m[1]);
  if (productMaps.length === 0) return [];

  const take = productMaps.slice(0, 2);
  const productUrls = [];

  for (const mapUrl of take) {
    try {
      const r = await fetch(mapUrl, { headers: { "user-agent": "MerchBot/3.2" }});
      if (!r.ok) continue;
      const x = await r.text();
      const urls = Array.from(x.matchAll(/<loc>([^<]+)<\/loc>/g))
        .map(m => m[1])
        .filter(u => /\/products\//.test(u));
      productUrls.push(...urls);
    } catch { /* volgende */ }
  }

  const out = [];
  for (const url of productUrls) {
    const handle = handleFromProductUrl(url);
    if (!handle) continue;
    try {
      const pj = await fetch(`${base}/products/${handle}.js`, { headers: { "user-agent": "MerchBot/3.2" }});
      if (!pj.ok) continue;
      const product = await pj.json();
      out.push(normalizeProductJsToProductsJson(product));
    } catch { /* negeer */ }
  }
  return out;
}

function handleFromProductUrl(u) {
  const m = u.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

function normalizeProductJsToProductsJson(pjs) {
  const images = Array.isArray(pjs?.images) ? pjs.images.map(src => ({ src })) : (pjs?.featured_image ? [{ src: pjs.featured_image }] : []);
  const variants = Array.isArray(pjs?.variants) ? pjs.variants.map(v => ({
    id: v.id,
    title: v.title,
    price: asPriceString(v.price),
    available: !!v.available
  })) : [];

  return {
    id: pjs?.id ?? pjs?.product_id ?? String(pjs?.handle || Math.random()),
    title: pjs?.title || "Product",
    handle: pjs?.handle,
    images,
    image: images[0] || null,
    published_at: pjs?.published_at || null,
    variants,
    product_type: pjs?.type || pjs?.product_type || "",
    tags: pjs?.tags || []
  };
}

function asPriceString(val) {
  if (val == null) return "";
  const s = String(val);
  if (/^\d+$/.test(s)) {
    const cents = parseInt(s, 10);
    return (cents / 100).toFixed(2);
  }
  const n = Number(s);
  if (!Number.isNaN(n)) {
    return n.toFixed(2);
  }
  return s;
}

function originOnly(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}`;
}

async function postProduct(shop, channelId, product) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) return;

  const embed = buildEmbed(shop, product);
  const row = buildButtons(shop, product);

  const msg = await channel.send({ embeds: [embed], components: [row] });
  const key = `${shop}-${product.id}`;
  state[key] = { available: product.variants.some(v => v.available), messageId: msg.id };
  saveState(state);
}

async function updateProduct(shop, channelId, product, messageId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel) return;
  try {
    const msg = await channel.messages.fetch(messageId);
    const embed = buildEmbed(shop, product);
    const row = buildButtons(shop, product);
    await msg.edit({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error("Update mislukt:", err.message);
  }
}

function buildEmbed(shop, product) {
  const embed = new EmbedBuilder()
    .setTitle(product.title)
    .setURL(`${originOnly(shop)}/products/${product.handle}`)
    .setDescription(product.variants.map(v => `${v.title} - €${v.price} - ${v.available ? "🟢 In stock" : "🔴 Sold out"}`).join("\n"))
    .setColor(product.variants.some(v => v.available) ? 0x00ff00 : 0xff0000);

  if (product.image) {
    embed.setThumbnail(product.image.src);
  }
  return embed;
}

function buildButtons(shop, product) {
  const row = new ActionRowBuilder();
  for (const v of product.variants.slice(0, 3)) {
    const btn = new ButtonBuilder()
      .setLabel(`${v.title} (€${v.price})`)
      .setStyle(ButtonStyle.Link)
      .setURL(`${originOnly(shop)}/cart/${v.id}:1`);
    row.addComponents(btn);
  }
  return row;
}

client.login(TOKEN);
