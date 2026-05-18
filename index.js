const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   СЕССИИ (ХРАНИМ ТОЛЬКО ПОСЛЕДНИЙ ТОКЕН)
// ===============================
const session = {}; // userId → { token }

// ===============================
//   ТРЕКЕРЫ (ДО 5 МОНЕТ)
// ===============================
const userTrackers = new Map();

// ===============================
//   API TON TOKEN PRICE
// ===============================
async function getTokenPrice(address) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${address}/pools`;
    const response = await axios.get(url, { timeout: 10000 });

    if (!response.data?.data || response.data.data.length === 0) return null;

    const pool = response.data.data[0].attributes;

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

  } catch (e) {
    console.error("API error:", e.message);
    return null;
  }
}

// ===============================
//   ФОРМАТИРОВАНИЕ
// ===============================
function formatPrice(data) {
  const emoji = data.change24h > 0 ? '📈' : '📉';
  const arrow = data.change24h > 0 ? '🟢' : '🔴';

  return `
${emoji} *${data.name}* (${data.symbol}) ${arrow}

💰 Цена: $${data.price.toFixed(8)}
📊 24h: ${data.change24h > 0 ? '+' : ''}${data.change24h.toFixed(2)}%
💎 Ликвидность: $${(data.liquidity / 1_000_000).toFixed(2)}M
📈 Volume 24h: $${(data.volume24h / 1_000_000).toFixed(2)}M

⏰ ${new Date().toLocaleTimeString('ru-RU')}
  `.trim();
}

// ===============================
//   PRICE TRACKING
// ===============================
function startPriceTracking(userId, token, interval) {
  if (!userTrackers.has(userId)) userTrackers.set(userId, []);

  const trackers = userTrackers.get(userId);
  if (trackers.length >= 5) return false;

  sendPrice(userId, token);

  const intervalId = setInterval(() => sendPrice(userId, token), interval);

  trackers.push({ token, intervalId, mode: "price" });
  return true;
}

async function sendPrice(userId, token) {
  const data = await getTokenPrice(token);
  if (!data) return;

  await bot.telegram.sendMessage(
    userId,
    formatPrice(data),
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.url('📊 GeckoTerminal', `https://www.geckoterminal.com/ton/tokens/${token}`),
          Markup.button.callback('⏹ Стоп', `stop`)
        ]
      ])
    }
  );
}

// ===============================
//   ALERT TRACKING
// ===============================
function startAlertTracking(userId, token, threshold, interval) {
  if (!userTrackers.has(userId)) userTrackers.set(userId, []);

  const trackers = userTrackers.get(userId);
  if (trackers.length >= 5) return false;

  let startPrice = null;
  let lastAlert = 0;

  const intervalId = setInterval(async () => {
    const data = await getTokenPrice(token);
    if (!data) return;

    if (startPrice === null) {
      startPrice = data.price;
      return;
    }

    const diff = ((data.price - startPrice) / startPrice) * 100;

    if (Math.abs(diff) >= Math.abs(threshold) && Date.now() - lastAlert > 300000) {
      const emoji = diff > 0 ? '🟢' : '🔴';
      const direction = diff > 0 ? '📈 РОСТ' : '📉 ПАДЕНИЕ';

      await bot.telegram.sendMessage(
        userId,
        `
${emoji} *ALERT: ${direction}*

💰 Цена: $${data.price.toFixed(8)}
📊 Изменение: ${diff.toFixed(2)}%
🎯 Порог: ±${threshold}%
⏰ ${new Date().toLocaleTimeString('ru-RU')}
        `.trim(),
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.url('📊 GeckoTerminal', `https://www.geckoterminal.com/ton/tokens/${token}`),
              Markup.button.callback('⏹ Стоп', `stop`)
            ]
          ])
        }
      );

      lastAlert = Date.now();
      startPrice = data.price;
    }
  }, interval);

  trackers.push({ token, intervalId, mode: "alert" });
  return true;
}

// ===============================
//   START
// ===============================
bot.start((ctx) => {
  ctx.reply(
    '👋 *TON Token Tracker Bot*\n\n' +
    '📊 Режим 1: Отслеживание цены\n' +
    '📈 Режим 2: Alert на % изменение\n\n' +
    '🔥 Можно отслеживать до 5 монет одновременно\n\n' +
    'Введи адрес контракта токена',
    { parse_mode: 'Markdown' }
  );
});

// ===============================
//   ВВОД ТОКЕНА
// ===============================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const token = ctx.message.text.trim();

  if (token.length < 30) return ctx.reply("❌ Адрес слишком короткий");

  session[userId] = { token };

  ctx.reply(
    `✅ Токен найден!\n\nВыбери режим:`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📊 Цена', 'mode_price')],
        [Markup.button.callback('📈 Alert %', 'mode_alert')],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ])
    }
  );
});

// ===============================
//   ВЫБОР РЕЖИМА
// ===============================
bot.action('mode_price', (ctx) => {
  ctx.editMessageText(
    'Выбери интервал:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('30 сек', 'p_30000')],
        [Markup.button.callback('1 мин', 'p_60000')],
        [Markup.button.callback('5 мин', 'p_300000')],
        [Markup.button.callback('15 мин', 'p_900000')],
        [Markup.button.callback('30 мин', 'p_1800000')],
        [Markup.button.callback('1 час', 'p_3600000')],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

bot.action('mode_alert', (ctx) => {
  ctx.editMessageText(
    'Выбери порог:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('±5%', 'a_5')],
        [Markup.button.callback('±10%', 'a_10')],
        [Markup.button.callback('±25%', 'a_25')],
        [Markup.button.callback('±100%', 'a_100')],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

// ===============================
//   PRICE INTERVALS
// ===============================
bot.action(/^p_(\d+)$/, (ctx) => {
  const interval = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const token = session[userId]?.token;

  if (!token) return ctx.answerCbQuery("Ошибка: нет токена");

  const ok = startPriceTracking(userId, token, interval);
  if (!ok) return ctx.answerCbQuery("❌ Лимит 5 монет");

  ctx.editMessageText(`🔥 Отслеживание цены запущено! Интервал: ${interval / 60000} мин`);
});

// ===============================
//   ALERT THRESHOLD
// ===============================
bot.action(/^a_(\d+)$/, (ctx) => {
  const threshold = parseInt(ctx.match[1]);

  ctx.editMessageText(
    'Выбери интервал проверки:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('30 сек', `ai_${threshold}_30000`)],
        [Markup.button.callback('1 мин', `ai_${threshold}_60000`)],
        [Markup.button.callback('5 мин', `ai_${threshold}_300000`)],
        [Markup.button.callback('15 мин', `ai_${threshold}_900000`)],
        [Markup.button.callback('1 час', `ai_${threshold}_3600000`)],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

// ===============================
//   ALERT INTERVAL
// ===============================
bot.action(/^ai_(\d+)_(\d+)$/, (ctx) => {
  const threshold = parseInt(ctx.match[1]);
  const interval = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  const token = session[userId]?.token;

  if (!token) return ctx.answerCbQuery("Ошибка: нет токена");

  const ok = startAlertTracking(userId, token, threshold, interval);
  if (!ok) return ctx.answerCbQuery("❌ Лимит 5 монет");

  ctx.editMessageText(`🔥 Alert активирован! Порог: ±${threshold}%, интервал: ${interval / 60000} мин`);
});

// ===============================
//   STOP
// ===============================
bot.action('stop', (ctx) => {
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    userTrackers.get(userId).forEach(t => clearInterval(t.intervalId));
    userTrackers.delete(userId);
  }

  ctx.reply('⏹ Все отслеживания остановлены');
});

bot.action('cancel', (ctx) => ctx.editMessageText('❌ Отменено'));

// ===============================
bot.launch();
console.log("Bot запущен!");
