const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===============================
//   ADMIN CONFIG
// ===============================

const ADMIN_ID = 6416674929;

// userId → 'approved' | 'blocked' | 'pending'
const users = new Map();

// userId → { username, firstName, requestedAt }
const userInfo = new Map();

function isAdmin(id) {
  return id === ADMIN_ID;
}

function isApproved(id) {
  if (isAdmin(id)) return true;
  return users.get(id) === 'approved';
}

function isBlocked(id) {
  return users.get(id) === 'blocked';
}

// ===============================
//   STATE + TRACKERS
// ===============================

const userState = new Map();
const userTrackers = new Map();

// ===============================
//   TOKEN PRICE API
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

  } catch (err) {
    console.error("API error:", err.message);
    return null;
  }
}

// ===============================
//   FORMAT OUTPUT
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
//   TRACKING
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
      const emoji = change > 0 ? '🟢📈' : '🔴📉';
      await bot.telegram.sendMessage(
        userId,
        `${emoji} *ALERT: ${data.name}*\n\n` +
        `💰 Цена: $${data.price.toFixed(8)}\n` +
        `📊 Изменение: ${change > 0 ? '+' : ''}${change.toFixed(2)}%\n` +
        `🎯 Порог: ±${threshold}%\n\n` +
        `⏰ ${new Date().toLocaleTimeString('ru-RU')}`,
        { parse_mode: "Markdown" }
      );
      startPrice = data.price;
    }
  }, interval);

  trackers.push({ tokenAddress: address, intervalId, mode: "alert", threshold, interval });
  return true;
}

// ===============================
//   ADMIN NOTIFY
// ===============================

async function notifyAdminNewUser(user) {
  const username = user.username ? `@${user.username}` : '(без username)';
  const name = user.first_name || '';

  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `👤 *Новый пользователь!*\n\n` +
      `Имя: ${name}\n` +
      `Username: ${username}\n` +
      `ID: \`${user.id}\``,
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
    console.error("Notify admin error:", err.message);
  }
}

// ===============================
//   /start
// ===============================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const user = ctx.from;

  if (isBlocked(userId)) return;

  if (isApproved(userId)) {
    return ctx.reply(
      "👋 *TON Token Tracker Bot*\n\n" +
      "Введи адрес токена TON.\n" +
      "Дальше бот спросит:\n" +
      "• режим (1 или 2)\n" +
      "• порог (%)\n" +
      "• интервал (мс)\n\n" +
      "🔥 Всё вручную. Работает идеально.",
      { parse_mode: "Markdown" }
    );
  }

  if (!users.has(userId)) {
    users.set(userId, 'pending');
    userInfo.set(userId, {
      username: user.username || null,
      firstName: user.first_name || '',
      requestedAt: new Date()
    });

    await notifyAdminNewUser(user);

    return ctx.reply(
      "⏳ Твоя заявка отправлена администратору.\n\n" +
      "Ожидай подтверждения."
    );
  }

  if (users.get(userId) === 'pending') {
    return ctx.reply("⏳ Твоя заявка уже отправлена. Ожидай.");
  }
});

// ===============================
//   APPROVE / BLOCK
// ===============================

bot.action(/^approve_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа');

  const targetId = parseInt(ctx.match[1]);

  if (users.get(targetId) === 'approved') {
    return ctx.answerCbQuery('Уже одобрен');
  }

  users.set(targetId, 'approved');

  await ctx.answerCbQuery('✅ Одобрено');
  await ctx.editMessageText(
    ctx.callbackQuery.message.text + '\n\n✅ *Одобрен*',
    { parse_mode: 'Markdown' }
  );

  try {
    await bot.telegram.sendMessage(
      targetId,
      "✅ Твоя заявка одобрена! Теперь можешь пользоваться ботом.\n\nВведи адрес токена TON:"
    );
  } catch (err) {
    console.error("Notify user error:", err.message);
  }
});

bot.action(/^block_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа');

  const targetId = parseInt(ctx.match[1]);

  if (users.get(targetId) === 'blocked') {
    return ctx.answerCbQuery('Уже заблокирован');
  }

  users.set(targetId, 'blocked');

  await ctx.answerCbQuery('🚫 Заблокирован');
  await ctx.editMessageText(
    ctx.callbackQuery.message.text + '\n\n🚫 *Заблокирован*',
    { parse_mode: 'Markdown' }
  );
});

// ===============================
//   ADMIN COMMAND
// ===============================

bot.hears(/devbygemsbuyer/i, async (ctx) => {
  try {
    const userId = ctx.from.id;
    if (!isAdmin(userId)) return;

    const allUsers = [...userInfo.entries()];

    if (allUsers.length === 0) {
      return ctx.reply('📭 Нет пользователей.');
    }

    let text = '👥 *Список пользователей:*\n\n';
    const buttons = [];

    allUsers.forEach(([id, info], index) => {
      const username = info.username ? `@${info.username}` : `(без username)`;
      const status = users.get(id);
      const statusEmoji =
        status === 'approved' ? '✅' :
        status === 'blocked' ? '🚫' :
        '⏳';

      text += `${index + 1}. ${username} — \`${id}\` ${statusEmoji}\n`;

      buttons.push([
        Markup.button.callback(
          `${index + 1}. ${username}`,
          `manage_${id}`
        )
      ]);
    });

    return ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    });

  } catch (err) {
    console.error("Admin command error:", err);
  }
});

// ===============================
//   MANAGE USER
// ===============================

bot.action(/^manage_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ Нет доступа');

  const targetId = parseInt(ctx.match[1]);
  const info = userInfo.get(targetId);
  const status = users.get(targetId);

  const username = info?.username ? `@${info.username}` : `(без username)`;
  const statusText =
    status === 'approved' ? '✅ Одобрен' :
    status === 'blocked' ? '🚫 Заблокирован' :
    '⏳ Ожидает';

  await ctx.answerCbQuery();
  await ctx.reply(
    `👤 *Пользователь:* ${username}\n` +
    `🆔 ID: \`${targetId}\`\n` +
    `Статус: ${statusText}`,
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
//   MIDDLEWARE
// ===============================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;

  if (ctx.callbackQuery) return next();

  const text = ctx.message?.text?.trim();
  if (!text) return next();

  if (text === '/start') return next();
  if (/devbygemsbuyer/i.test(text)) return next();

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
//   /cancel
// ===============================

bot.command("cancel", (ctx) => {
  const userId = ctx.from.id;
  if (!isApproved(userId)) return;

  if (userState.has(userId)) {
    userState.delete(userId);
    return ctx.reply("❌ Действие отменено.");
  }

  ctx.reply("Нет активного действия.");
});

// ===============================
//   /stop
// ===============================

bot.command("stop", (ctx) => {
  const userId = ctx.from.id;
  if (!isApproved(userId)) return;

  if (!userTrackers.has(userId)) {
    return ctx.reply("❌ У тебя нет активных отслеживаний.");
  }

  userTrackers.get(userId).forEach(t => clearInterval(t.intervalId));
  userTrackers.delete(userId);
  ctx.reply("⏹ Все отслеживания остановлены.");
});

// ===============================
//   /help
// ===============================

bot.command("help", (ctx) => {
  const userId = ctx.from.id;
  if (!isApproved(userId)) return;

  ctx.reply(
    "📘 *Команды бота:*\n\n" +
    "/start — начать\n" +
    "/help — помощь\n" +
    "/cancel — отменить действие\n" +
    "/stop — остановить отслеживания\n\n" +
    "Просто введи адрес токена TON.",
    { parse_mode: "Markdown" }
  );
});

// ===============================
//   TEXT HANDLER
// ===============================

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text.trim();

  if (/devbygemsbuyer/i.test(msg)) return;

  if (!isApproved(userId)) return;

  if (userState.has(userId)) {
    const state = userState.get(userId);

    if (state.step === 2) {
      if (msg === "1" || msg.toLowerCase() === "price") {
        state.mode = "price";
        state.step = 3;
        return ctx.reply(
          "Введи интервал (мс):\n\n" +
          "30000 — 30 сек\n" +
          "60000 — 1 мин\n" +
          "300000 — 5 мин\n" +
          "900000 — 15 мин\n" +
          "1800000 — 30 мин\n" +
          "3600000 — 1 час"
        );
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
        return ctx.reply(
          "Теперь введи интервал (мс):\n\n" +
          "30000 — 30 сек\n" +
          "60000 — 1 мин\n" +
          "300000 — 5 мин\n" +
          "900000 — 15 мин\n" +
          "3600000 — 1 час\n" +
          "7200000 — 2 часа\n" +
          "14400000 — 4 часа\n" +
          "28800000 — 8 часов\n" +
          "43200000 — 12 часов\n" +
          "86400000 — 24 часа"
        );
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

  // TOKEN ADDRESS
  if (/^[A-Za-z0-9]{48,}$/.test(msg)) {
    ctx.reply("⏳ Проверяю токен...");

    const data = await getTokenPrice(msg);
    if (!data) return ctx.reply("❌ Токен не найден");

    ctx.reply(
      `✅ *${data.name}* найден!\nЦена: $${data.price.toFixed(8)}\n\n` +
      "Выбери режим:\n1 — отслеживание цены\n2 — alert на % изменение",
      { parse_mode: "Markdown" }
    );

    userState.set(userId, { step: 2, address: msg, mode: null, threshold: null });
    return;
  }

  ctx.reply("Введи адрес токена TON");
});

// ===============================
//   KEEPALIVE + START
// ===============================

setInterval(() => console.log("💓 keepalive"), 20000);

bot.launch();
console.log("🚀 Bot запущен (Railway-friendly)");
