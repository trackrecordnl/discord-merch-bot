// Simple in-memory product store to keep track of stock status
import fs from 'fs';

const file = './data/products.json';

export function loadProducts() {
  try {
    const data = fs.readFileSync(file, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

export function saveProducts(products) {
  fs.writeFileSync(file, JSON.stringify(products, null, 2));
}
