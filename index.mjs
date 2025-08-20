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

// ===== env =====
function parseList(v){ if(!v) return []; return String(v).split(',').map(s => s.trim()).filter(Boolean); }
const TOKEN = process.env.DISCORD_TOKEN;
const SHOPS = parseList(process.env.SHOPS);
const CHANNELS = parseList(process.env.CHANNELS);
const KEYWORDS = parseList(process.env.KEYWORDS || 'vinyl,lp,cd,compact disc,schallplatte');
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60);
const TZ = process.env.TIMEZONE || 'Europe/Amsterdam';
const CURRENCY = process.env.CURRENCY || 'EUR';
if(!TOKEN) throw new Error('DISCORD_TOKEN ontbreekt');
if(SHOPS.length === 0 || SHOPS.length !== CHANNELS.length) throw new Error('SHOPS en CHANNELS moeten even lang zijn');

// ===== discord client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  console.log(`Bot online als ${client.user.tag}`);
  loadState();
  await runOnce();
  setInterval(runOnce, CHECK_INTERVAL * 1000);
});
client.login(TOKEN);

// ===== helpers =====
function originOnly(url){ try{ const u = new URL(url); return `${u.protocol}//${u.hostname}`; }catch{ return url.replace(/^(https?:\/\/[^/]+).*/, '$1'); } }
function nlDate(d){ return new Intl.DateTimeFormat('nl-NL', { dateStyle:'long', timeStyle:'short', timeZone: TZ }).format(d); }
function asPriceString(val){
  if(val == null) return '';
  const s = String(val);
  if(/^\d+$/.test(s)) return (parseInt(s,10)/100).toFixed(2);
  const n = Number(s); return Number.isNaN(n) ? s : n.toFixed(2);
}
function textMatchesKeywords(...parts){ const txt = parts.filter(Boolean).join(' ').toLowerCase(); return KEYWORDS.some(k => txt.includes(k)); }
function productWanted(p){
  const tags = Array.isArray(p?.tags) ? p.tags.join(' ') : String(p?.tags || '');
  return textMatchesKeywords(p?.title, p?.product_type, tags
                             
