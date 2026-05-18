const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

const API = 'https://api.geckoterminal.com/api/v2/networks/ton/tokens';

async function getTokenPrice(address) {
  try {
    const response = await axios.get(`${API}/${address}`, { timeout: 10000 });
    const data = response.data?.data?.attributes;
    
    if (data) {
      return {
        price: data.price_usd,
        name: data.name,
        symbol: data.symbol,
        change24h: data.price_change_percentage?.h24,
        marketCap: data.market_cap_usd,
        volume24h: data.volume_usd?.h24
      };
    }
  } catch (error) {
    return null;
  }
}

function formatPrice(data, address) {
  const emoji = data.change24h > 0 ? '📈' : '📉';
  const arrow = data.change24h > 0 ? '🟢' : '🔴';
  
  return `
${emoji} *${data.name}* (${data.symbol}) ${arrow}

💰 Цена: $${data.price.toFixed(8)}
📊 24h: ${data.change24h > 0 ? '+' : ''}${data.change24h.toFixed(2)}%
💎 Market Cap: $${(data.marketCap / 1000000).toFixed(2)}M
📈 Volume 24h: $${(data.volume24h / 1000000).toFixed(2)}M

⏰ ${new Date().toLocaleTimeString('ru-RU')}
  `.trim();
}

function startTracking(userId, tokenAddress, interval) {
  if (userTrackers.has(userId)) {
    const existing = userTrackers.get(userId);
    if (existing.intervalId) clearInterval(existing.intervalId);
  }

  sendPrice(userId, tokenAddress);

  const intervalId = setInterval(() => {
    sendPrice(userId, tokenAddress);
  }, interval);

  userTrackers.set(userId, { tokenAddress, interval, intervalId });
}

async function sendPrice(userId, tokenAddress) {
  const data = await getTokenPrice(tokenAddress);
  
  if (data) {
    try {
      await bot.telegram.sendMessage(
        userId,
        formatPrice(data, tokenAddress),
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
      console.error(`Error: ${error.message}`);
    }
  }
}

const userTrackers = new Map();

bot.start((ctx) => {
  ctx.reply(
    '👋 *TON Token Tracker Bot*\n\n' +
    '📊 Отправляю цену мемкойна каждую минуту\n\n' +
    '_Просто введи адрес контракта токена_',
    { parse_mode: 'Markdown' }
  );
});

bot.command('stop', (ctx) => {
  const userId = ctx.from.id;
  
  if (userTrackers.has(userId)) {
    const tracker = userTrackers.get(userId);
    clearInterval(tracker.intervalId);
    userTrackers.delete(userId);
    ctx.reply('⏹ Отслеживание остановлено');
  } else {
    ctx.reply('❌ Нет активного отслеживания');
  }
});

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
      '❌ Токен не найден\n\n' +
      'Проверь:\n' +
      '• Правильность адреса\n' +
      '• Наличие ликвидности\n' +
      '• Совместимость с GeckoTerminal'
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
        [Markup.button.callback('⏹ Отмена', 'cancel')]
      ]).reply_markup
    }
  );
});

bot.action(/^interval_(.+)_(\d+)$/, (ctx) => {
  const address = ctx.match[1];
  const interval = parseInt(ctx.match[2]);
  const userId = ctx.from.id;

  startTracking(userId, address, interval);

  const intervalName = {
    30000: '30 сек',
    60000: '1 мин',
    120000: '2 мин',
    300000: '5 мин'
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
    const tracker = userTrackers.get(userId);
    clearInterval(tracker.intervalId);
    userTrackers.delete(userId);
  }

  ctx.answerCbQuery('⏹ Остановлено');
  ctx.deleteMessage();
});

bot.launch({
  polling: { allowed_updates: ['message', 'callback_query'] }
});

console.log('✅ Bot запущен!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));