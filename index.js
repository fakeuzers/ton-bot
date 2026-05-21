cat > /mnt/user-data/outputs/index.js << 'ENDOFFILE'
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   CONFIG
// ===============================

const ADMIN_ID = 6416674929;
const MAX_TRACKERS = 5;

// ===============================
//   ХРАНИЛИЩА
// ===============================

const userState = new Map();    // userId → состояние диалога
const userTrackers = new Map(); // userId → [tracker]
const users = new Map();        // userId → 'approved' | 'blocked' | 'pending'
const userInfo = new Map();     // userId → { username, firstName }

// ===============================
//   ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ===============================

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAdmin(id) { return id === ADMIN_ID; }
function isApproved(id) { return isAdmin(id) || users.get(id) === 'approved'; }
function isBlocked(id) { return users.get(id) === 'blocked'; }

// ===============================
//   ПОИСК ТОКЕНА
// ===============================

async function searchToken(query) {
  try {
    // Если адрес TON — возвращаем сразу
    if (query.startsWith('EQ') || query.startsWith('UQ')) {
      return query;
    }

    // Поиск по названию через GeckoTerminal
    const url = `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=ton`;
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { accept: 'application/json' }
    });

    const pools = response.data?.data;
    if (!Array.isArray(pools) || pools.length === 0) return null;

    // Фильтруем только TON сеть
    const tonPools = pools.filter(pool => {
      const networkId = pool.relationships?.network?.data?.id || '';
      return networkId.toLowerCase().includes('ton');
    });

    if (!tonPools.length) return null;

    // Берём пул с наибольшей ликвидностью
    tonPools.sort((a, b) =>
      Number(b.attributes?.reserve_in_usd || 0) - Number(a.attributes?.reserve_in_usd || 0)
    );

    // Извлекаем адрес base_token (формат "ton/ADDRESS")
    const tokenId = tonPools[0].relationships?.base_token?.data?.id || '';
    const address = tokenId.includes('/') ? tokenId.split('/')[1] : tokenId;

    return address || null;

  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    return null;
  }
}

// ===============================
//   ПОЛУЧЕНИЕ ЦЕНЫ ТОКЕНА
// ===============================

async function getTokenPrice(address, retry = 0) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${address}/pools?page=1`;
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { accept: 'application/json' }
    });

    const pools = response.data?.data;
    if (!Array.isArray(pools) || pools.length === 0) return null;

    // Берём пул с наибольшей ликвидностью
    const sorted = pools.sort((a, b) =>
      Number(b.attributes?.reserve_in_usd || 0) - Number(a.attributes?.reserve_in_usd || 0)
    );

    const pool = sorted[0]?.attributes;
    if (!pool) return null;

    // Название токена из имени пула (формат "TOKEN / USDT")
    const tokenName = pool.name?.split('/')[0]?.trim() || 'Unknown';

    const price = Number(pool.base_token_price_usd || pool.token_price_usd || 0);

    return {
      price,
      change24h: Number(pool.price_change_percentage?.h24 || 0),
      volume24h: Number(pool.volume_usd?.h24 || 0),
      liquidity: Number(pool.reserve_in_usd || 0),
      name: tokenName,
      symbol: tokenName.toUpperCase().slice(0, 6)
    };

  } catch (err) {
    if (err.response?.status === 429) {
      console.log('Rate limit, waiting...');
      await sleep(10000);
      if (retry < 3) return getTokenPrice(address, retry + 1);
    }
    console.error('Price error:', err.response?.data || err.message);
    return null;
  }
}

// ===============================
//   ФОРМАТИРОВАНИЕ СООБЩЕНИЯ
// ===============================

function formatPrice(data) {
  const trend = data.change24h >= 0 ? '📈' : '📉';
  const dot = data.change24h >= 0 ? '🟢' : '🔴';

  return (
    `${trend} *${data.name}* (${data.symbol})\n\n` +
    `💰 Цена: \`$${data.price.toFixed(8)}\`\n` +
    `${dot} 24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%\n` +
    `💎 Ликвидность: $${(data.liquidity / 1_000_000).toFixed(2)}M\n` +
    `📊 Объём: $${(data.volume24h / 1_000_000).toFixed(2)}M\n\n` +
    `⏰ ${new Date().toLocaleTimeString('ru-RU')}`
  );
}

// ===============================
//   ЦИКЛ ТРЕКИНГА
// ===============================

async function startTrackingLoop(tracker) {
  while (tracker.active) {
    try {
      const data = await getTokenPrice(tracker.address);

      if (data) {
        if (tracker.mode === 'price') {
          await bot.telegram.sendMessage(tracker.userId, formatPrice(data), {
            parse_mode: 'Markdown'
          });
        }

        if (tracker.mode === 'alert') {
          if (tracker.startPrice === null) {
            tracker.startPrice = data.price;
          } else {
            const change = ((data.price - tracker.startPrice) / tracker.startPrice) * 100;
            if (Math.abs(change) >= tracker.threshold) {
              const emoji = change >= 0 ? '🟢📈' : '🔴📉';
              await bot.telegram.sendMessage(
                tracker.userId,
                `🚨 *ALERT: ${data.name}*\n\n` +
                `${emoji} Изменение: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n` +
                `💰 Цена: \`$${data.price.toFixed(8)}\`\n` +
                `🎯 Порог: ±${tracker.threshold}%\n\n` +
                `⏰ ${new Date().toLocaleTimeString('ru-RU')}`,
                { parse_mode: 'Markdown' }
              );
              tracker.startPrice = data.price;
            }
          }
        }
      }
    } catch (err) {
      console.error('Tracking error:', err.message);
    }

    await sleep(tracker.interval);
  }
}

// ===============================
//   УВЕДОМЛЕНИЕ АДМИНУ О НОВОМ ЮЗЕРЕ
// ===============================

async function notifyAdmin(user) {
  const username = user.username ? `@${user.username}` : '(нет username)';
  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `👤 *Новый пользователь!*\n\nИмя: ${user.first_name || ''}\nUsername: ${username}\nID: \`${user.id}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Одобрить', `approve_${user.id}`),
            Markup.button.callback('🚫 Заблокировать', `block_${user.id}`)
          ]
        ]).reply_markup
      }
    );
  } catch (err) {
    console.error('Notify admin error:', err.message);
  }
}

// ===============================
//   /start
// ===============================

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  if (isBlocked(userId)) return;

  if (isApproved(userId)) {
    return ctx.reply(
      '🚀 *TON Tracker Bot*\n\n' +
      'Введи адрес токена или название:\n\n' +
      'Примеры:\n' +
      '`EQBZ_cafPyDr5KUTs0aNxh0ZTDhkpEZONmLJA2SNGlLm4Cko`\n' +
      '`DOGS`\n`NOT`\n`PEPE`\n\n' +
      'Команды: /stop /status /help',
      { parse_mode: 'Markdown' }
    );
  }

  if (!users.has(userId)) {
    users.set(userId, 'pending');
    userInfo.set(userId, {
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || ''
    });
    await notifyAdmin(ctx.from);
    return ctx.reply('⏳ Заявка отправлена администратору. Ожидай одобрения!');
  }

  if (users.get(userId) === 'pending') {
    return ctx.reply('⏳ Твоя заявка ещё рассматривается. Ожидай!');
  }
});

// ===============================
//   ОДОБРЕНИЕ / БЛОКИРОВКА
// ===============================

bot.action(/^approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа');
  const targetId = parseInt(ctx.match[1]);
  users.set(targetId, 'approved');
  await ctx.answerCbQuery('✅ Одобрен');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Одобрен', { parse_mode: 'Markdown' });
  try {
    await bot.telegram.sendMessage(targetId, '✅ Тебя одобрили! Теперь можешь пользоваться ботом.\n\nВведи адрес токена или название:');
  } catch (e) {}
});

bot.action(/^block_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа');
  const targetId = parseInt(ctx.match[1]);
  users.set(targetId, 'blocked');
  await ctx.answerCbQuery('🚫 Заблокирован');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n🚫 Заблокирован', { parse_mode: 'Markdown' });
});

// ===============================
//   УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ (только для управления через список)
// ===============================

bot.action(/^manage_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа');
  const targetId = parseInt(ctx.match[1]);
  const info = userInfo.get(targetId);
  const status = users.get(targetId);
  const username = info?.username ? `@${info.username}` : '(нет username)';
  const statusText = status === 'approved' ? '✅ Одобрен' : status === 'blocked' ? '🚫 Заблокирован' : '⏳ Ожидает';

  await ctx.answerCbQuery();
  await ctx.reply(
    `👤 *${username}*\nID: \`${targetId}\`\nСтатус: ${statusText}`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Одобрить', `approve_${targetId}`),
          Markup.button.callback('🚫 Заблокировать', `block_${targetId}`)
        ]
      ]).reply_markup
    }
  );
});

// ===============================
//   MIDDLEWARE: ПРОВЕРКА ДОСТУПА
// ===============================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();
  if (ctx.callbackQuery) return next();

  const text = ctx.message?.text?.trim();

  // Всегда пропускаем эти
  if (text === '/start' || text === '..devbygemsbuyer') return next();

  if (isBlocked(userId)) return;

  if (!isApproved(userId)) {
    if (users.get(userId) === 'pending') {
      return ctx.reply('⏳ Ожидай одобрения администратора.');
    }
    return;
  }

  return next();
});

// ===============================
//   СКРЫТАЯ ADMIN КОМАНДА
// ===============================

bot.hears('..devbygemsbuyer', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const all = [...userInfo.entries()];
  if (all.length === 0) return ctx.reply('📭 Нет пользователей.');

  let text = '👥 *Пользователи бота:*\n\n';
  const buttons = [];

  all.forEach(([id, info], i) => {
    const username = info.username ? `@${info.username}` : '(нет username)';
    const status = users.get(id);
    const emoji = status === 'approved' ? '✅' : status === 'blocked' ? '🚫' : '⏳';
    text += `${i + 1}. ${username} — \`${id}\` ${emoji}\n`;
    buttons.push([Markup.button.callback(`${i + 1}. ${username} ${emoji}`, `manage_${id}`)]);
  });

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup
  });
});

// ===============================
//   КОМАНДЫ
// ===============================

bot.command('help', (ctx) => {
  ctx.reply(
    '📘 *Команды:*\n\n' +
    '/start — начать\n' +
    '/stop — остановить все трекеры\n' +
    '/status — активные трекеры\n' +
    '/cancel — отменить текущее действие\n' +
    '/help — помощь',
    { parse_mode: 'Markdown' }
  );
});

bot.command('cancel', (ctx) => {
  userState.delete(ctx.from.id);
  ctx.reply('❌ Отменено. Введи адрес или название токена:');
});

bot.command('status', (ctx) => {
  const trackers = userTrackers.get(ctx.from.id);
  if (!trackers || trackers.length === 0) return ctx.reply('❌ Нет активных трекеров');

  let text = '📡 *Активные трекеры:*\n\n';
  trackers.forEach((t, i) => {
    text += `${i + 1}. *${t.name}* | ${t.mode} | ${(t.interval / 1000).toFixed(0)}с\n`;
  });

  ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('stop', (ctx) => {
  const trackers = userTrackers.get(ctx.from.id);
  if (!trackers) return ctx.reply('❌ Нет активных трекеров');
  trackers.forEach(t => { t.active = false; });
  userTrackers.delete(ctx.from.id);
  ctx.reply('⛔ Все трекеры остановлены');
});

// ===============================
//   ОБРАБОТКА ТЕКСТА
// ===============================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text.trim();

  if (msg === '..devbygemsbuyer') return;

  // ШАГ 2 — выбор режима
  if (userState.has(userId)) {
    const state = userState.get(userId);

    if (state.step === 2) {
      if (msg === '1') {
        state.mode = 'price';
        state.step = 3;
        return ctx.reply(
          '⏰ Введи интервал:\n\n' +
          '`5000` — 5 сек\n' +
          '`30000` — 30 сек\n' +
          '`60000` — 1 мин\n' +
          '`300000` — 5 мин\n' +
          '`900000` — 15 мин\n' +
          '`1800000` — 30 мин\n' +
          '`3600000` — 1 час',
          { parse_mode: 'Markdown' }
        );
      }
      if (msg === '2') {
        state.mode = 'alert';
        state.step = 3;
        return ctx.reply('📊 Введи порог (%):\n`5`\n`10`\n`25`\n`50`\n`100`', { parse_mode: 'Markdown' });
      }
      return ctx.reply('Введи 1 или 2');
    }

    // ШАГ 3 — порог (только для alert)
    if (state.step === 3 && state.mode === 'alert' && !state.threshold) {
      const t = parseFloat(msg);
      if (isNaN(t) || t <= 0) return ctx.reply('Введи число больше 0');
      state.threshold = t;
      state.step = 4;
      return ctx.reply(
        '⏰ Введи интервал проверки:\n\n' +
        '`30000` — 30 сек\n' +
        '`60000` — 1 мин\n' +
        '`300000` — 5 мин\n' +
        '`900000` — 15 мин\n' +
        '`3600000` — 1 час\n' +
        '`7200000` — 2 часа\n' +
        '`14400000` — 4 часа\n' +
        '`28800000` — 8 часов\n' +
        '`43200000` — 12 часов\n' +
        '`86400000` — 24 часа',
        { parse_mode: 'Markdown' }
      );
    }

    // ШАГ 3/4 — интервал
    if ((state.step === 3 && state.mode === 'price') || state.step === 4) {
      let interval = parseInt(msg);
      if (isNaN(interval)) return ctx.reply('Введи число');
      if (interval < 5000) interval = 5000;

      if (!userTrackers.has(userId)) userTrackers.set(userId, []);
      const trackers = userTrackers.get(userId);

      if (trackers.length >= MAX_TRACKERS) return ctx.reply('❌ Максимум 5 трекеров');

      const tracker = {
        userId,
        address: state.address,
        name: state.name,
        mode: state.mode,
        threshold: state.threshold || 0,
        interval,
        active: true,
        startPrice: null
      };

      trackers.push(tracker);
      startTrackingLoop(tracker);

      ctx.reply(
        `✅ *Трекинг запущен!*\n\n` +
        `Монета: *${state.name}*\n` +
        `Режим: ${state.mode === 'price' ? '📊 Цена' : '🚨 Alert'}\n` +
        `Интервал: ${(interval / 1000).toFixed(0)} сек\n` +
        (state.mode === 'alert' ? `Порог: ±${state.threshold}%\n` : '') +
        `\nДля остановки: /stop`,
        { parse_mode: 'Markdown' }
      );

      userState.delete(userId);
      return;
    }
  }

  // ПОИСК ТОКЕНА
  await ctx.reply('🔍 Ищу токен...');

  const tokenAddress = await searchToken(msg);
  if (!tokenAddress) return ctx.reply('❌ Токен не найден. Проверь адрес или название.');

  const data = await getTokenPrice(tokenAddress);
  if (!data || data.price === 0) return ctx.reply('❌ Не удалось получить цену. Возможно нет ликвидности.');

  userState.set(userId, {
    step: 2,
    address: tokenAddress,
    name: data.name,
    mode: null,
    threshold: null
  });

  ctx.reply(
    `✅ *${data.name}* найден!\n\n` +
    `💰 Цена: \`$${data.price.toFixed(8)}\`\n` +
    `📊 24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%\n` +
    `💎 Ликвидность: $${(data.liquidity / 1_000_000).toFixed(2)}M\n\n` +
    `Выбери режим:\n` +
    `*1* — Price Tracking (цена по расписанию)\n` +
    `*2* — Alert Tracking (уведомление при % изменении)`,
    { parse_mode: 'Markdown' }
  );
});

// ===============================
//   ОБРАБОТКА ОШИБОК
// ===============================

process.on('unhandledRejection', err => console.error('Rejection:', err));
process.on('uncaughtException', err => console.error('Exception:', err));

// ===============================
//   ВЕБ-СЕРВЕР (для Render)
// ===============================

const app = express();
app.get('/', (_, res) => res.send('Bot is running ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// ===============================
//   ЗАПУСК
// ===============================

bot.launch();
console.log('🚀 Bot started!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
ENDOFFILE
echo "Done"