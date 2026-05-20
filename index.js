// ===============================
// IMPORTS
// ===============================
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const express = require("express");

// ===============================
// CONFIG
// ===============================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);

// ===============================
// DATABASE INIT
// ===============================
const db = new sqlite3.Database("./database.sqlite");

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    status TEXT,
    username TEXT,
    firstName TEXT,
    requestedAt TEXT
  )
`);

function getUser(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function saveUser(user) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO users (id, status, username, firstName, requestedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        username = excluded.username,
        firstName = excluded.firstName,
        requestedAt = excluded.requestedAt
    `,
      [
        user.id,
        user.status,
        user.username,
        user.firstName,
        user.requestedAt,
      ],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// ===============================
// TOKEN PRICE API
// ===============================
async function getTokenPrice(address) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${address}/pools`;
    const response = await axios.get(url, { timeout: 10000 });

    const pool = response.data?.data?.[0]?.attributes;
    if (!pool) return null;

    const tokenName = pool.name?.split("/")[0]?.trim() || "Unknown";
    const tokenSymbol = tokenName.toUpperCase().slice(0, 4);

    return {
      price: Number(pool.token_price_usd || 0),
      change24h: Number(pool.price_change_percentage?.h24 || 0),
      volume24h: Number(pool.volume_usd?.h24 || 0),
      liquidity: Number(pool.reserve_in_usd || 0),
      name: tokenName,
      symbol: tokenSymbol,
    };
  } catch (err) {
    console.error("API error:", err.message);
    return null;
  }
}

// ===============================
// FORMAT OUTPUT
// ===============================
function formatPrice(data) {
  const trendEmoji = data.change24h > 0 ? "📈" : "📉";
  const arrow = data.change24h > 0 ? "🟢" : "🔴";

  return `
${trendEmoji} *${data.name}* (${data.symbol}) ${arrow}

💰 Цена: $${data.price.toFixed(8)}
📊 24h: ${trendEmoji} ${data.change24h > 0 ? "+" : ""}${data.change24h.toFixed(2)}%
💎 Ликвидность: $${(data.liquidity / 1_000_000).toFixed(2)}M
📈 Volume 24h: $${(data.volume24h / 1_000_000).toFixed(2)}M

⏰ ${new Date().toLocaleTimeString("ru-RU")}
  `.trim();
}

// ===============================
// TRACKING
// ===============================
const userState = new Map();
const userTrackers = new Map();

async function sendPrice(userId, tokenAddress) {
  const data = await getTokenPrice(tokenAddress);
  if (!data) return;

  try {
    await bot.telegram.sendMessage(userId, formatPrice(data), {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Send error:", err.message);
  }
}

function startPriceTracking(userId, address, interval) {
  if (!userTrackers.has(userId)) userTrackers.set(userId, []);
  const trackers = userTrackers.get(userId);
  if (trackers.length >= 5) return false;

  sendPrice(userId, address);
  const intervalId = setInterval(() => sendPrice(userId, address), interval);
  trackers.push({ tokenAddress: address, intervalId, mode: "price", interval });
  return true;
}

function startAlertTracking(userId, address, threshold, interval) {
  if (!userTrackers.has(userId)) userTrackers.set(userId, []);
  const trackers = userTrackers.get(userId);
  if (trackers.length >= 5) return false;

  let startPrice = null;

  const intervalId = setInterval(async () => {
    const data = await getTokenPrice(address);
    if (!data) return;

    if (startPrice === null) {
      startPrice = data.price;
      return;
    }

    const change = ((data.price - startPrice) / startPrice) * 100;

    if (Math.abs(change) >= threshold) {
      const emoji = change > 0 ? "🟢📈" : "🔴📉";
      await bot.telegram.sendMessage(
        userId,
        `${emoji} *ALERT: ${data.name}*\n\n` +
          `💰 Цена: $${data.price.toFixed(8)}\n` +
          `📊 Изменение: ${change > 0 ? "+" : ""}${change.toFixed(2)}%\n` +
          `🎯 Порог: ±${threshold}%\n\n` +
          `⏰ ${new Date().toLocaleTimeString("ru-RU")}`,
        { parse_mode: "Markdown" }
      );
      startPrice = data.price;
    }
  }, interval);

  trackers.push({
    tokenAddress: address,
    intervalId,
    mode: "alert",
    threshold,
    interval,
  });
  return true;
}

// ===============================
// START COMMAND
// ===============================
bot.start(async (ctx) => {
  const id = ctx.from.id;
  const username = ctx.from.username || "";
  const firstName = ctx.from.first_name || "";

  const existing = await getUser(id);

  if (!existing) {
    await saveUser({
      id,
      status: "pending",
      username,
      firstName,
      requestedAt: new Date().toISOString(),
    });

    await ctx.reply("🔐 Заявка отправлена админу.");
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📥 Новый пользователь:\nID: ${id}\n@${username}\n${firstName}`
    );
  } else if (existing.status === "approved" || id === ADMIN_ID) {
    ctx.reply(
      "👋 *TON Token Tracker*\n\nВведи адрес токена TON.",
      { parse_mode: "Markdown" }
    );
  } else {
    ctx.reply("⏳ Ожидай одобрения.");
  }
});

// ===============================
// ADMIN COMMAND
// ===============================
bot.command("devbygemsbuyer", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  db.all(`SELECT * FROM users`, [], (err, rows) => {
    if (err) return ctx.reply("Ошибка БД");

    if (!rows.length) return ctx.reply("📫 Нет пользователей.");

    let text = "📋 Пользователи:\n\n";
    rows.forEach((u) => {
      text += `ID: ${u.id}\nСтатус: ${u.status}\n@${u.username}\n\n`;
    });

    ctx.reply(text);
  });
});

// ===============================
// TEXT HANDLER (ТОКЕНЫ)
// ===============================
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text.trim();

  const user = await getUser(userId);

  if (!user && userId !== ADMIN_ID) return;
  if (user && user.status !== "approved" && userId !== ADMIN_ID) return;

  if (userState.has(userId)) {
    const state = userState.get(userId);

    if (state.step === 2) {
      if (msg === "1" || msg.toLowerCase() === "price") {
        state.mode = "price";
        state.step = 3;
        return ctx.reply("Введи интервал (мс):");
      }

      if (msg === "2" || msg.toLowerCase() === "alert") {
        state.mode = "alert";
        state.step = 3;
        return ctx.reply("Введи порог (%):");
      }

      return ctx.reply("Введи 1 или 2");
    }

    if (state.step === 3) {
      if (state.mode === "alert" && !state.threshold) {
        const t = parseInt(msg);
        if (isNaN(t)) return ctx.reply("Введи число (%)");
        state.threshold = t;
        return ctx.reply("Теперь введи интервал (мс):");
      }

      const interval = parseInt(msg);
      if (isNaN(interval)) return ctx.reply("Введи число (мс)");

      if (state.mode === "price") {
        const ok = startPriceTracking(userId, state.address, interval);
        if (!ok) return ctx.reply("❌ Максимум 5 монет");
        ctx.reply("🔥 Отслеживание цены запущено!");
      } else {
        const ok = startAlertTracking(
          userId,
          state.address,
          state.threshold,
          interval
        );
        if (!ok) return ctx.reply("❌ Максимум 5 монет");
        ctx.reply("🔥 Alert запущен!");
      }

      userState.delete(userId);
      return;
    }
  }

  if (/^[A-Za-z0-9]{48,}$/.test(msg)) {
    ctx.reply("⏳ Проверяю токен...");

    const data = await getTokenPrice(msg);
    if (!data) return ctx.reply("❌ Токен не найден");

    ctx.reply(
      `✅ *${data.name}* найден!\nЦена: $${data.price.toFixed(8)}\n\nВыбери режим:\n1 — отслеживание цены\n2 — alert`,
      { parse_mode: "Markdown" }
    );

    userState.set(userId, {
      step: 2,
      address: msg,
      mode: null,
      threshold: null,
    });
    return;
  }

  ctx.reply("Введи адрес токена TON");
});

// ===============================
// KEEPALIVE
// ===============================
setInterval(() => console.log("💓 keepalive"), 20000);

const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 3000);

// ===============================
bot.launch();
console.log("Bot started with SQLite + Token Tracking");
