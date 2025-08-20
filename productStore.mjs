// productStore.mjs
import fs from 'fs';
import path from 'path';

const DATA_DIR = './data';
const DATA_FILE = path.join(DATA_DIR, 'products.json');

let MEM = null;

function ensureLoaded(){
  if(MEM !== null) return;
  try{
    if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
    MEM = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
  }catch{
    MEM = {};
  }
}
function persist(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(MEM, null, 2)); }catch{} }

export function loadState(){ ensureLoaded(); }
export function getEntry(key){ ensureLoaded(); return MEM[key]; }
export function setEntry(key, patch){
  ensureLoaded();
  const cur = MEM[key] || {};
  MEM[key] = { ...cur, ...patch };
  persist();
}
