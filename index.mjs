// index.mjs
import 'dotenv/config';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { loadState, getEntry, setEntry } from './productStore.mjs';

/* ------------ ENV ------------ */
function parseList(v){ if(!v) return []; return String(v).split(',').map(s=>s.trim()).filter(Boolean); }
const TOKEN = process.env.DISCORD_TOKEN;
const SHOPS = parseList(process.env.SHOPS);                        // domeinen, geen /en-en
const CHANNELS = parseList(process.env.CHANNELS);                  // dezelfde volgorde als SHOPS
const KEYWORDS = parseList(process.env.KEYWORDS || 'vinyl,lp,cd,compact disc,schallplatte');
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60);
const TZ = process.env.TIMEZONE || 'Europe/Amsterdam';
const CURRENCY = process.env.CURRENCY || 'EUR';
if(!TOKEN) throw new Error('DISCORD_TOKEN ontbreekt');
if(SHOPS.length===0 || SHOPS.length!==CHANNELS.length) throw new Error('SHOPS en CHANNELS moeten bestaan en even lang zijn');

/* ------------ DISCORD ------------ */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.once('ready', async () => {
  console.log(`Bot online als ${client.user.tag}`);
  loadState();
  await runOnce();
  setInterval(runOnce, CHECK_INTERVAL * 1000);
});
client.login(TOKEN);

/* ------------ HELPERS ------------ */
function originOnly(url){
  try{ const u = new URL(url); return `${u.protocol}//${u.hostname}`; }
  catch{ return url.replace(/^(https?:\/\/[^/]+).*/, '$1'); }
}
function nlDate(d){ return new Intl.DateTimeFormat('nl-NL',{dateStyle:'long',timeStyle:'short',timeZone:TZ}).format(d); }
function asPriceString(val){
  if(val==null) return '';
  const s=String(val);
  if(/^\d+$/.test(s)) return (parseInt(s,10)/100).toFixed(2);   // centen naar euro
  const n=Number(s); return Number.isNaN(n)?s:n.toFixed(2);
}
function textMatchesKeywords(...parts){
  const txt = parts.filter(Boolean).join(' ').toLowerCase();
  return KEYWORDS.some(k => txt.includes(k));
}
function productWanted(p){
  const tags = Array.isArray(p?.tags) ? p.tags.join(' ') : String(p?.tags || '');
  return textMatchesKeywords(p?.title, p?.product_type, tags);
}
function productAvailable(p){ return Array.isArray(p?.variants) && p.variants.some(v => v?.available); }
function productKey(shop, p){ return `${originOnly(shop)}|${p.handle||p.id}`; }  // stabiel per product
function productHash(p){                                          // stabiel overzicht van varianten
  const arr = (p.variants||[]).map(v => `${v.id}:${v.available?1:0}:${asPriceString(v.price)}`);
  return arr.sort().join('|');
}

/* ------------ FETCH MET FALLBACK ------------ */
async function fetchProducts(base){
  base = originOnly(base);
  try{
    const r = await fetch(`${base}/products.json?limit=250`, { headers:{'user-agent':'MerchBot/3.5'} });
    if(r.ok){
      const data = await r.json();
      if(Array.isArray(data.products) && data.products.length) return data.products;
    }
  }catch{}
  return await fetchProductsViaSitemap(base);
}
async function fetchProductsViaSitemap(base){
  try{
    const sm = await fetch(`${base}/sitemap.xml`, { headers:{'user-agent':'MerchBot/3.5'} });
    if(!sm.ok) return [];
    const xml = await sm.text();
    const maps = Array.from(xml.matchAll(/<loc>([^<]+sitemap_products[^<]+)<\/loc>/g)).map(m=>m[1]).slice(0,2);
    if(maps.length===0) return [];
    const urls = [];
    for(const m of maps){
      try{
        const r=await fetch(m,{headers:{'user-agent':'MerchBot/3.5'}}); if(!r.ok) continue;
        const x=await r.text();
        urls.push(...Array.from(x.matchAll(/<loc>([^<]+\/products\/[^<]+)<\/loc>/g)).map(m=>m[1]));
      }catch{}
    }
    const out=[];
    for(const u of urls){
      const mh = u.match(/\/products\/([^/?#]+)/); const handle = mh?mh[1]:null; if(!handle) continue;
      try{
        const pj=await fetch(`${base}/products/${handle}.js`,{headers:{'user-agent':'MerchBot/3.5'}}); if(!pj.ok) continue;
        const pjs = await pj.json();
        out.push(normalizeProductJs(pjs));
      }catch{}
    }
    return out;
  }catch{ return []; }
}
function normalizeProductJs(pjs){
  const images = Array.isArray(pjs?.images) ? pjs.images.map(src=>({src})) : (pjs?.featured_image?[{src:pjs.featured_image}]:[]);
  const variants = Array.isArray(pjs?.variants) ? pjs.variants.map(v=>({
    id:v.id, title:v.title, price:asPriceString(v.price), available:!!v.available
  })) : [];
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

/* ------------ DISCORD UI ------------ */
function buildEmbed(shop, p, note){
  const base = originOnly(shop);
  const available = productAvailable(p);
  const title = available ? p.title : `~~${p.title}~~ (Sold Out)`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(`${base}/products/${p.handle}`)
    .setColor(available ? 0x57F287 : 0xED4245)
    .addFields({ name:'Updated', value:nlDate(new Date()), inline:true });
  if(p.image?.src) embed.setThumbnail(p.image.src);
  if(note) embed.addFields({ name:'Status', value: note, inline: true });
  return embed;
}
function buildButtons(shop, p){
  const base = originOnly(shop);
  // kies een variant om aan de cart te hangen, voorkeur beschikbaar
  const v = (p.variants||[]).find(x=>x.available) || (p.variants||[])[0];
  if(!v){
    return [ new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('View Product').setStyle(ButtonStyle.Link).setURL(`${base}/products/${p.handle}`)
    ) ];
  }
  return [ new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Add to Cart').setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:1`),
    new ButtonBuilder().setLabel('Add to Cart (x2)').setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:2`)
  ) ];
}

/* ------------ LOOP ------------ */
async function runOnce(){
  for(let i=0;i<SHOPS.length;i++){
    try{ await handleShop(SHOPS[i], CHANNELS[i]); }
    catch(e){ console.error('Fout voor', SHOPS[i], e.message); }
  }
}

async function handleShop(shop, channelId){
  const channel = await client.channels.fetch(channelId);
  if(!channel) return;

  const products = await fetchProducts(shop);
  products.sort((a,b)=> new Date(a.published_at||0) - new Date(b.published_at||0));

  for(const p of products){
    if(!productWanted(p)) continue;

    const key   = productKey(shop, p);
    const prev  = getEntry(key);                  // { available, hash, messageId, lastPostAt }
    const avail = productAvailable(p);
    const hash  = productHash(p);

    // 1) nog nooit gezien
    if(!prev){
      if(avail){
        const msg = await channel.send({ embeds:[buildEmbed(shop, p, 'nieuw')], components: buildButtons(shop, p) });
        setEntry(key, { available:true, hash, messageId:msg.id, lastPostAt: Date.now() });
      }else{
        // sold out bij eerste keer, NIET posten
        setEntry(key, { available:false, hash, messageId:null, lastPostAt: Date.now() });
      }
      continue;
    }

    // 2) geen echte wijziging, niets doen
    if(prev.hash === hash) continue;

    // 3) restock
    if(prev.available === false && avail === true){
      if(prev.messageId){
        try{
          const msg = await channel.messages.fetch(prev.messageId);
          await msg.edit({ embeds:[buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
        }catch{
          const msg = await channel.send({ embeds:[buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
          setEntry(key, { messageId: msg.id });
        }
      }else{
        const msg = await channel.send({ embeds:[buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
        setEntry(key, { messageId: msg.id });
      }
      setEntry(key, { available:true, hash, lastPostAt: Date.now() });
      continue;
    }

    // 4) sold out
    if(prev.available === true && avail === false){
      if(prev.messageId){
        try{
          const msg = await channel.messages.fetch(prev.messageId);
          await msg.edit({ embeds:[buildEmbed(shop, p, 'sold out')], components: buildButtons(shop, { ...p, variants: [] }) });
        }catch{}
      }
      setEntry(key, { available:false, hash, lastPostAt: Date.now() });
      continue;
    }

    // 5) overige wijzigingen, bijvoorbeeld prijs
    if(prev.messageId){
      try{
        const msg = await channel.messages.fetch(prev.messageId);
        await msg.edit({ embeds:[buildEmbed(shop, p, 'update')], components: buildButtons(shop, p) });
      }catch{}
    }
    setEntry(key, { hash, available: avail, lastPostAt: Date.now() });
  }
}
