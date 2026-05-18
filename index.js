const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   ПОЛУЧЕНИЕ ДАННЫХ О ТОН-ТОКЕНЕ
// ===============================
async function getTokenPrice(address) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/simple/networks/ton/token_price/${address}`;
    const response = await axios.get(url, { timeout: 10000 });

    const data = response.data?.data?.attributes;
    if (!data) return null;

    return {
      price: Number(data.token_price_usd || 0),
      change24h: Number(data.price_change_percentage?.h24 || 0),
      volume24h: Number(data.volume_usd?.h24 || 0),
      liquidity: Number(data.reserve_in_usd || 0),
      name: data.name || "Unknown",
      symbol: (data.name || "???").toUpperCase().slice(0, 4)
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
//   ТРЕКИНГ
// ===============================
const userTrackers = new Map();

function startTracking(userId, tokenAddress, interval) {
  if (userTrackers.has(userId)) {
    clearInterval(userTrackers.get(userId).intervalId);
  }

  sendPrice(userId, tokenAddress);

  const intervalId = setInterval(() => {
    sendPrice(userId, tokenAddress);
  }, interval);

  userTrackers.set(userId, { tokenAddress, intervalId });
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
            Markup.button.callback('⏹ Стоп', `stop_${userId}`)
          ]
        ]).reply_markup
      }
    );
  } catch (error) {
    console.error("Send error:", error.message);
  }
}

// ===============================
//   КОМАНДЫ БОТА
// ===============================
bot.start((ctx) => {
  ctx.reply(
    '👋 *TON Token Tracker Bot*\n\n' +
    '📊 Отправляю цену мемкойна каждые 30 сек — 1 час\n\n' +
    '_Просто введи адрес контракта токена_',
    { parse_mode: 'Markdown' }
  );
});

bot.command('stop', (ctx) => {
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    clearInterval(userTrackers.get(userId).intervalId);
    userTrackers.delete(userId);
    ctx.reply('⏹ Отслеживание остановлено');
  } else {
    ctx.reply('❌ Нет активного отслеживания');
  }
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
      '❌ Токен не найден или API GeckoTerminal вернул пустой ответ\n\n' +
      'Это нормально — API часто падает.\n' +
      'Попробуй позже или другой токен.'
    );
  }

  ctx.reply(
    `✅ *${tokenData.name}* найден!\n\n` +
    `Текущая цена: $${tokenData.price.toFixed(8)}\n\n` +
    'Выбери интервал:',
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('⚡ 30 сек', `interval_${address}_30000`)],
        [Markup.button.callback('1️⃣ 1 мин', `interval_${address}_60000`)],
        [Markup.button.callback('2️⃣ 2 мин', `interval_${address}_120000`)],
        [Markup.button.callback('5️⃣ 5 мин', `interval_${address}_300000`)],
        [Markup.button.callback('🕒 15 мин', `interval_${address}_900000`)],
        [Markup.button.callback('🕧 30 мин', `interval_${address}_1800000`)],
        [Markup.button.callback('⏳ 1 час', `interval_${address}_3600000`)],
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ]).reply_markup
    }
  );
});

// ===============================
//   CALLBACKS
// ===============================
bot.action(/^interval_(.+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const interval = parseInt(ctx.match[2]);
  const userId = ctx.from.id;

  startTracking(userId, address, interval);

  const intervalName = {
    30000: '30 сек',
    60000: '1 мин',
    120000: '2 мин',
    300000: '5 мин',
    900000: '15 мин',
    1800000: '30 мин',
    3600000: '1 час'
  }[interval];

  ctx.answerCbQuery(`✅ Отслеживание ${intervalName}`);
  ctx.editMessageText(
    `🚀 *Отслеживание запущено!*\n\n` +
    `Интервал: ${intervalName}\n\n` +
    `Используй /stop чтобы остановить`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('cancel', (ctx) => {
  ctx.answerCbQuery('❌ Отменено');
  ctx.deleteMessage();
});

bot.action(/^stop_(.+)$/, (ctx) => {
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    clearInterval(userTrackers.get(userId).intervalId);
    userTrackers.delete(userId);
  }

  ctx.answerCbQuery('⏹ Остановлено');
  ctx.deleteMessage();
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
