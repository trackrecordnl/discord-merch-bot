import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
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

// STATE
const STATE_FILE = "./state.json";
let STATE = {};
try { STATE = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { STATE = {}; }
function saveState(){ fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2)); }

const BACKFILL_FLAG = "./.backfill_done";

// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function nlDate(d){
  return new Intl.DateTimeFormat("nl-NL",{ dateStyle:"long", timeStyle:"short", timeZone: TZ }).format(d);
}
function cartUrl(shop, variantId, qty){
  return `${shop.replace(/\/$/,"")}/cart/${variantId}:${qty}`;
}
function titleWithStatus(title, status){
  if(status === "Sold Out") return `~~${title}~~ (Sold Out)`;
  if(status === "Restock") return `${title} (Restock)`;
  return title;
}
function buildEmbed(shop, product, variant, status, note){
  const img = product?.images?.[0]?.src || product?.image?.src || null;
  const color = status === "Op voorraad" ? 0x57F287 : status === "Restock" ? 0xF1C40F : 0xED4245;
  const publishedAt = product?.published_at ? new Date(product.published_at) : null;

  const embed = new EmbedBuilder()
    .setTitle(titleWithStatus(product.title, status))
    .setURL(`${shop.replace(/\/$/,"")}/products/${product.handle}`)
    .setColor(color)
    .addFields(
      { name: "Type", value: String(variant.title || "nvt"), inline: true },
      { name: "Status", value: note ? `${note}` : status, inline: true },
      { name: "Price", value: `${variant.price} ${CURRENCY}`, inline: true },
      { name: "Updated", value: nlDate(new Date()), inline: true }
    )
    .setFooter({ text: "Stay ahead and never miss a drop!" });

  if (publishedAt) embed.addFields({ name: "Published", value: nlDate(publishedAt), inline: true });
  if (img) embed.setThumbnail(img);
  return embed;
}
function buildButtons(shop, variant){
  if(variant?.id){
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Add to Cart").setStyle(ButtonStyle.Link).setURL(cartUrl(shop, variant.id, 1)),
      new ButtonBuilder().setLabel("Add to Cart (x2)").setStyle(ButtonStyle.Link).setURL(cartUrl(shop, variant.id, 2))
    );
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("View Product").setStyle(ButtonStyle.Link).setURL(`${shop.replace(/\/$/,"")}/products/${variant?.handle || ""}`)
  );
}
function keyFor(shop, p, v){ return `${shop}|${p.id}|${v.id}`; }

function textMatchesKeywords(...parts){
  const txt = parts.filter(Boolean).join(" ").toLowerCase();
  return KEYWORDS.some(k => txt.includes(k));
}
function isWantedProduct(product, variant){
  const tags = Array.isArray(product?.tags) ? product.tags.join(" ") : String(product?.tags || "");
  return textMatchesKeywords(product?.title, product?.product_type, tags, variant?.title);
}

async function fetchProducts(shop){
  const url = `${shop.replace(/\/$/,"")}/products.json?limit=250`;
  const res = await fetch(url, { headers: { "user-agent": "MerchBot/2.1" }});
  if(!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  const data = await res.json();
  return Array.isArray(data.products) ? data.products : [];
}
async function postNew(channel, shop, p, v, status, key, note){
  const embed = buildEmbed(shop, p, v, status, note);
  const row = buildButtons(shop, v);
  const msg = await channel.send({ embeds:[embed], components:[row] });
  STATE[key] = { available: !!v.available, messageId: msg.id, price: v.price };
  saveState();
}
async function editExisting(channel, shop, p, v, status, key, note){
  const st = STATE[key];
  if(!st?.messageId){ return postNew(channel, shop, p, v, status, key, note); }
  try{
    const msg = await channel.messages.fetch(st.messageId);
    const embed = buildEmbed(shop, p, v, status, note);
    const row = buildButtons(shop, v);
    await msg.edit({ embeds:[embed], components:[row] });
    STATE[key] = { available: !!v.available, messageId: st.messageId, price: v.price };
    saveState();
  }catch{
    await postNew(channel, shop, p, v, status, key, note);
  }
}
async function handleShop(shop, channelId){
  const channel = await client.channels.fetch(channelId);
  const products = await fetchProducts(shop);
  products.sort((a,b) => new Date(a.published_at||0) - new Date(b.published_at||0));

  for(const p of products){
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for(const v of variants){
      if (!isWantedProduct(p, v)) continue;

      const key = keyFor(shop, p, v);
      const prev = STATE[key];
      const nowAvail = !!v.available;

      if(!prev){
        if (BACKFILL || nowAvail){
          const status = nowAvail ? "Op voorraad" : "Sold Out";
          await postNew(channel, shop, p, v, status, key, nowAvail ? "nieuw" : "eerste indexering");
        } else {
          STATE[key] = { available: nowAvail, messageId: null, price: v.price };
          saveState();
        }
        continue;
      }

      if (prev.available === false && nowAvail === true){
        await editExisting(channel, shop, p, v, "Restock", key, "weer op voorraad");
      } else if (prev.available === true && nowAvail === false){
        await editExisting(channel, shop, p, v, "Sold Out", key, "net uitverkocht");
      } else if (String(prev.price) !== String(v.price)){
        await editExisting(channel, shop, p, v, prev.available ? "Op voorraad" : "Sold Out", key, "prijs aangepast");
      }

      STATE[key].available = nowAvail;
      STATE[key].price = v.price;
      saveState();
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
  const doBackfill = BACKFILL && !fs.existsSync("./.backfill_done");
  if (doBackfill) console.log("Backfill actief, eerste ronde posten...");
  await runOnce();
  if (doBackfill) fs.writeFileSync("./.backfill_done", String(Date.now()));
  setInterval(runOnce, CHECK_INTERVAL * 1000);
});
client.login(TOKEN);
