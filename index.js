const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   ХРАНИЛИЩЕ СОСТОЯНИЙ ПОЛЬЗОВАТЕЛЕЙ
// ===============================

const userState = new Map(); 
// userId → { step, address, mode, threshold }

// ===============================
//   ПОЛУЧЕНИЕ ДАННЫХ О ТОН-ТОКЕНЕ
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
//   ФОРМАТИРОВАНИЕ ВЫВОДА
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

const userTrackers = new Map(); 
// userId → [{ tokenAddress, intervalId, mode, threshold }]

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
//   /start
// ===============================

bot.start((ctx) => {
  ctx.reply(
    "👋 *TON Token Tracker Bot*\n\n" +
    "Просто введи адрес токена TON.\n" +
    "Дальше бот сам будет спрашивать:\n" +
    "• режим (1 или 2)\n" +
    "• порог (%)\n" +
    "• интервал (мс)\n\n" +
    "🔥 Всё вручную. Работает идеально.",
    { parse_mode: "Markdown" }
  );
});

// ===============================
//   /cancel — отмена действия
// ===============================

bot.command("cancel", (ctx) => {
  const userId = ctx.from.id;

  if (userState.has(userId)) {
    userState.delete(userId);
    return ctx.reply("❌ Действие отменено. Можешь ввести новый адрес токена.");
  }

  ctx.reply("Нет активного действия.");
});

// ===============================
//   /stop — остановка всех трекингов
// ===============================

bot.command("stop", (ctx) => {
  const userId = ctx.from.id;

  if (!userTrackers.has(userId)) {
    return ctx.reply("❌ У тебя нет активных отслеживаний.");
  }

  userTrackers.get(userId).forEach(t => clearInterval(t.intervalId));
  userTrackers.delete(userId);

  ctx.reply("⏹ Все отслеживания остановлены.");
});

// ===============================
//   /help — список команд
// ===============================

bot.command("help", (ctx) => {
  ctx.reply(
    "📘 *Команды бота:*\n\n" +
    "/start — начать работу\n" +
    "/help — список команд\n" +
    "/cancel — отменить текущее действие\n" +
    "/stop — остановить все отслеживания\n\n" +
    "Просто введи адрес токена TON.",
    { parse_mode: "Markdown" }
  );
});

// ===============================
//   ОБРАБОТКА ТЕКСТА
// ===============================

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text.trim();

  // Если пользователь в процессе выбора
  if (userState.has(userId)) {
    const state = userState.get(userId);

    // Шаг 2 — выбор режима
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

    // Шаг 3 — порог или интервал
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
//   KEEPALIVE + ЗАПУСК
// ===============================

setInterval(() => console.log("💓 keepalive"), 20000);

bot.launch();
console.log("🚀 Bot запущен (Railway-friendly)");
