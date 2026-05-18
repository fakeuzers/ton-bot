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
function formatTokenBlock(data, address) {
  const emoji = data.change24h > 0 ? '📈' : '📉';
  const arrow = data.change24h > 0 ? '🟢' : '🔴';

  return `
${emoji} *${data.name}* (${data.symbol}) ${arrow}
💰 Цена: $${data.price.toFixed(8)}
📊 24h: ${data.change24h > 0 ? '+' : ''}${data.change24h.toFixed(2)}%
💎 Ликвидность: $${(data.liquidity / 1_000_000).toFixed(2)}M
📈 Volume 24h: $${(data.volume24h / 1_000_000).toFixed(2)}M
🔗 https://www.geckoterminal.com/ton/tokens/${address}
`;
}

// ===============================
//   МУЛЬТИ-ТРЕКИНГ (1–5 монет)
// ===============================

// userId → { tokens: [address], intervalId }
const userTrackers = new Map();

async function sendCombinedMessage(userId) {
  const tracker = userTrackers.get(userId);
  if (!tracker || tracker.tokens.length === 0) return;

  let text = `🔥 *Обновление по ${tracker.tokens.length} токенам*\n\n`;

  for (const address of tracker.tokens) {
    const data = await getTokenPrice(address);
    if (data) text += formatTokenBlock(data, address) + "\n";
  }

  text += `⏰ ${new Date().toLocaleTimeString('ru-RU')}`;

  try {
    await bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error("Send error:", e.message);
  }
}

function startTracking(userId, tokenAddress, interval) {
  if (!userTrackers.has(userId)) {
    userTrackers.set(userId, { tokens: [], intervalId: null });
  }

  const tracker = userTrackers.get(userId);

  if (tracker.tokens.includes(tokenAddress)) return true;

  if (tracker.tokens.length >= 5) return false;

  tracker.tokens.push(tokenAddress);

  if (tracker.intervalId) clearInterval(tracker.intervalId);

  tracker.intervalId = setInterval(() => {
    sendCombinedMessage(userId);
  }, interval);

  sendCombinedMessage(userId);

  return true;
}

// ===============================
//   КОМАНДЫ БОТА
// ===============================
bot.start((ctx) => {
  ctx.reply(
    '👋 *TON Token Tracker Bot*\n\n' +
    '📊 Отслеживаю цену мемкойнов каждые 30 сек — 1 час\n' +
    '🔥 Теперь можно отслеживать до *5 монет одновременно*\n' +
    '📦 Все монеты приходят *одним сообщением*\n\n' +
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

  const ok = startTracking(userId, address, interval);

  if (!ok) {
    return ctx.answerCbQuery("❌ Можно отслеживать максимум 5 монет");
  }

  const names = {
    30000: '30 сек',
    60000: '1 мин',
    120000: '2 мин',
    300000: '5 мин',
    900000: '15 мин',
    1800000: '30 мин',
    3600000: '1 час'
  };

  ctx.answerCbQuery(`🚀 Добавлено: ${names[interval]}`);

  ctx.editMessageText(
    `🔥 Монета добавлена в отслеживание!\n\n` +
    `Интервал: *${names[interval]}*\n` +
    `Активных монет: *${userTrackers.get(userId).tokens.length}/5*\n\n` +
    `Используй /stop чтобы остановить все отслеживания`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('cancel', (ctx) => {
  ctx.answerCbQuery('❌ Отменено');
  ctx.deleteMessage();
});

bot.command('stop', (ctx) => {
  const userId = ctx.from.id;

  if (userTrackers.has(userId)) {
    const tracker = userTrackers.get(userId);
    if (tracker.intervalId) clearInterval(tracker.intervalId);
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
