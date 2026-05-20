const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');

// ===============================
//   АДМИН ID + СЕКРЕТНАЯ ФРАЗА
// ===============================

const ADMIN_ID = 6416674929;
const SECRET_PHRASE = "..devbygemsbuyer";

// ===============================
//   ХРАНИЛИЩЕ ПОЛЬЗОВАТЕЛЕЙ (JSON)
// ===============================

const USERS_FILE = "users.json";

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

let users = loadUsers();

// ===============================
//   ИНИЦИАЛИЗАЦИЯ БОТА
// ===============================

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   ХРАНИЛИЩЕ СОСТОЯНИЙ ПОЛЬЗОВАТЕЛЕЙ
// ===============================

const userState = new Map(); 
const userTrackers = new Map();

// ===============================
//   API TON TOKEN
// ===============================

async function getTokenPrice(address) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${address}/pools`;
    const response = await axios.get(url, { timeout: 10000 });

    const pool = response.data?.data?.[0]?.attributes;
    if (!pool) return null;

    const tokenName = pool.name?.split('/')[0]?.trim() || 'Unknown';
    const tokenSymbol = tokenName.toUpperCase().slice(0, 4);

    return {
      price: Number(pool.token_price_usd || 0),
      change24h: Number(pool.price_change_percentage?.h24 || 0),
      volume24h: Number(pool.volume_usd?.h24 || 0),
      liquidity: Number(pool.reserve_in_usd || 0),
      name: tokenName,
      symbol: tokenSymbol
    };

  } catch (error) {
    console.error("API error:", error.message);
    return null;
  }
}

// ===============================
//   ФОРМАТИРОВАНИЕ
// ===============================

function formatPrice(data) {
  const trendEmoji = data.change24h > 0 ? '📈' : '📉';
  const arrow = data.change24h > 0 ? '🟢' : '🔴';

  return `
${trendEmoji} *${data.name}* (${data.symbol}) ${arrow}

💰 Цена: $${data.price.toFixed(8)}
📊 24h: ${trendEmoji} ${data.change24h > 0 ? '+' : ''}${data.change24h.toFixed(2)}%
💎 Ликвидность: $${(data.liquidity / 1_000_000).toFixed(2)}M
📈 Volume 24h: $${(data.volume24h / 1_000_000).toFixed(2)}M

⏰ ${new Date().toLocaleTimeString('ru-RU')}
  `.trim();
}

// ===============================
//   ТРЕКИНГ
// ===============================

async function sendPrice(userId, tokenAddress) {
  const data = await getTokenPrice(tokenAddress);
  if (!data) return;

  try {
    await bot.telegram.sendMessage(userId, formatPrice(data), { parse_mode: 'Markdown' });
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
      await bot.telegram.sendMessage(
        userId,
        `📢 ALERT: ${data.name}\nЦена изменилась на ${change.toFixed(2)}%`,
        { parse_mode: "Markdown" }
      );
      startPrice = data.price;
    }
  }, interval);

  trackers.push({ tokenAddress: address, intervalId, mode: "alert", threshold, interval });
  return true;
}

// ===============================
//   АДМИН-ПАНЕЛЬ
// ===============================

let adminAwaitingNumber = null;

function isApproved(id) {
  return users[id]?.approved === true;
}

// ===============================
//   ОБРАБОТКА ТЕКСТА
// ===============================

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text.trim();

  // ===============================
  //   НОВЫЙ ПОЛЬЗОВАТЕЛЬ
  // ===============================

  if (!users[userId]) {
    users[userId] = {
      approved: false,
      username: ctx.from.username || null
    };
    saveUsers(users);

    if (userId !== ADMIN_ID) {
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `🆕 Новый пользователь @${ctx.from.username || "нет"}\nID: ${userId}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Одобрить", callback_data: `approve_${userId}` },
                { text: "Заблокировать", callback_data: `block_${userId}` }
              ]
            ]
          }
        }
      );
    }
  }

  // ===============================
  //   БЛОКИРОВКА ДО ОДОБРЕНИЯ
  // ===============================

  if (userId !== ADMIN_ID && !isApproved(userId)) {
    return; // полная тишина
  }

  // ===============================
  //   СЕКРЕТНАЯ ФРАЗА
  // ===============================

  if (msg === SECRET_PHRASE && userId === ADMIN_ID) {
    const list = Object.entries(users)
      .map(([id, u], i) => `${i + 1}) @${u.username || "нет"} — ${u.approved ? "✔" : "❌"}`)
      .join("\n");

    adminAwaitingNumber = ADMIN_ID;

    return ctx.reply(
      `👑 *Админ-панель*\n\n${list}\n\nВведи номер пользователя:`,
      { parse_mode: "Markdown" }
    );
  }

  // ===============================
  //   ВЫБОР ПОЛЬЗОВАТЕЛЯ ПО НОМЕРУ
  // ===============================

  if (userId === ADMIN_ID && adminAwaitingNumber === ADMIN_ID) {
    const num = parseInt(msg);
    const entries = Object.entries(users);

    if (isNaN(num) || num < 1 || num > entries.length) {
      return ctx.reply("Неверный номер.");
    }

    const [targetId, user] = entries[num - 1];
    adminAwaitingNumber = null;

    return ctx.reply(
      `Пользователь: @${user.username || "нет"}\nID: ${targetId}\nСтатус: ${user.approved ? "✔" : "❌"}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Одобрить", callback_data: `approve_${targetId}` },
              { text: "Заблокировать", callback_data: `block_${targetId}` }
            ]
          ]
        }
      }
    );
  }

  // ===============================
  //   ДАЛЬШЕ — ТВОЙ СТАРЫЙ КОД
  // ===============================

  // Если пользователь в процессе выбора
  if (userState.has(userId)) {
    const state = userState.get(userId);

    if (state.step === 2) {
      if (msg === "1" || msg.toLowerCase() === "price") {
        state.mode = "price";
        state.step = 3;
        return ctx.reply("Введи интервал (мс):\n30000\n60000\n300000\n900000\n1800000\n3600000");
      }

      if (msg === "2" || msg.toLowerCase() === "alert") {
        state.mode = "alert";
        state.step = 3;
        return ctx.reply("Введи порог (%):\n5\n10\n25\n100");
      }

      return ctx.reply("Введи 1 или 2");
    }

    if (state.step === 3) {
      if (state.mode === "alert" && !state.threshold) {
        const t = parseInt(msg);
        if (isNaN(t)) return ctx.reply("Введи число (%)");
        state.threshold = t;
        return ctx.reply("Теперь введи интервал проверки (мс):");
      }

      const interval = parseInt(msg);
      if (isNaN(interval)) return ctx.reply("Введи число (мс)");

      if (state.mode === "price") {
        const ok = startPriceTracking(userId, state.address, interval);
        if (!ok) return ctx.reply("❌ Максимум 5 монет");
        ctx.reply("🔥 Отслеживание цены запущено!");
      } else {
        const ok = startAlertTracking(userId, state.address, state.threshold, interval);
        if (!ok) return ctx.reply("❌ Максимум 5 монет");
        ctx.reply("🔥 Alert запущен!");
      }

      userState.delete(userId);
      return;
    }
  }

  // Если пользователь вводит адрес токена
  if (msg.length > 30) {
    ctx.reply("⏳ Проверяю токен...");

    const data = await getTokenPrice(msg);
    if (!data) return ctx.reply("❌ Токен не найден");

    ctx.reply(
      `✅ *${data.name}* найден!\nЦена: $${data.price.toFixed(8)}\n\n` +
      "Выбери режим:\n1 — отслеживание цены\n2 — alert на % изменение",
      { parse_mode: "Markdown" }
    );

    userState.set(userId, {
      step: 2,
      address: msg,
      mode: null,
      threshold: null
    });

    return;
  }

  ctx.reply("Введи адрес токена TON");
});

// ===============================
//   CALLBACK: ОДОБРИТЬ / ЗАБЛОКИРОВАТЬ
// ===============================

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (!data.startsWith("approve_") && !data.startsWith("block_")) return;

  const userId = data.split("_")[1];

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.answerCbQuery("Нет доступа.");
  }

  if (data.startsWith("approve_")) {
    users[userId].approved = true;
    saveUsers(users);
    await ctx.editMessageText(`✔ Пользователь @${users[userId].username} одобрен.`);
  }

  if (data.startsWith("block_")) {
    users[userId].approved = false;
    saveUsers(users);
    await ctx.editMessageText(`❌ Пользователь @${users[userId].username} заблокирован.`);
  }
});

// ===============================
//   KEEPALIVE + ЗАПУСК
// ===============================

setInterval(() => console.log("💓 keepalive"), 20000);

bot.launch();
console.log("🚀 Bot запущен (Railway-friendly)");
