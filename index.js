const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   ПОЛУЧЕНИЕ ДАННЫХ О ТОН-ТОКЕНЕ
// ===============================
async function getTokenPrice(address) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${address}/pools`;
    const response = await axios.get(url, { timeout: 10000 });

    if (!response.data?.data || response.data.data.length === 0) {
      return null;
    }

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

  } catch (error) {
    console.error("API error:", error.message);
    return null;
  }
}

// ===============================
//   ФОРМАТИРОВАНИЕ ВЫВОДА
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
//   ХРАНИЛИЩЕ ДАННЫХ
// ===============================

// userId → [{ tokenAddress, intervalId, mode, threshold }]
const userTrackers = new Map();

// ===============================
//   ТРЕКИНГ ЦЕНЫ
// ===============================
function startPriceTracking(userId, tokenAddress, interval) {
  if (!userTrackers.has(userId)) userTrackers.set(userId, []);

  const trackers = userTrackers.get(userId);
  if (trackers.length >= 5) return false;

  sendPrice(userId, tokenAddress);

  const intervalId = setInterval(() => {
    sendPrice(userId, tokenAddress);
  }, interval);

  trackers.push({
    tokenAddress,
    intervalId,
    mode: "price",
    interval
  });

  return true;
}

async function sendPrice(userId, tokenAddress) {
  const data = await getTokenPrice(tokenAddress);
  if (!data) return;

  await bot.telegram.sendMessage(
    userId,
    formatPrice(data),
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.url('📊 GeckoTerminal',
            `https://www.geckoterminal.com/ton/tokens/${tokenAddress}`),
          Markup.button.callback('⏹ Стоп', `stop_${tokenAddress}`)
        ]
      ])
    }
  );
}

// ===============================
//   ALERT НА %
// ===============================
function startAlertTracking(userId, tokenAddress, threshold, checkInterval) {
  if (!userTrackers.has(userId)) userTrackers.set(userId, []);

  const trackers = userTrackers.get(userId);
  if (trackers.length >= 5) return false;

  let startPrice = null;
  let lastAlert = 0;

  const intervalId = setInterval(async () => {
    const data = await getTokenPrice(tokenAddress);
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
              Markup.button.url('📊 GeckoTerminal',
                `https://www.geckoterminal.com/ton/tokens/${tokenAddress}`),
              Markup.button.callback('⏹ Стоп', `stop_${tokenAddress}`)
            ]
          ])
        }
      );

      lastAlert = Date.now();
      startPrice = data.price;
    }
  }, checkInterval);

  trackers.push({
    tokenAddress,
    intervalId,
    mode: "alert",
    threshold,
    checkInterval
  });

  return true;
}

// ===============================
//   КОМАНДЫ
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
//   ОБРАБОТКА АДРЕСА
// ===============================
bot.on('text', async (ctx) => {
  const address = ctx.message.text.trim();
  const userId = ctx.from.id;

  if (address.length < 30) return ctx.reply('❌ Адрес слишком короткий');

  ctx.reply('⏳ Проверяю токен...');
  const tokenData = await getTokenPrice(address);

  if (!tokenData) {
    return ctx.reply('❌ Токен не найден или API не отвечает');
  }

  ctx.reply(
    `✅ *${tokenData.name}* найден!\n\nВыбери режим:`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📊 Отслеживание цены', `mode_price_${address}`)],
        [Markup.button.callback('📈 Alert на %', `mode_alert_${address}`)],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ])
    }
  );
});

// ===============================
//   ВЫБОР РЕЖИМА
// ===============================
bot.action(/^mode_price_(.+)$/, (ctx) => {
  const address = ctx.match[1];

  ctx.reply(
    'Выбери интервал:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('30 сек', `price_${address}_30000`)],
        [Markup.button.callback('1 мин', `price_${address}_60000`)],
        [Markup.button.callback('5 мин', `price_${address}_300000`)],
        [Markup.button.callback('15 мин', `price_${address}_900000`)],
        [Markup.button.callback('30 мин', `price_${address}_1800000`)],
        [Markup.button.callback('1 час', `price_${address}_3600000`)],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

bot.action(/^mode_alert_(.+)$/, (ctx) => {
  const address = ctx.match[1];

  ctx.reply(
    'Выбери порог изменения:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('±5%', `alert_${address}_5`)],
        [Markup.button.callback('±10%', `alert_${address}_10`)],
        [Markup.button.callback('±25%', `alert_${address}_25`)],
        [Markup.button.callback('±100%', `alert_${address}_100`)],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

// ===============================
//   ИНТЕРВАЛЫ PRICE
// ===============================
bot.action(/^price_(.+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const interval = parseInt(ctx.match[2]);
  const userId = ctx.from.id;

  const ok = startPriceTracking(userId, address, interval);
  if (!ok) return ctx.answerCbQuery("❌ Лимит 5 монет");

  ctx.reply(`🔥 Отслеживание цены запущено! Интервал: ${interval / 60000} мин`);
});

// ===============================
//   ИНТЕРВАЛЫ ALERT
// ===============================
bot.action(/^alert_(.+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const threshold = parseInt(ctx.match[2]);

  ctx.reply(
    'Выбери интервал проверки:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('30 сек', `alertint_${address}_${threshold}_30000`)],
        [Markup.button.callback('1 мин', `alertint_${address}_${threshold}_60000`)],
        [Markup.button.callback('5 мин', `alertint_${address}_${threshold}_300000`)],
        [Markup.button.callback('15 мин', `alertint_${address}_${threshold}_900000`)],
        [Markup.button.callback('1 час', `alertint_${address}_${threshold}_3600000`)],
        [Markup.button.callback('Отмена', 'cancel')]
      ])
    }
  );
});

bot.action(/^alertint_(.+)_(\d+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const threshold = parseInt(ctx.match[2]);
  const interval = parseInt(ctx.match[3]);
  const userId = ctx.from.id;

  const ok = startAlertTracking(userId, address, threshold, interval);
  if (!ok) return ctx.answerCbQuery("❌ Лимит 5 монет");

  ctx.reply(`🔥 Alert активирован! Порог: ±${threshold}%, интервал: ${interval / 60000} мин`);
});

// ===============================
//   STOP
// ===============================
bot.action(/^stop_(.+)$/, (ctx) => {
  const address = ctx.match[1];
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    const trackers = userTrackers.get(userId);
    const idx = trackers.findIndex(t => t.tokenAddress === address);

    if (idx !== -1) {
      clearInterval(trackers[idx].intervalId);
      trackers.splice(idx, 1);
    }

    if (trackers.length === 0) userTrackers.delete(userId);
  }

  ctx.reply('⏹ Остановлено');
});

bot.command('stop', (ctx) => {
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    userTrackers.get(userId).forEach(t => clearInterval(t.intervalId));
    userTrackers.delete(userId);
    ctx.reply('⏹ Все отслеживания остановлены');
  } else {
    ctx.reply('❌ Нет активных отслеживаний');
  }
});

// ===============================
//   ЗАПУСК
// ===============================
bot.launch();
console.log("Bot запущен!");
