// productStore.mjs
import fs from "fs";

const DATA_FILE = "./data/products.json";

// Huidige data inladen
export function loadState() {
  if (!fs.existsSync(DATA_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Kon products.json niet lezen:", err);
    return {};
  }
}

// State opslaan
export function saveState(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Kon products.json niet opslaan:", err);
  }
}

// Entry ophalen
export function getEntry(state, handle) {
  return state[handle];
}

// Entry toevoegen of bijwerken
export function setEntry(state, handle, entry) {
  state[handle] = entry;
}
