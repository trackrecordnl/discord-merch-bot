// index.mjs

import 'dotenv/config';
import fetch from "node-fetch";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

import { loadState, saveState } from "./productStore.mjs";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN ontbreekt");

const CHANNELS = JSON.parse(process.env.CHANNELS || "{}");
const KEYWORDS = (process.env.KEYWORDS || "vinyl,cd").split(",");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const state = loadState();

client.once("ready", () => {
  console.log(`✅ Bot online als ${client.user.tag}`);
  checkAllStores();
  setInterval(checkAllStores, 60 * 1000); // elke minuut
});

async function checkAllStores() {
  for (const [store, channelId] of Object.entries(CHANNELS)) {
    try {
      await checkStore(store, channelId);
    } catch (e) {
      console.error("Fout bij checken", store, e);
    }
  }
}

async function checkStore(shop, channelId) {
  const url = `${shop}/sitemap_products_1.xml`;
  const res = await fetch(url);
  const text = await res.text();

  const urls = [...text.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);

  for (const u of urls) {
    const handle = u.split("/").pop();
    const product = await fetchProduct(shop, handle);
    if (!product) continue;
    if (!matchesKeywords(product)) continue;

    const prev = state[handle];

    // Nieuw product
    if (!prev) {
      await postToDiscord(shop, product, channelId);
      state[handle] = { available: product.available };
      saveState(state);
    }

    // Restock
    if (prev && !prev.available && product.available) {
      await updateDiscord(shop, product, channelId);
      state[handle].available = true;
      saveState(state);
    }

    // Nog steeds sold out → geen nieuwe ping
    if (prev && !product.available) {
      state[handle].available = false;
      saveState(state);
    }
  }
}

async function fetchProduct(shop, handle) {
  try {
    const res = await fetch(`${shop}/products/${handle}.json`);
    const json = await res.json();
    return json.product;
  } catch {
    return null;
  }
}

function matchesKeywords(product) {
  const t = product.title.toLowerCase();
  return KEYWORDS.some(k => t.includes(k.toLowerCase()));
}

async function postToDiscord(shop, product, channelId) {
  const embed = buildEmbed(shop, product);
  const buttons = buildButtons(shop, product);

  const channel = await client.channels.fetch(channelId);
  const msg = await channel.send({ embeds: [embed], components: buttons });

  // Bewaar message id zodat we kunnen updaten bij restock
  state[product.handle] = {
    available: product.available,
    messageId: msg.id
  };
  saveState(state);
}

async function updateDiscord(shop, product, channelId) {
  const embed = buildEmbed(shop, product);
  const buttons = buildButtons(shop, product);

  const channel = await client.channels.fetch(channelId);
  const prev = state[product.handle];
  if (!prev?.messageId) return;

  try {
    const msg = await channel.messages.fetch(prev.messageId);
    await msg.edit({ embeds: [embed], components: buttons });
  } catch (e) {
    console.error("Kon bericht niet updaten:", e);
  }
}

function buildEmbed(shop, product) {
  const available = product.variants.some(v => v.available);
  let title = product.title;
  if (!available) title = `~~${product.title}~~ (SOLD OUT)`;

  return new EmbedBuilder()
    .setTitle(title)
    .setURL(`${shop}/products/${product.handle}`)
    .setDescription(product.body_html?.replace(/<[^>]+>/g, "") || "")
    .setThumbnail(product.images?.[0]?.src || null)
    .setColor(available ? 0x2ecc71 : 0xe74c3c)
    .setFooter({ text: shop });
}

function buildButtons(shop, product) {
  const rows = [];

  for (const v of product.variants.slice(0, 2)) {
    if (!v.available) continue;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(`${v.title} (1x €${v.price})`)
        .setStyle(ButtonStyle.Link)
        .setURL(`${originOnly(shop)}/cart/${v.id}:1`),
      new ButtonBuilder()
        .setLabel(`${v.title} (2x €${v.price})`)
        .setStyle(ButtonStyle.Link)
        .setURL(`${originOnly(shop)}/cart/${v.id}:2`),
      new ButtonBuilder()
        .setLabel(`${v.title} (4x €${v.price})`)
        .setStyle(ButtonStyle.Link)
        .setURL(`${originOnly(shop)}/cart/${v.id}:4`)
    );
    rows.push(row);
  }
  return rows;
}

function originOnly(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url;
  }
}

client.login(TOKEN);
