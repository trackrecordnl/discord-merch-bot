import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { loadState, saveState, getEntry, setEntry } from "./productStore.mjs";
import fs from "fs";

dotenv.config();

// ENV
const TOKEN = process.env.DISCORD_TOKEN;
const SHOPS = (process.env.SHOPS || "").split(",").map(s => s.trim()).filter(Boolean);
const CHANNELS = (process.env.CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean);
const CURRENCY = process.env.CURRENCY || "EUR";
const TZ = process.env.TIMEZONE || "Europe/Amsterdam";
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60);
const BACKFILL = String(process.env.BACKFILL || "false").toLowerCase() === "true";
const KEYWORDS = (process.env.KEYWORDS || "vinyl,lp,cd,compact disc,schallplatte").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

if (!TOKEN) throw new Error("DISCORD_TOKEN ontbreekt");
if (SHOPS.length === 0 || SHOPS.length !== CHANNELS.length) throw new Error("SHOPS en CHANNELS moeten aanwezig zijn en even lang.");

// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Helpers
function nlDate(d){
  return new Intl.DateTimeFormat("nl-NL",{ dateStyle:"long", timeStyle:"short", timeZone: TZ }).format(d);
}
function cartUrl(shop, variantId, qty){
  return `${shop.replace(/\/$/,"")}/cart/${variantId}:${qty}`;
}
function statusColor(status){
  if (status === "Op voorraad") return 0x57F287;
  if (status === "Restock") return 0xF1C40F;
  return 0xED4245;
}
function titleWithStatus(title, status){
  if (status === "Sold Out") return `~~${title}~~ (Sold Out)`;
  if (status === "Restock") return `${title} (Restock)`;
  return title;
}
function textMatchesKeywords(...parts){
  const txt = parts.filter(Boolean).join(" ").toLowerCase();
  return KEYWORDS.some(k => txt.includes(k));
}
function isWantedProduct(product, variant){
  const tags = Array.isArray(product?.tags) ? product.tags.join(" ") : String(product?.tags || "");
  return textMatchesKeywords(product?.title, product?.product_type, tags, variant?.title);
}

function buildEmbed(shop, product, variant, status, note){
  const img = product?.images?.[0]?.src || product?.image?.src || null;
  const publishedAt = product?.published_at ? new Date(product.published_at) : null;

  const embed = new EmbedBuilder()
    .setTitle(titleWithStatus(product.title, status))
    .setURL(`${shop.replace(/\/$/,"")}/products/${product.handle}`)
    .setColor(statusColor(status))
    .addFields(
      { name: "Type", value: String(variant.title || "nvt"), inline: true },
      { name: "Status", value: note ? `${note}` : status, inline: true },
      { name: "Price", value: `${variant.price} ${CURRENCY}`, inline: true },
      { name: "Updated", value: nlDate(new Date()), inline: true },
      ...(publishedAt ? [{ name: "Published", value: nlDate(publishedAt), inline: true }] : [])
    )
    .setFooter({ text: "Stay ahead and never miss a drop!" });

  if (img) embed.setThumbnail(img);
  return embed;
}

function buildButtons(shop, variant){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Add to Cart").setStyle(ButtonStyle.Link).setURL(cartUrl(shop, variant.id, 1)),
    new ButtonBuilder().setLabel("Add to Cart (x2)").setStyle(ButtonStyle.Link).setURL(cartUrl(shop, variant.id, 2))
  );
}

function keyFor(shop, p, v){ return `${shop}|${p.id}|${v.id}`; }

async function fetchProducts(shop){
  const url = `${shop.replace(/\/$/,"")}/products.json?limit=250`;
  const res = await fetch(url, { headers: { "user-agent": "MerchBot/3.0" }});
  if(!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  const data = await res.json();
  return Array.isArray(data.products) ? data.products : [];
}

async function postNew(channel, shop, p, v, status, key, note){
  const embed = buildEmbed(shop, p, v, status, note);
  const row = buildButtons(shop, v);
  const msg = await channel.send({ embeds:[embed], components:[row] });
  setEntry(key, { available: !!v.available, messageId: msg.id, price: v.price });
}

async function editExisting(channel, shop, p, v, status, key, note){
  const st = getEntry(key);
  if(!st?.messageId){ return postNew(channel, shop, p, v, status, key, note); }
  try{
    const msg = await channel.messages.fetch(st.messageId);
    const embed = buildEmbed(shop, p, v, status, note);
    const row = buildButtons(shop, v);
    await msg.edit({ embeds:[embed], components:[row] });
    setEntry(key, { available: !!v.available, messageId: st.messageId, price: v.price });
  }catch{
    await postNew(channel, shop, p, v, status, key, note);
  }
}

async function handleShop(shop, channelId){
  const channel = await client.channels.fetch(channelId);
  const products = await fetchProducts(shop);

  // Oudste eerst, dan voelt de tijdlijn logisch
  products.sort((a,b) => new Date(a.published_at||0) - new Date(b.published_at||0));

  for(const p of products){
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for(const v of variants){
      // Filter, alleen cd en vinyl gerelateerd
      if (!isWantedProduct(p, v)) continue;

      const key = keyFor(shop, p, v);
      const prev = getEntry(key);
      const nowAvail = !!v.available;

      if(!prev){
        const firstStatus = nowAvail ? "Op voorraad" : "Sold Out";
        if (BACKFILL || nowAvail){
          await postNew(channel, shop, p, v, firstStatus, key, nowAvail ? "nieuw" : "eerste indexering");
        } else {
          setEntry(key, { available: nowAvail, messageId: null, price: v.price });
        }
        continue;
      }

      // Alleen reageren op echte wijzigingen
      if (prev.available === false && nowAvail === true){
        await editExisting(channel, shop, p, v, "Restock", key, "weer op voorraad");
      } else if (prev.available === true && nowAvail === false){
        await editExisting(channel, shop, p, v, "Sold Out", key, "net uitverkocht");
      } else if (String(prev.price) !== String(v.price)){
        await editExisting(channel, shop, p, v, prev.available ? "Op voorraad" : "Sold Out", key, "prijs aangepast");
      }

      // State bijwerken
      setEntry(key, { available: nowAvail, messageId: getEntry(key)?.messageId || null, price: v.price });
    }
  }
}

async function runOnce(){
  for(let i=0;i<SHOPS.length;i++){
    try{ await handleShop(SHOPS[i], CHANNELS[i]); }
    catch(e){ console.error("Fout voor", SHOPS[i], e.message); }
  }
}

client.once("ready", async () => {
  console.log(`Bot online als ${client.user.tag}`);
  // Backfill 1 keer, zet daarna een vlag zodat het niet blijft spammen
  const flag = "./.backfill_done";
  const doBackfill = BACKFILL && !fs.existsSync(flag);
  if (doBackfill) console.log("Backfill actief, eerste ronde posten...");
  loadState(); // laad cache uit disk
  await runOnce();
  if (doBackfill) fs.writeFileSync(flag, String(Date.now()));
  setInterval(runOnce, CHECK_INTERVAL * 1000);
});

client.login(TOKEN);
