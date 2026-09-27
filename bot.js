/* ==================================================================
   HabitFlow — Telegram-бот.

   Что умеет:
   - команды /start, /help, /test_notify;
   - проверку соединения с Supabase на старте;
   - cron-планировщик напоминаний: раз в минуту читает habits.reminder
     и рассылает напоминания в Telegram (см. checkReminders ниже).

   Запуск: npm start (или node bot.js) из папки bot/.
   ================================================================== */

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';

/* ------------------------------ Конфиг ------------------------------ */

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://habitflow-deploy-3.vercel.app';

const log = (...args) => console.log('[HabitFlow bot]', ...args);
const logError = (...args) => console.error('[HabitFlow bot][ERROR]', ...args);

if (!BOT_TOKEN) {
  logError('BOT_TOKEN не задан. Скопируйте .env.example в .env и укажите токен от @BotFather.');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[HabitFlow bot] SUPABASE_URL/SUPABASE_ANON_KEY не заданы — клиент Supabase не создан.');
}

/* ------------------------------ Supabase ------------------------------ */

// Клиент создаётся сразу. Используется в checkSupabase() на старте
// и в checkReminders() — для чтения habits и отметки last_notified.
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

async function checkSupabase() {
  if (!supabase) {
    log('Supabase: пропущено (нет ключей в .env)');
    return false;
  }
  try {
    const { error } = await supabase.from('habits').select('id').limit(1);
    if (error) throw error;
    log('Supabase: соединение OK (таблица habits доступна)');
    return true;
  } catch (e) {
    logError('Supabase: не удалось прочитать habits:', e.message || e);
    return false;
  }
}

/* -------------------------------- Бот -------------------------------- */

const bot = new Telegraf(BOT_TOKEN);

// Кнопка Mini App (web_app) для приватных чатов + обычный URL-фолбэк,
// т.к. Telegram не показывает web_app-кнопку в некоторых контекстах.
const miniAppKeyboard = Markup.inlineKeyboard([
  [Markup.button.webApp('📱 Открыть HabitFlow', MINI_APP_URL)],
  [Markup.button.url('🌐 Открыть в браузере', MINI_APP_URL)],
]);

bot.start((ctx) => {
  log(`/start от user_id=${ctx.from?.id} (@${ctx.from?.username || 'без username'})`);
  return ctx.reply(
    `Привет, ${ctx.from?.first_name || 'друг'}! 👋\n\n` +
    'Это HabitFlow — трекер привычек.\n' +
    'Привычки и напоминания настраиваются в Mini App:\n\n' +
    '⏰ Напоминания работают автоматически: включите их у привычки в Mini App ' +
    '(время + дни недели) — и бот сам напишет в нужный момент.',
    miniAppKeyboard
  );
});

bot.help((ctx) => {
  log(`/help от user_id=${ctx.from?.id}`);
  return ctx.reply(
    'HabitFlow — справка 📖\n\n' +
      '/start — приветствие и кнопка Mini App\n' +
      '/help — эта справка\n' +
      '/test_notify — тестовое напоминание (проверка доставки)\n\n' +
      'Привычки, расписание и напоминания настраиваются в Mini App.\n' +
      'Напоминания приходят автоматически в выбранное время (проверка раз в минуту),\n' +
      'если привычка ещё не отмечена за сегодня.',
    miniAppKeyboard
  );
});

bot.command('test_notify', (ctx) => {
  log(`/test_notify от user_id=${ctx.from?.id}`);
  return ctx.reply('⏰ Тестовое напоминание!');
});

/* ---------------------- Неизвестные сообщения ---------------------- */

bot.on('message', (ctx) => {
  log(`Сообщение от user_id=${ctx.from?.id}: ${ctx.message.text ?? '[не текст]'}`);
  return ctx.reply('Пока я понимаю только команды. Нажмите /help.');
});

/* ------------------- cron: рассылка напоминаний ------------------- */

// Планировщик проверяет привычки раз в минуту (выражение можно переопределить
// через .env: REMINDER_CRON). Время сравниваем с ЛОКАЛЬНЫМ временем сервера,
// а не с UTC, иначе напоминания придут со сдвигом часового пояса.
const REMINDER_CRON_RAW = process.env.REMINDER_CRON;
// Защита от опечатки в переменной окружения: невалидное cron-выражение
// уронило бы процесс на старте (node-cron валидирует его в конструкторе),
// поэтому при ошибке молча откатываемся на '* * * * *'.
const REMINDER_CRON_EXPR =
  (REMINDER_CRON_RAW && cron.validate(REMINDER_CRON_RAW)) ? REMINDER_CRON_RAW : '* * * * *';
if (REMINDER_CRON_RAW && REMINDER_CRON_EXPR !== REMINDER_CRON_RAW) {
  console.error(`[Cron] Невалидное REMINDER_CRON="${REMINDER_CRON_RAW}" — использую '* * * * *'`);
}

async function checkReminders() {
  // Без ключей Supabase клиент не создан — проверять нечего.
  if (!supabase) {
    log('[Cron] Пропуск проверки: Supabase не подключён (нет ключей в .env)');
    return;
  }

  const now = new Date();
  // Локальное время (не UTC!)
  const currentTime = String(now.getHours()).padStart(2, '0') + ':' +
                      String(now.getMinutes()).padStart(2, '0');
  const currentDay = now.getDay(); // 0=вс, 1=пн, ..., 6=сб
  // Дата в формате YYYY-MM-DD для поля last_notified
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const todayDate = year + '-' + month + '-' + day;

  console.log(`[Cron] Проверка: ${currentTime}, день ${currentDay}`);

  try {
    // Читаем только привычки с включённым напоминанием
    const { data: habits, error } = await supabase
      .from('habits')
      .select('*')
      .eq('reminder->>enabled', 'true');

    if (error) {
      console.error('[Cron] Ошибка чтения Supabase:', error.message);
      return;
    }

    if (!habits || habits.length === 0) return;

    console.log(`[Cron] Найдено ${habits.length} привычек с напоминанием`);

    for (const habit of habits) {
      try {
        const r = habit.reminder || {};

        // 1. Время совпадает? (padStart — на случай "9:00" вместо "09:00")
        if (String(r.time || '').padStart(5, '0') !== currentTime) continue;

        // 2. Сегодня нужный день недели? (дни могут прийти и числами, и строками)
        if (!Array.isArray(r.days)) continue;
        if (!r.days.some((d) => Number(d) === currentDay)) continue;

        // 3. Уже отправляли сегодня?
        if (habit.last_notified === todayDate) continue;

        // 4. Привычка не выполнена сегодня?
        const completions = habit.completions || {};
        if (completions[todayDate] === true || completions[todayDate] === 'true') continue;

        // Отправляем напоминание
        const message = `⏰ Пора выполнить: ${habit.emoji || '💪'} ${habit.name}\n\n` +
                        `Открой HabitFlow и отметь выполнение.`;

        await bot.telegram.sendMessage(habit.user_id, message, {
          reply_markup: {
            inline_keyboard: [[
              { text: '📱 Открыть HabitFlow',
                web_app: { url: MINI_APP_URL } }
            ]]
          }
        });

        // Помечаем, что напоминание отправлено
        const { error: updateError } = await supabase
          .from('habits')
          .update({ last_notified: todayDate })
          .eq('id', habit.id);

        if (updateError) {
          console.error(`[Reminder] Не удалось сохранить last_notified для ${habit.id}:`, updateError.message);
        }

        console.log(`[Reminder] ✓ Отправлено user=${habit.user_id}: ${habit.name}`);
      } catch (e) {
        console.error(`[Reminder] Ошибка для привычки ${habit.id}:`, e.message);
        // продолжаем цикл, не ломаем
      }
    }
  } catch (e) {
    console.error('[Cron] Общая ошибка:', e.message);
  }
}

// ИСПРАВЛЕНИЕ: задача стартует СРАЗУ — без опции { scheduled: false }.
// Раньше она стартовала внутри bot.launch().then(...), но launch() для long polling
// резолвится ТОЛЬКО при остановке бота: telegraf делает `await this.startPolling()`,
// а это бесконечный цикл getUpdates (node_modules/telegraf/lib/core/network/polling.js).
// Из-за этого .then() не выполнялся никогда → планировщик не запускался.
const reminderTask = cron.schedule(REMINDER_CRON_EXPR, () => {
  checkReminders().catch(e => console.error('[Cron] Ошибка:', e.message));
});
console.log(`[Cron] Планировщик напоминаний запущен (cron: ${REMINDER_CRON_EXPR})`);

// Первая проверка сразу после старта — не ждём первую минуту
setTimeout(() => {
  checkReminders().catch(e => console.error('[Cron] Ошибка старта:', e.message));
}, 3000);

/* ------------------------------- Запуск ------------------------------- */

log('Запуск HabitFlow-бота...');
log('Mini App URL:', MINI_APP_URL);

// Railway по умолчанию работает в UTC: если время в строках [Cron] Проверка
// расходится с вашим часовым поясом — задайте переменную TZ (TZ=Europe/Moscow).
log(`Часовой пояс процесса: ${Intl.DateTimeFormat().resolvedOptions().timeZone} ` +
    `(смещение от UTC: ${-new Date().getTimezoneOffset()} мин)`);

await checkSupabase();

// launch() для long polling резолвится ТОЛЬКО при остановке бота
// (см. пояснение у cron.schedule выше), поэтому логики «после старта»
// в .then() быть не должно — планировщик напоминаний уже запущен выше.
// Колбэк onLaunch у telegraf помечен как @experimental, поэтому не используем.
log('Старт long polling (Ctrl+C для остановки)...');

bot.launch()
  .then(() => {
    // Сюда попадаем только когда бот остановлен (bot.stop по SIGINT/SIGTERM).
    log('Long polling остановлен — бот больше не слушает Telegram');
  })
  .catch((e) => {
    logError('Не удалось запустить бота:', e.message || e);
    process.exit(1);
  });

// Мягкая остановка: корректно закрываем long-polling и cron при Ctrl+C / SIGTERM.
process.once('SIGINT', () => {
  log('SIGINT: останавливаю бота...');
  reminderTask.stop();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  log('SIGTERM: останавливаю бота...');
  reminderTask.stop();
  bot.stop('SIGTERM');
});
