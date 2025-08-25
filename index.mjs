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
  Events
} from 'discord.js';
import { loadState, getEntry, setEntry } from './productStore.mjs';

/* ENV */
function parseList(v){ if(!v) return []; return String(v).split(',').map(s=>s.trim()).filter(Boolean); }
const TOKEN = process.env.DISCORD_TOKEN;
const SHOPS = parseList(process.env.SHOPS);
const CHANNELS = parseList(process.env.CHANNELS);
const KEYWORDS = parseList(process.env.KEYWORDS || 'vinyl,lp,cd,compact disc,schallplatte');
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60);
const LOCALE = process.env.LOCALE || 'en-GB';
const TZ = process.env.TIMEZONE || 'Europe/Amsterdam';
const CURRENCY = process.env.CURRENCY || 'EUR';
const UA = process.env.HTTP_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const FORCE_REFRESH_HOSTS = parseList(process.env.FORCE_REFRESH_HOSTS || '');
const PASSWORD_COOLDOWN_SEC = Number(process.env.PASSWORD_COOLDOWN_SEC || 60);

if(!TOKEN) throw new Error('DISCORD_TOKEN ontbreekt');
if(SHOPS.length === 0 || SHOPS.length !== CHANNELS.length) throw new Error('SHOPS en CHANNELS moeten bestaan en even lang zijn');

/* Discord */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once(Events.ClientReady, async (clientReady) => {
  console.log(`Bot online als ${clientReady.user.tag}`);
  loadState();
  await runOnce();
  setInterval(runOnce, CHECK_INTERVAL * 1000);
});

client.login(TOKEN);

/* Helpers */
function originOnly(url){
  try{ const u = new URL(url); return `${u.protocol}//${u.hostname}`; }
  catch{ return url.replace(/^(https?:\/\/[^/]+).*/, '$1'); }
}
function hostOnly(url){
  try{ return new URL(url).hostname; } catch { const m = url.match(/^https?:\/\/([^/]+)/); return m?m[1]:url; }
}
function fmtDate(d){ return new Intl.DateTimeFormat(LOCALE,{ dateStyle:'long', timeStyle:'short', timeZone: TZ }).format(d); }
function asPriceString(val){
  if(val == null) return '';
  const s = String(val);
  if(/^\d+$/.test(s)) return (parseInt(s,10)/100).toFixed(2);
  const n = Number(s); return Number.isNaN(n) ? s : n.toFixed(2);
}
function normHandle(h){
  try{ return decodeURIComponent(String(h||'')).toLowerCase(); }catch{ return String(h||'').toLowerCase(); }
}
function pickImageUrl(shop, p){
  let u = p?.image?.src || (Array.isArray(p?.images) && p.images[0]?.src) || null;
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  if (u.startsWith('/')) u = originOnly(shop) + u;
  return u;
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
function legacyKey(shop, p){ return `${originOnly(shop)}|${normHandle(p.handle||p.id)}`; }
function productKey(shop, p, channelId){ return `${originOnly(shop)}|${normHandle(p.handle||p.id)}|${channelId}`; }
function productHash(p){
  const arr = (p.variants||[]).map(v => `${v.id}:${v.available?1:0}:${asPriceString(v.price)}`);
  return arr.sort().join('|');
}
function snapshot(p){
  return {
    id: p.id, title: p.title, handle: normHandle(p.handle),
    images: p.images, image: p.image, variants: p.variants,
    product_type: p.product_type, published_at: p.published_at
  };
}

/* Password Protected detectie */
async function isPasswordProtected(base){
  try{
    const r = await fetch(`${originOnly(base)}/`, { headers:{ 'user-agent': UA, 'accept': 'text/html,*/*' }});
    if(!r.ok) return false;
    const html = await r.text();
    return /template-password|<form[^>]+action="\/password"|name="password"/i.test(html);
  }catch{ return false; }
}
function buildPasswordEmbed(shop, locked){
  const base = originOnly(shop);
  const title = locked ? '🔒 Password Protected' : '🔓 Password Removed';
  const color = locked ? 0xFEE75C : 0x57F287;
  return new EmbedBuilder()
    .setTitle(title)
    .setURL(base)
    .setColor(color)
    .addFields({ name: locked ? 'Locked At' : 'Unlocked At', value: fmtDate(new Date()), inline: true });
}

/* Fetch met meerdere fallbacks */
async function fetchProducts(base){
  base = originOnly(base);

  try{
    const r = await fetch(`${base}/products.json?limit=250`, { headers:{ 'user-agent': UA, 'accept':'application/json' }});
    if(r.ok){
      const data = await r.json();
      if(Array.isArray(data.products) && data.products.length) return data.products;
    }
  }catch{}

  const viaSitemap = await fetchProductsViaSitemap(base);
  if(viaSitemap.length) return viaSitemap;

  const locales = ['en-en','de-en','en-gb','en','de','fr-fr','fr'];
  for(const loc of locales){
    const alt = await fetchProductsViaSitemap(`${base}/${loc}`);
    if(alt.length) return alt;
  }

  const viaSearch = await fetchProductsViaSearch(base);
  if(viaSearch.length) return viaSearch;

  const viaCollections = await fetchProductsViaCollections(base, locales);
  return viaCollections;
}

async function fetchProductsViaSitemap(base){
  try{
    const sm = await fetch(`${base}/sitemap.xml`, { headers:{ 'user-agent': UA, 'accept': 'application/xml,text/xml,*/*' }});
    if(!sm.ok) return [];
    const xml = await sm.text();

    const productMaps = Array.from(xml.matchAll(/<loc>([^<]+sitemap_products[^<]+)<\/loc>/g)).map(m=>m[1]);
    const handles = new Set();

    async function harvestMap(mapUrl){
      try{
        const r = await fetch(mapUrl, { headers:{ 'user-agent': UA, 'accept': 'application/xml,text/xml,*/*' }});
        if(!r.ok) return;
        const x = await r.text();
        const urls = Array.from(x.matchAll(/<loc>([^<]+)<\/loc>/g)).map(m=>m[1]).filter(u => /\/products\//.test(u));
        for(const u of urls){
          const mh = u.match(/\/products\/([^/?#]+)/);
          if(mh && mh[1]) handles.add(normHandle(mh[1]));
        }
      }catch{}
    }

    if(productMaps.length){
      for(const m of productMaps.slice(0,2)) await harvestMap(m);
    }else{
      const direct = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map(m=>m[1]).filter(u => /\/products\//.test(u));
      for(const u of direct){
        const mh = u.match(/\/products\/([^/?#]+)/);
        if(mh && mh[1]) handles.add(normHandle(mh[1]));
      }
      for(const guess of [`${base}/sitemap_products_1.xml`, `${base}/sitemap_products_2.xml`]){
        await harvestMap(guess);
      }
    }

    return await fetchByHandles(base, Array.from(handles));
  }catch{ return []; }
}

async function fetchProductsViaSearch(base){
  const handles = new Set();
  for(const kw of KEYWORDS){
    try{
      const url = `${base}/search/suggest.json?q=${encodeURIComponent(kw)}&resources[type]=product&resources[limit]=40&resources[options][fields]=title,product_type,variants.title,tags`;
      const r = await fetch(url, { headers:{ 'user-agent': UA, 'accept':'application/json' }});
      if(!r.ok) continue;
      const j = await r.json();
      const prods = j?.resources?.results?.products || j?.resources?.results || j?.products || [];
      for(const p of prods){
        const link = p?.url || p?.handle || p?.url_handle;
        if(!link) continue;
        const m = String(link).match(/\/products\/([^/?#]+)/);
        if(m && m[1]) handles.add(normHandle(m[1]));
        else if (typeof link === 'string' && !link.includes('/')) handles.add(normHandle(link));
      }
    }catch{}
  }
  if(handles.size === 0) return [];
  return await fetchByHandles(base, Array.from(handles));
}

async function fetchProductsViaCollections(base, locales){
  const candidates = [`${base}/collections/all`, ...locales.map(l => `${base}/${l}/collections/all`)];
  for(const u of candidates){
    try{
      const r = await fetch(u, { headers:{ 'user-agent': UA, 'accept':'text/html,*/*' }});
      if(!r.ok) continue;
      const html = await r.text();
      const handles = extractHandlesFromHtml(html);
      if(handles.length){
        const products = await fetchByHandles(base, handles.slice(0, 60));
        if(products.length) return products;
      }
    }catch{}
  }
  return [];
}

function extractHandlesFromHtml(html){
  const set = new Set();
  for(const m of html.matchAll(/href="([^"]*\/products\/[^"]+)"/g)){
    const u = m[1];
    const mh = u.match(/\/products\/([^/?#]+)/);
    if(mh && mh[1]) set.add(normHandle(mh[1]));
  }
  return Array.from(set);
}

async function fetchByHandles(base, handles){
  const out = [];
  for(const handle of handles){
    try{
      const pj = await fetch(`${base}/products/${handle}.js`, { headers:{ 'user-agent': UA, 'accept':'application/json' }});
      if(!pj.ok) continue;
      const pjs = await pj.json();
      out.push(normalizeProductJs(pjs));
    }catch{}
  }
  return out;
}

function normalizeProductJs(pjs){
  const images = Array.isArray(pjs?.images) ? pjs.images.map(src=>({src})) : (pjs?.featured_image ? [{src:pjs.featured_image}] : []);
  const variants = Array.isArray(pjs?.variants) ? pjs.variants.map(v=>({
    id:v.id, title:v.title, price:asPriceString(v.price), available:!!v.available
  })) : [];
  return {
    id: pjs?.id ?? pjs?.product_id ?? String(pjs?.handle || Math.random()),
    title: pjs?.title || 'Product',
    handle: normHandle(pjs?.handle || pjs?.url_handle || pjs?.handle_id),
    images,
    image: images[0] || null,
    published_at: pjs?.published_at || null,
    variants,
    product_type: pjs?.type || pjs?.product_type || '',
    tags: pjs?.tags || []
  };
}

/* Discord UI */
function prettyType(p){
  const t = (p?.product_type || '').trim();
  if (t) return t;
  const title = (p?.title || '').toLowerCase();
  if (title.includes('vinyl') || title.includes('lp')) return 'Vinyl LP';
  if (title.includes('cd')) return 'CD';
  return 'Merch';
}
function minPrice(p){
  const nums = (p?.variants||[])
    .map(v => Number(asPriceString(v.price)))
    .filter(n => !Number.isNaN(n));
  if (!nums.length) return '';
  return `${nums.sort((a,b)=>a-b)[0].toFixed(2)} ${CURRENCY}`;
}
function buildEmbed(shop, p, statusText){
  const base = originOnly(shop);
  const available = productAvailable(p);
  const isRemoved = statusText && /removed/i.test(statusText);

  const title = (!isRemoved && !available)
    ? `~~${p.title}~~ (Sold Out)`
    : p.title;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(`${base}/products/${p.handle}`)
    .setColor(isRemoved ? 0x5865F2 : (available ? 0x57F287 : 0xED4245));

  embed.addFields(
    { name:'Type', value: prettyType(p), inline: true },
    { name:'Status', value: statusText || (available ? 'available' : 'sold-out'), inline: true }
  );

  const price = minPrice(p);
  if (price) embed.addFields({ name: 'Price', value: price, inline: false });

  embed.addFields({ name:'Updated', value: fmtDate(new Date()), inline: false });

  if (p?.published_at) {
    const pub = new Date(p.published_at);
    if (!isNaN(pub)) embed.addFields({ name:'Published', value: fmtDate(pub), inline: false });
  }

  const img = pickImageUrl(shop, p);
  if(img) embed.setThumbnail(img);

  return embed;
}

function buildButtons(shop, p){
  const base = originOnly(shop);
  const v = (p.variants||[]).find(x => x.available) || (p.variants||[])[0];

  if(!v){
    return [ new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('View Product').setStyle(ButtonStyle.Link).setURL(`${base}/products/${p.handle}`)
    ) ];
  }

  return [ new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Cart 1x').setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:1`),
    new ButtonBuilder().setLabel('Cart 2x').setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:2`),
    new ButtonBuilder().setLabel('Cart 4x').setStyle(ButtonStyle.Link).setURL(`${base}/cart/${v.id}:4`)
  ) ];
}

/* Loop */
async function runOnce(){
  for(let i=0;i<SHOPS.length;i++){
    try{ await handleShop(SHOPS[i], CHANNELS[i]); }
    catch(e){ console.error('Fout voor', SHOPS[i], e.message); }
  }
}

async function handleShop(shop, channelId){
  const channel = await client.channels.fetch(channelId).catch(()=>null);
  if(!channel) return;

  const origin = originOnly(shop);

  /* Password status, één bericht dat wordt bijgewerkt */
  const pwKey = `pw|${origin}|${channelId}`;
  const prevPw = getEntry(pwKey) || { protected: null, messageId: null, lastAt: 0 };
  const nowPw = await isPasswordProtected(shop);
  const changed = prevPw.protected === null ? false : (nowPw !== prevPw.protected);

  if (changed) {
    const embed = buildPasswordEmbed(shop, nowPw);
    try{
      if (prevPw.messageId) {
        const m = await channel.messages.fetch(prevPw.messageId).catch(()=>null);
        if (m) {
          await m.edit({ embeds:[embed] });
          setEntry(pwKey, { ...prevPw, protected: nowPw, lastAt: Date.now() });
        } else {
          const msg = await channel.send({ embeds:[embed] });
          setEntry(pwKey, { protected: nowPw, messageId: msg.id, lastAt: Date.now() });
        }
      } else {
        const msg = await channel.send({ embeds:[embed] });
        setEntry(pwKey, { protected: nowPw, messageId: msg.id, lastAt: Date.now() });
      }
    }catch{}
  } else if (prevPw.protected === null) {
    setEntry(pwKey, { ...prevPw, protected: nowPw, lastAt: Date.now() });
  } else if (prevPw.messageId && (Date.now() - prevPw.lastAt) > PASSWORD_COOLDOWN_SEC * 1000) {
    const embed = buildPasswordEmbed(shop, prevPw.protected);
    try{
      const m = await channel.messages.fetch(prevPw.messageId).catch(()=>null);
      if (m) await m.edit({ embeds:[embed] });
    }catch{}
    setEntry(pwKey, { ...prevPw, lastAt: Date.now() });
  }

  /* Producten ophalen en verwerken */
  const products = await fetchProducts(shop);
  products.sort((a,b)=> new Date(a.published_at||0) - new Date(b.published_at||0));

  const host = hostOnly(shop);
  const shouldForceRefresh = FORCE_REFRESH_HOSTS.includes(host);

  const currentHandles = new Set();

  for(const p0 of products){
    const p = { ...p0, handle: normHandle(p0.handle) };
    if(!productWanted(p)) continue;
    currentHandles.add(p.handle);

    const key = productKey(shop, p, channelId);
    let prev = getEntry(key);

    if (!prev) {
      const old = getEntry(legacyKey(shop, p));
      if (old && !old._migrated) {
        setEntry(key, { ...old });
        setEntry(legacyKey(shop, p), { ...old, _migrated: true });
        prev = getEntry(key);
      }
    }

    const avail = productAvailable(p);
    const hash  = productHash(p);

    if (shouldForceRefresh && prev?.messageId && !prev?.forceRefreshed) {
      try{
        const msg = await channel.messages.fetch(prev.messageId);
        await msg.edit({ embeds:[buildEmbed(shop, p, 'refresh')], components: buildButtons(shop, p) });
      }catch{}
      setEntry(key, { ...prev, forceRefreshed: true });
    }

    if(!prev){
      if(avail){
        const msg = await channel.send({ embeds:[buildEmbed(shop, p, 'new')], components: buildButtons(shop, p) });
        setEntry(key, { available:true, removed:false, hash, messageId:msg.id, lastPostAt: Date.now(), last: snapshot(p) });
      }else{
        setEntry(key, { available:false, removed:false, hash, messageId:null, lastPostAt: Date.now(), last: snapshot(p) });
      }
      continue;
    }

    if(prev.hash === hash){
      setEntry(key, { ...prev, last: snapshot(p) });
      continue;
    }

    if(prev.available === false && avail === true){
      const newMsg = await channel.send({ embeds:[buildEmbed(shop, p, 'restock')], components: buildButtons(shop, p) });
      if(prev.messageId){
        try{
          const oldMsg = await channel.messages.fetch(prev.messageId);
          await oldMsg.delete();
        }catch{}
      }
      setEntry(key, { available:true, removed:false, hash, messageId:newMsg.id, lastPostAt: Date.now(), last: snapshot(p) });
      continue;
    }

    if(prev.available === true && avail === false){
      let newId = prev.messageId || null;
      try{
        if(prev.messageId){
          const msg = await channel.messages.fetch(prev.messageId);
          await msg.edit({ embeds:[buildEmbed(shop, p, 'sold-out')], components: buildButtons(shop, p) });
        }else{
          const m2 = await channel.send({ embeds:[buildEmbed(shop, p, 'sold-out')], components: buildButtons(shop, p) });
          newId = m2.id;
        }
      }catch{}
      setEntry(key, { ...prev, available:false, removed:false, hash, messageId:newId, lastPostAt: Date.now(), last: snapshot(p) });
      continue;
    }

    let newId = prev.messageId || null;
    try{
      if(prev.messageId){
        const msg = await channel.messages.fetch(prev.messageId);
        await msg.edit({ embeds:[buildEmbed(shop, p, 'update')], components: buildButtons(shop, p) });
      }else{
        const m2 = await channel.send({ embeds:[buildEmbed(shop, p, 'update')], components: buildButtons(shop, p) });
        newId = m2.id;
      }
    }catch{}
    setEntry(key, { ...prev, hash, available: avail, removed:false, messageId:newId, lastPostAt: Date.now(), last: snapshot(p) });
  }

  // Removed detectie via index
  const indexKey = `index|${origin}|${channelId}`;
  const oldHandles = new Set(getEntry(indexKey)?.handles || []);
  const removedHandles = [...oldHandles].filter(h => !currentHandles.has(h));

  for(const h0 of removedHandles){
    const h = normHandle(h0);
    const key = `${origin}|${h}|${channelId}`;
    const prev = getEntry(key);
    if(prev && prev.removed) continue; // al afgehandeld

    const p = (prev?.last) || { title: h, handle: h, variants: [], product_type: '', images: [], image: null, published_at: null };
    const statusText = (prev && prev.available === false) ? '~~sold-out~~ → removed' : 'removed';

    let newId = prev?.messageId || null;
    try{
      if(prev?.messageId){
        const msg = await channel.messages.fetch(prev.messageId).catch(()=>null);
        if (msg) {
          await msg.edit({ embeds:[buildEmbed(shop, p, statusText)], components: buildButtons(shop, p) });
          newId = msg.id;
        } else {
          const m2 = await channel.send({ embeds:[buildEmbed(shop, p, statusText)], components: buildButtons(shop, p) });
          newId = m2.id;
        }
      }else{
        const m2 = await channel.send({ embeds:[buildEmbed(shop, p, statusText)], components: buildButtons(shop, p) });
        newId = m2.id;
      }
    }catch{}

    setEntry(key, { ...(prev||{}), available:false, removed:true, hash:'removed', messageId:newId, lastPostAt: Date.now(), last: p });
  }

  setEntry(indexKey, { handles: Array.from(currentHandles), at: Date.now() });
}
