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
const REMINDER_CRON_EXPR = process.env.REMINDER_CRON || '* * * * *';

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

// Задача создаётся выключенной ({ scheduled: false }) и стартует в launch().then(),
// чтобы к моменту первой проверки бот уже был готов отправлять сообщения.
const reminderTask = cron.schedule(REMINDER_CRON_EXPR, () => {
  checkReminders().catch(e => console.error('[Cron] Ошибка:', e.message));
}, { scheduled: false });

/* ------------------------------- Запуск ------------------------------- */

log('Запуск HabitFlow-бота...');
log('Mini App URL:', MINI_APP_URL);

await checkSupabase();

bot.launch()
  .then(() => {
    log('Бот запущен и слушает обновления Telegram (Ctrl+C для остановки)');

    // Планировщик стартует только после успешного launch(), чтобы
    // sendMessage из checkReminders гарантированно работал.
    reminderTask.start();
    log(`[Cron] Планировщик напоминаний запущен (cron: ${REMINDER_CRON_EXPR}, проверка каждую минуту)`);

    // Один раз при старте — чтобы не ждать первую минуту
    checkReminders().catch(e => console.error('[Cron] Ошибка старта:', e.message));
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
