import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const shopBase = process.env.SHOP_BASE;
const channelId = process.env.CHANNEL_ID;
const currency = process.env.CURRENCY || "EUR";
const timeZone = process.env.TIMEZONE || "Europe/Amsterdam";

async function getProducts() {
  const res = await fetch(`${shopBase}/products.json?limit=10`);
  const data = await res.json();
  return data.products;
}

async function sendProduct(product, variant, status) {
  const embed = new EmbedBuilder()
    .setTitle(`${product.title} (${status})`)
    .setURL(`${shopBase}/products/${product.handle}`)
    .addFields(
      { name: "Type", value: variant.title, inline: true },
      { name: "Prijs", value: `${variant.price} ${currency}`, inline: true },
      { name: "Status", value: status, inline: true }
    )
    .setThumbnail(product.image?.src || null)
    .setFooter({ text: "Merch Tracker Bot" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Add to Cart")
      .setStyle(ButtonStyle.Link)
      .setURL(`${shopBase}/cart/${variant.id}:1`),
    new ButtonBuilder()
      .setLabel("Add to Cart (x2)")
      .setStyle(ButtonStyle.Link)
      .setURL(`${shopBase}/cart/${variant.id}:2`)
  );

  const channel = await client.channels.fetch(channelId);
  await channel.send({ embeds: [embed], components: [row] });
}

async function runCheck() {
  const products = await getProducts();
  for (const product of products) {
    for (const variant of product.variants) {
      const status = variant.available ? "Op voorraad" : "Sold Out";
      await sendProduct(product, variant, status);
    }
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  runCheck();
  setInterval(runCheck, 5 * 60 * 1000); // elke 5 minuten
});

client.login(process.env.DISCORD_TOKEN);
