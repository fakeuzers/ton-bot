const { Telegraf } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
// CONFIG
// ===============================

const MIN_INTERVAL = 5000;
const MAX_TRACKERS = 5;

const userState = new Map();
const userTrackers = new Map();

// ===============================
// HELPERS
// ===============================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(num) {
  return Number(num || 0);
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ===============================
// SEARCH TOKEN
// ===============================

async function searchToken(query) {

  try {

    // ADDRESS
    if (
      query.startsWith('EQ') ||
      query.startsWith('UQ')
    ) {
      return query;
    }

    // SEARCH TOKENS
    const url =
      `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        accept: 'application/json'
      }
    });

    const pools = response.data?.data;

    if (!Array.isArray(pools)) {
      console.log("No pools array");
      return null;
    }

    // DEBUG
    console.log(
      "SEARCH RESULTS:",
      pools.length
    );

    // TON ONLY
    const tonPools = pools.filter(pool => {

      const networkId =
        pool.relationships?.network?.data?.id;

      return networkId === 'ton';
    });

    console.log(
      "TON POOLS:",
      tonPools.length
    );

    if (!tonPools.length) {
      return null;
    }

    // SORT BY LIQUIDITY
    tonPools.sort((a, b) => {

      const liqA =
        Number(a.attributes?.reserve_in_usd || 0);

      const liqB =
        Number(b.attributes?.reserve_in_usd || 0);

      return liqB - liqA;
    });

    const bestPool = tonPools[0];

    const tokenAddress =
      bestPool.relationships
        ?.base_token
        ?.data
        ?.id;

    console.log(
      "FOUND TOKEN:",
      tokenAddress
    );

    return tokenAddress || null;

  } catch (err) {

    console.log(
      "Search error:",
      err.response?.data || err.message
    );

    return null;
  }
}

// ===============================
// GET TOKEN DATA
// ===============================

async function getTokenPrice(address, retry = 0) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${address}/pools`;

    const response = await axios.get(url, {
      timeout: 15000
    });

    const pool = response.data?.data?.[0]?.attributes;

    if (!pool) return null;

    const tokenName =
      pool.name?.split('/')[0]?.trim() || 'Unknown';

    return {
      price: safeNumber(pool.token_price_usd),
      change24h: safeNumber(pool.price_change_percentage?.h24),
      volume24h: safeNumber(pool.volume_usd?.h24),
      liquidity: safeNumber(pool.reserve_in_usd),
      name: tokenName,
      symbol: tokenName.toUpperCase().slice(0, 6)
    };

  } catch (err) {

    // RATE LIMIT
    if (err.response?.status === 429) {
      console.log("429 received. Cooling down...");

      await sleep(10000);

      if (retry < 3) {
        return getTokenPrice(address, retry + 1);
      }
    }

    console.log("API error:", err.message);
    return null;
  }
}

// ===============================
// FORMAT
// ===============================

function formatPrice(data) {
  const trend = data.change24h >= 0 ? '📈' : '📉';

  return `
${trend} *${escapeMarkdown(data.name)}*

💰 Цена: \`$${data.price.toFixed(8)}\`

📊 24ч:
${data.change24h >= 0 ? '🟢' : '🔴'} ${data.change24h.toFixed(2)}%

💎 Ликвидность:
$${(data.liquidity / 1_000_000).toFixed(2)}M

📈 Объем 24ч:
$${(data.volume24h / 1_000_000).toFixed(2)}M

⏰ ${new Date().toLocaleTimeString('ru-RU')}
`.trim();
}

// ===============================
// SAFE TRACKING LOOP
// ===============================

async function startTrackingLoop(tracker) {

  while (tracker.active) {

    try {

      const data = await getTokenPrice(tracker.address);

      if (data) {

        // PRICE MODE
        if (tracker.mode === 'price') {

          await bot.telegram.sendMessage(
            tracker.userId,
            formatPrice(data),
            {
              parse_mode: 'MarkdownV2'
            }
          );

        }

        // ALERT MODE
        if (tracker.mode === 'alert') {

          if (tracker.startPrice === null) {
            tracker.startPrice = data.price;
          } else {

            const change =
              ((data.price - tracker.startPrice) / tracker.startPrice) * 100;

            if (Math.abs(change) >= tracker.threshold) {

              await bot.telegram.sendMessage(
                tracker.userId,
                `🚨 *ALERT*\n\n${escapeMarkdown(data.name)} изменился на ${change.toFixed(2)}%`,
                {
                  parse_mode: 'MarkdownV2'
                }
              );

              tracker.startPrice = data.price;
            }
          }
        }
      }

    } catch (err) {
      console.log("Tracking error:", err.message);
    }

    await sleep(tracker.interval);
  }
}

// ===============================
// COMMANDS
// ===============================

bot.start((ctx) => {

  ctx.reply(
    `🚀 TON Tracker Bot

Можно искать:
• по адресу
• по названию

Примеры:
BTC
DOGS
PEPE
NOT

Команды:
/help
/stop
/status`
  );
});

bot.command('help', (ctx) => {

  ctx.reply(
    `📘 Команды:

/start — запуск
/help — помощь
/stop — остановить всё
/status — активные трекеры
/cancel — отмена`
  );
});

bot.command('cancel', (ctx) => {

  userState.delete(ctx.from.id);

  ctx.reply('❌ Действие отменено');
});

bot.command('status', (ctx) => {

  const trackers = userTrackers.get(ctx.from.id);

  if (!trackers || trackers.length === 0) {
    return ctx.reply('❌ Нет активных отслеживаний');
  }

  let text = '📡 Активные трекеры:\n\n';

  trackers.forEach((t, i) => {
    text += `${i + 1}. ${t.name || 'TOKEN'} | ${t.mode} | ${t.interval}ms\n`;
  });

  ctx.reply(text);
});

bot.command('stop', (ctx) => {

  const trackers = userTrackers.get(ctx.from.id);

  if (!trackers) {
    return ctx.reply('❌ Нет активных трекеров');
  }

  trackers.forEach(t => {
    t.active = false;
  });

  userTrackers.delete(ctx.from.id);

  ctx.reply('⛔ Все трекеры остановлены');
});

// ===============================
// TEXT HANDLER
// ===============================

bot.on('text', async (ctx) => {

  const userId = ctx.from.id;
  const msg = ctx.message.text.trim();

  // ===========================
  // STEP FLOW
  // ===========================

  if (userState.has(userId)) {

    const state = userState.get(userId);

    // MODE
    if (state.step === 2) {

      if (msg === '1') {
        state.mode = 'price';
        state.step = 3;

        return ctx.reply(
          '⏰ Введи интервал в мс\n\nМинимум: 5000\nПример: 10000'
        );
      }

      if (msg === '2') {

        state.mode = 'alert';
        state.step = 3;

        return ctx.reply(
          '📊 Введи порог изменения (%)'
        );
      }

      return ctx.reply('Введи 1 или 2');
    }

    // THRESHOLD
    if (state.step === 3 && state.mode === 'alert' && !state.threshold) {

      const threshold = parseFloat(msg);

      if (isNaN(threshold)) {
        return ctx.reply('Введи число');
      }

      state.threshold = threshold;
      state.step = 4;

      return ctx.reply(
        '⏰ Введи интервал в мс\n\nМинимум: 5000'
      );
    }

    // INTERVAL
    if (
      (state.step === 3 && state.mode === 'price') ||
      state.step === 4
    ) {

      let interval = parseInt(msg);

      if (isNaN(interval)) {
        return ctx.reply('Введи число');
      }

      if (interval < MIN_INTERVAL) {
        interval = MIN_INTERVAL;
      }

      if (!userTrackers.has(userId)) {
        userTrackers.set(userId, []);
      }

      const trackers = userTrackers.get(userId);

      if (trackers.length >= MAX_TRACKERS) {
        return ctx.reply('❌ Максимум 5 трекеров');
      }

      const tracker = {
        userId,
        address: state.address,
        mode: state.mode,
        threshold: state.threshold,
        interval,
        active: true,
        startPrice: null,
        name: state.name
      };

      trackers.push(tracker);

      startTrackingLoop(tracker);

      ctx.reply(
        `✅ Трекинг запущен

Монета: ${state.name}
Режим: ${state.mode}
Интервал: ${interval}ms`
      );

      userState.delete(userId);

      return;
    }
  }

  // ===========================
  // SEARCH TOKEN
  // ===========================

  await ctx.reply('🔍 Ищу токен...');

  const tokenAddress = await searchToken(msg);

  if (!tokenAddress) {
    return ctx.reply('❌ Токен не найден');
  }

  const data = await getTokenPrice(tokenAddress);

  if (!data) {
    return ctx.reply('❌ Не удалось получить цену');
  }

  userState.set(userId, {
    step: 2,
    address: tokenAddress,
    threshold: null,
    mode: null,
    name: data.name
  });

  ctx.reply(
    `✅ Найден: ${data.name}

💰 Цена:
$${data.price.toFixed(8)}

Выбери режим:

1 — Price Tracking
2 — Alert Tracking`
  );
});

// ===============================
// ERROR HANDLERS
// ===============================

process.on('unhandledRejection', (err) => {
  console.log('Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.log('Uncaught Exception:', err);
});

// ===============================
// START BOT
// ===============================

bot.launch();
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web server started on port ${PORT}`);
});
console.log('🚀 Bot started successfully');

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));