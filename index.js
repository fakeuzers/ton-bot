const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

// ===============================
// CONFIG
// ===============================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);

// ===============================
// DATABASE INIT
// ===============================
const db = new sqlite3.Database("./database.sqlite");

// Создаём таблицу пользователей
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    status TEXT,
    username TEXT,
    firstName TEXT,
    requestedAt TEXT
  )
`);

// Функция: получить пользователя
function getUser(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Функция: сохранить/обновить пользователя
function saveUser(user) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO users (id, status, username, firstName, requestedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        username = excluded.username,
        firstName = excluded.firstName,
        requestedAt = excluded.requestedAt
    `,
      [
        user.id,
        user.status,
        user.username,
        user.firstName,
        user.requestedAt,
      ],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// ===============================
// BOT LOGIC
// ===============================

bot.start(async (ctx) => {
  const id = ctx.from.id;
  const username = ctx.from.username || "";
  const firstName = ctx.from.first_name || "";

  const existing = await getUser(id);

  if (!existing) {
    await saveUser({
      id,
      status: "pending",
      username,
      firstName,
      requestedAt: new Date().toISOString(),
    });

    await ctx.reply("🔐 Заявка отправлена админу.");
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `📥 Новый пользователь:\nID: ${id}\n@${username}\n${firstName}`
    );
  } else {
    await ctx.reply("👋 Вы уже есть в системе.");
  }
});

// Команда для админа: список пользователей
bot.command("devbygemsbuyer", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  db.all(`SELECT * FROM users`, [], (err, rows) => {
    if (err) return ctx.reply("Ошибка БД");

    if (!rows.length) return ctx.reply("📫 Нет пользователей.");

    let text = "📋 Пользователи:\n\n";
    rows.forEach((u) => {
      text += `ID: ${u.id}\nСтатус: ${u.status}\n@${u.username}\n\n`;
    });

    ctx.reply(text);
  });
});

// ===============================
// AUTO BACKUP (каждые 6 часов)
// ===============================
setInterval(() => {
  try {
    const file = fs.readFileSync("./database.sqlite");
    const base64 = file.toString("base64");

    bot.telegram.sendMessage(
      ADMIN_ID,
      "📦 *SQLite BACKUP (каждые 6 часов)*\n\n" +
        "Скопируй и сохрани:\n\n" +
        base64,
      { parse_mode: "Markdown" }
    );

    console.log("Backup sent to admin");
  } catch (err) {
    console.error("Backup error:", err.message);
  }
}, 21600000); // 6 часов

// ===============================
// KEEPALIVE FOR RENDER
// ===============================
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 3000);

// ===============================
// START BOT
// ===============================
bot.launch();
console.log("Bot started with SQLite");
