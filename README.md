# HabitFlow Bot

Telegram-бот HabitFlow — напоминания о привычках. Проект использует Supabase
(таблица `habits`) и Telegram Mini App: `https://habitflow-deploy-3.vercel.app`.

**Текущее состояние:** каркас. Работают `/start`, `/help`, `/test_notify` и
проверка соединения с Supabase. Cron-рассылка напоминаний — следующий шаг
(планировщик в `bot.js` уже заведён, но выключен).

## 1. Создать бота у @BotFather

1. Откройте Telegram и напишите [@BotFather](https://t.me/BotFather).
2. Команда `/newbot`, укажите имя и username бота (username должен заканчиваться на `bot`).
3. BotFather пришлёт токен вида `123456789:AA...` — это `BOT_TOKEN`. Никому его не передавайте.
4. (Опционально) `/setdescription`, `/setcommands` — описание и список команд в меню.

## 2. Установить зависимости

Из папки `habitflow/bot`:

```bash
npm install
```

Ставятся `telegraf`, `@supabase/supabase-js`, `node-cron`, `dotenv`.

## 3. Создать .env

Скопируйте пример и заполните своими значениями:

```bash
copy .env.example .env      # Windows
# cp .env.example .env      # macOS/Linux
```

`.env`:

```
BOT_TOKEN=токен_от_BotFather
SUPABASE_URL=https://ixiuftavghppfoofbvhz.supabase.co
SUPABASE_ANON_KEY=anon_ключ_из_supabase-client.js
```

Файл `.env` в `.gitignore` — не коммитьте его.

## 4. Запустить локально

```bash
npm start
```

В консоли появятся строки вида:

```
[HabitFlow bot] Запуск HabitFlow-бота...
[HabitFlow bot] Mini App URL: https://habitflow-deploy-3.vercel.app
[HabitFlow bot] Supabase: соединение OK (таблица habits доступна)
[HabitFlow bot] Бот запущен и слушает обновления Telegram (Ctrl+C для остановки)
```

Остановка — `Ctrl+C`. Бот работает по long-polling, домен/вебхук не нужен.

## 5. Проверить через /test_notify

1. Откройте своего бота в Telegram и отправьте `/start` — придёт приветствие с кнопкой Mini App.
2. Отправьте `/help` — придёт справка.
3. Отправьте `/test_notify` — бот ответит `⏰ Тестовое напоминание!`.
4. В консоли будут строки вида `[HabitFlow bot] /test_notify от user_id=...` —
   по ним видно, что обновления доходят.

Если команды не приходят: проверьте, что процесс `npm start` запущен, `BOT_TOKEN`
корректный, и нет второго запущенного экземпляра бота с тем же токеном
(Telegram отдаёт `409 Conflict` при двух параллельных long-polling).

## Структура

```
bot/
  bot.js           — точка входа: Telegraf, команды, проверка Supabase, заготовка cron
  package.json     — зависимости и скрипт start
  .env.example     — шаблон переменных окружения
  .gitignore       — игнорирует node_modules/ и .env
  README.md        — этот файл
```

## Что дальше (не реализовано)

- cron-планировщик читает `habits.reminder` (`{ time, days, enabled }`),
  учитывает `habits.last_notified` и рассылает напоминания в нужное время.
