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

// userId → [{ tokenAddress, intervalId, mode, interval, startPrice, threshold }]
const userTrackers = new Map();

// ===============================
//   ТРЕКИНГ ЦЕНЫ
// ===============================

function startPriceTracking(userId, tokenAddress, interval) {
  if (!userTrackers.has(userId)) {
    userTrackers.set(userId, []);
  }

  const trackers = userTrackers.get(userId);

  // Ограничение: максимум 5 монет
  if (trackers.length >= 5) {
    return false;
  }

  // Сразу отправляем цену
  sendPrice(userId, tokenAddress);

  const intervalId = setInterval(() => {
    sendPrice(userId, tokenAddress);
  }, interval);

  trackers.push({ 
    tokenAddress, 
    intervalId, 
    mode: 'price',
    interval 
  });
  return true;
}

async function sendPrice(userId, tokenAddress) {
  const data = await getTokenPrice(tokenAddress);
  if (!data) return;

  try {
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
        ]).reply_markup
      }
    );
  } catch (error) {
    console.error("Send error:", error.message);
  }
}

// ===============================
//   ТРЕКИНГ ALERT-ОВ НА %
// ===============================

function startAlertTracking(userId, tokenAddress, threshold, checkInterval) {
  if (!userTrackers.has(userId)) {
    userTrackers.set(userId, []);
  }

  const trackers = userTrackers.get(userId);

  // Ограничение: максимум 5 монет
  if (trackers.length >= 5) {
    return false;
  }

  let startPrice = null;
  let lastAlertTime = 0;

  const intervalId = setInterval(async () => {
    const data = await getTokenPrice(tokenAddress);
    if (!data) return;

    // При первой проверке устанавливаем стартовую цену
    if (startPrice === null) {
      startPrice = data.price;
      return;
    }

    const priceChange = ((data.price - startPrice) / startPrice) * 100;

    // Проверяем достиг ли мы порога (с cooldown 5 минут)
    if (Math.abs(priceChange) >= Math.abs(threshold) && Date.now() - lastAlertTime > 300000) {
      const direction = priceChange > 0 ? '📈 РОСТ' : '📉 ПАДЕНИЕ';
      const emoji = priceChange > 0 ? '🟢' : '🔴';

      const message = `
${emoji} *ALERT: ${data.name}* ${direction}!

💰 Цена: $${data.price.toFixed(8)}
📊 Изменение: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%
🎯 Порог: ${threshold > 0 ? '+' : ''}${threshold}%
📈 Volume 24h: $${(data.volume24h / 1_000_000).toFixed(2)}M

⏰ ${new Date().toLocaleTimeString('ru-RU')}
      `.trim();

      try {
        await bot.telegram.sendMessage(
          userId,
          message,
          {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.url('📊 GeckoTerminal',
                  `https://www.geckoterminal.com/ton/tokens/${tokenAddress}`),
                Markup.button.callback('⏹ Стоп alert', `stop_${tokenAddress}`)
              ]
            ]).reply_markup
          }
        );
        lastAlertTime = Date.now();
        startPrice = data.price; // Сбрасываем стартовую цену после alert
      } catch (error) {
        console.error("Send alert error:", error.message);
      }
    }
  }, checkInterval);

  trackers.push({ 
    tokenAddress, 
    intervalId, 
    mode: 'alert',
    checkInterval,
    threshold
  });
  return true;
}

// ===============================
//   КОМАНДЫ БОТА
// ===============================

bot.start((ctx) => {
  ctx.reply(
    '👋 *TON Token Tracker Bot*\n\n' +
    '📊 *Режим 1: Отслеживание цены*\n' +
    'Получай цену каждые 30 сек - 1 час\n\n' +
    '📈 *Режим 2: Alert на % изменение*\n' +
    'Уведомления когда цена изменится на 5%, 10%, 25%, 100%\n' +
    'С интервалами: 30 сек - 24 часа\n\n' +
    '🔥 *Можно отслеживать до 5 монет одновременно*\n\n' +
    '_Просто введи адрес контракта токена_',
    { parse_mode: 'Markdown' }
  );
});

// ===============================
//   ОБРАБОТКА АДРЕСА ТОКЕНА
// ===============================

bot.on('text', async (ctx) => {
  const address = ctx.message.text.trim();
  const userId = ctx.from.id;

  if (address.length < 30) {
    return ctx.reply('❌ Адрес слишком короткий');
  }

  ctx.reply('⏳ Проверяю токен...');
  const tokenData = await getTokenPrice(address);

  if (!tokenData) {
    return ctx.reply(
      '❌ Токен не найден или у него нет пула\n\n' +
      'Проверь:\n' +
      '• Правильность адреса\n' +
      '• Наличие ликвидности\n' +
      '• GeckoTerminal API'
    );
  }

  // Выбор режима: отслеживание цены или alert на % изменение
  ctx.reply(
    `✅ *${tokenData.name}* найден!\n\n` +
    `Текущая цена: $${tokenData.price.toFixed(8)}\n\n` +
    'Выбери режим:',
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📊 Отслеживание цены', `mode_price_${address}`)],
        [Markup.button.callback('📈 Alert на % изменение', `mode_alert_${address}`)],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ]).reply_markup
    }
  );
});

// ===============================
//   ВЫБОР РЕЖИМА
// ===============================

// РЕЖИМ 1: Отслеживание цены
bot.action(/^mode_price_(.+)$/, (ctx) => {
  const address = ctx.match[1];

  ctx.editMessageText(
    'Выбери интервал для отслеживания цены:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('⚡ 30 сек', `interval_price_${address}_30000`)],
        [Markup.button.callback('1️⃣ 1 мин', `interval_price_${address}_60000`)],
        [Markup.button.callback('5️⃣ 5 мин', `interval_price_${address}_300000`)],
        [Markup.button.callback('1️⃣5️⃣ 15 мин', `interval_price_${address}_900000`)],
        [Markup.button.callback('3️⃣0️⃣ 30 мин', `interval_price_${address}_1800000`)],
        [Markup.button.callback('⏰ 1 час', `interval_price_${address}_3600000`)],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ]).reply_markup
    }
  );
});

// РЕЖИМ 2: Alert на % изменение
bot.action(/^mode_alert_(.+)$/, (ctx) => {
  const address = ctx.match[1];

  ctx.editMessageText(
    'Выбери на сколько процентов отправлять alert:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('5️⃣ ±5%', `threshold_${address}_5`)],
        [Markup.button.callback('1️⃣0️⃣ ±10%', `threshold_${address}_10`)],
        [Markup.button.callback('2️⃣5️⃣ ±25%', `threshold_${address}_25`)],
        [Markup.button.callback('💯 ±100% (2x)', `threshold_${address}_100`)],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ]).reply_markup
    }
  );
});

// ===============================
//   ИНТЕРВАЛЫ ДЛЯ ALERT-ОВ
// ===============================

bot.action(/^threshold_(.+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const threshold = parseInt(ctx.match[2]);

  ctx.editMessageText(
    'Выбери интервал проверки (как на GeckoTerminal):',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('⚡ 30 сек', `check_interval_${address}_${threshold}_30000`)],
        [Markup.button.callback('1️⃣ 1 мин', `check_interval_${address}_${threshold}_60000`)],
        [Markup.button.callback('5️⃣ 5 мин', `check_interval_${address}_${threshold}_300000`)],
        [Markup.button.callback('1️⃣5️⃣ 15 мин', `check_interval_${address}_${threshold}_900000`)],
        [Markup.button.callback('⏰ 1 час', `check_interval_${address}_${threshold}_3600000`)],
        [Markup.button.callback('⌚ 2 часа', `check_interval_${address}_${threshold}_7200000`)],
        [Markup.button.callback('⌚ 4 часа', `check_interval_${address}_${threshold}_14400000`)],
        [Markup.button.callback('⌚ 8 часов', `check_interval_${address}_${threshold}_28800000`)],
        [Markup.button.callback('⌚ 12 часов', `check_interval_${address}_${threshold}_43200000`)],
        [Markup.button.callback('📅 24 часа', `check_interval_${address}_${threshold}_86400000`)],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ]).reply_markup
    }
  );
});

// ===============================
//   CALLBACKS - ИНТЕРВАЛЫ ЦЕНЫ
// ===============================

bot.action(/^interval_price_(.+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const interval = parseInt(ctx.match[2]);
  const userId = ctx.from.id;

  const ok = startPriceTracking(userId, address, interval);

  if (!ok) {
    return ctx.answerCbQuery("❌ Можно отслеживать максимум 5 монет");
  }

  const intervalName = {
    30000: '30 сек',
    60000: '1 мин',
    300000: '5 мин',
    900000: '15 мин',
    1800000: '30 мин',
    3600000: '1 час'
  }[interval];

  ctx.answerCbQuery(`🚀 Отслеживание: ${intervalName}`);

  ctx.editMessageText(
    `🔥 Отслеживание цены запущено!\n\n` +
    `Интервал: *${intervalName}*\n` +
    `Активных монет: *${userTrackers.get(userId).length}/5*\n\n` +
    `Используй /stop чтобы остановить все отслеживания`,
    { parse_mode: 'Markdown' }
  );
});

// ===============================
//   CALLBACKS - ИНТЕРВАЛЫ ALERT-ОВ
// ===============================

bot.action(/^check_interval_(.+)_(\d+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const threshold = parseInt(ctx.match[2]);
  const checkInterval = parseInt(ctx.match[3]);
  const userId = ctx.from.id;

  const ok = startAlertTracking(userId, address, threshold, checkInterval);

  if (!ok) {
    return ctx.answerCbQuery("❌ Можно отслеживать максимум 5 монет");
  }

  const checkIntervalName = {
    30000: '30 сек',
    60000: '1 мин',
    300000: '5 мин',
    900000: '15 мин',
    3600000: '1 час',
    7200000: '2 часа',
    14400000: '4 часа',
    28800000: '8 часов',
    43200000: '12 часов',
    86400000: '24 часа'
  }[checkInterval];

  ctx.answerCbQuery(`🚀 Alert активирован: ±${threshold}% каждые ${checkIntervalName}`);

  ctx.editMessageText(
    `🔥 Alert запущен!\n\n` +
    `Порог: *±${threshold}%*\n` +
    `Проверка: *каждые ${checkIntervalName}*\n` +
    `Активных монет: *${userTrackers.get(userId).length}/5*\n\n` +
    `Используй /stop чтобы остановить все отслеживания`,
    { parse_mode: 'Markdown' }
  );
});

// ===============================
//   ОСТАНОВКА
// ===============================

bot.action('cancel', (ctx) => {
  ctx.answerCbQuery('❌ Отменено');
  ctx.deleteMessage();
});

bot.action(/^stop_(.+)$/, (ctx) => {
  const tokenAddress = ctx.match[1];
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    const trackers = userTrackers.get(userId);
    const index = trackers.findIndex(t => t.tokenAddress === tokenAddress);
    
    if (index !== -1) {
      clearInterval(trackers[index].intervalId);
      trackers.splice(index, 1);
    }

    if (trackers.length === 0) {
      userTrackers.delete(userId);
    }
  }

  ctx.answerCbQuery('⏹ Остановлено');
  ctx.deleteMessage();
});

// /stop command - останавливает ВСЕ отслеживания
bot.command('stop', (ctx) => {
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    const trackers = userTrackers.get(userId);
    trackers.forEach(t => clearInterval(t.intervalId));
    userTrackers.delete(userId);
    ctx.reply('⏹ Все отслеживания остановлены');
  } else {
    ctx.reply('❌ Нет активных отслеживаний');
  }
});

// ===============================
//   ЗАПУСК БОТА
// ===============================

bot.launch({
  polling: { allowed_updates: ['message', 'callback_query'] }
});

console.log('✅ Bot запущен!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));