const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

// --- إعدادات Telegram ---
const TELEGRAM_TOKEN = '7870976286:AAFdEkl8sIZBABUHY11LXFJ9zhR537BIqQs';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- صلاحيات المستخدمين ---
const accessList = JSON.parse(fs.readFileSync('access_list.json'));
const users = {};

// --- بدء بوت Telegram ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isAllowed = accessList.allowed_ids.includes(chatId);

  if (!isAllowed) {
    return bot.sendMessage(chatId, '❌ عذرًا، ليس لديك صلاحية استخدام هذا البوت.');
  }
  users[chatId] = { step: 'awaiting_token', active: false };
  bot.sendMessage(chatId,
    '✅ مرحبًا! أرسل Deriv API Token الخاص بك للبدء.\n' +
    'يمكنك إيقاف البوت أو تشغيله في أي وقت عبر الأوامر:\n' +
    '/startbot لتشغيل\n/stopbot لإيقاف');
});

// استقبال جميع الرسائل والنصوص للتحكم في خطوات المستخدم
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const user = users[chatId];

  if (!user) return; // إذا المستخدم غير مسجل صلاحية

  // أوامر تشغيل وإيقاف البوت
  if (text === '/startbot') {
    if (!user.token) return bot.sendMessage(chatId, '❌ الرجاء إرسال API Token أولاً عبر /start');
    if (user.active) return bot.sendMessage(chatId, '🔵 البوت يعمل بالفعل.');
    user.active = true;
    bot.sendMessage(chatId, '✅ بدأ البوت بالتحليل والدخول في الصفقات.');
    startBot(chatId, user);
    return;
  }

  if (text === '/stopbot') {
    if (!user.active) return bot.sendMessage(chatId, '🟠 البوت متوقف بالفعل.');
    user.active = false;
    bot.sendMessage(chatId, '⛔ تم إيقاف البوت مؤقتًا.');
    return;
  }

  // الخطوات لجمع معلومات المستخدم
  switch (user.step) {
    case 'awaiting_token':
      user.token = text.trim();
      user.step = 'awaiting_amount';
      return bot.sendMessage(chatId, '💵 أرسل مبلغ الصفقة (Stake):');
    case 'awaiting_amount':
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ أدخل مبلغ صالح أكبر من صفر.');
      user.initialStake = amount;
      user.currentStake = amount;
      user.step = 'awaiting_tp';
      return bot.sendMessage(chatId, '📈 أرسل Take Profit (مثلاً: 10):');
    case 'awaiting_tp':
      const tp = parseFloat(text);
      if (isNaN(tp) || tp <= 0) return bot.sendMessage(chatId, '❌ أدخل Take Profit صالح أكبر من صفر.');
      user.takeProfit = tp;
      user.step = 'awaiting_sl';
      return bot.sendMessage(chatId, '📉 أرسل Stop Loss (مثلاً: 10):');
    case 'awaiting_sl':
      const sl = parseFloat(text);
      if (isNaN(sl) || sl <= 0) return bot.sendMessage(chatId, '❌ أدخل Stop Loss صالح أكبر من صفر.');
      user.stopLoss = sl;
      user.balance = 0;
      user.profit = 0;
      user.inTrade = false;
      user.active = false; // مشغل يدوي من المستخدم بعد الخطوات
      bot.sendMessage(chatId,
        '✅ تم حفظ الإعدادات.\n' +
        'استخدم /startbot لتشغيل البوت\n' +
        'و /stopbot لإيقافه في أي وقت.');
      user.step = 'ready';
      break;
  }
});

// --- دالة بدء البوت والاتصال بـ Deriv WebSocket ---

function startBot(chatId, user) {
  if (!user.active) return;

  const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');

  let lastStoredCandle = null;
  let waitingForNewCandle = true;

  ws.on('open', () => {
    ws.send(JSON.stringify({ authorize: user.token }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.msg_type === 'authorize') {
      user.balance = msg.authorize.balance;
      bot.sendMessage(chatId, `💰 رصيدك الحالي: ${user.balance} USD`);

      // الاشتراك في بيانات الشموع الدقيقة لزوج volatility100 (Volatility 100 Index)
      ws.send(JSON.stringify({
        ticks_history: 'R_100',
        style: 'candles',
        end: 'latest',
        count: 3,
        granularity: 60,
        subscribe: 1
      }));
    }

    if (msg.msg_type === 'history' && msg.history && msg.history.candles) {
      const candles = msg.history.candles;
      if (!user.active) return ws.close();

      // استراتيجية شمعة ابتلاعية: نحتفظ بالشمعة الأخيرة وننتظر شمعة جديدة تبتلعها
      if (!lastStoredCandle) {
        // أول مرة نخزن آخر شمعة فقط
        lastStoredCandle = candles[candles.length - 1];
        waitingForNewCandle = true;
        return;
      }

      if (waitingForNewCandle) {
        // الشمعة الجديدة (curr) التي تغلق بعد lastStoredCandle
        const curr = candles[candles.length - 1];
        if (curr.epoch === lastStoredCandle.epoch) return; // نفس الشمعة لم تغلق بعد

        // هنا نطبق شروط شمعة ابتلاعية على (lastStoredCandle) و (curr)

        // الشمعة الأخيرة (prev)
        const prev = lastStoredCandle;

        // شرط الشمعة الأخيرة حمراء (هبوط) والشمعه الجديدة خضراء (ابتلاعية)
        if (prev.close < prev.open &&
            curr.close > curr.open &&
            curr.close > prev.open) {
          if (!user.inTrade) enterTrade(ws, user, chatId, 'Rise');
        }

        // شرط الشمعة الأخيرة خضراء (صعود) والشمعه الجديدة حمراء (ابتلاعية)
        else if (prev.close > prev.open &&
            curr.close < curr.open &&
            curr.close < prev.open) {
          if (!user.inTrade) enterTrade(ws, user, chatId, 'Fall');
        }

        // حدث إما صفقة أو لا، لكن انتقل الآن للشمعة الجديدة لتكون هي المحفوظة
        lastStoredCandle = curr;
        waitingForNewCandle = true; // دائما ننتظر الشمعة التالية الجديدة
      }
    }

    if (msg.msg_type === 'proposal_open_contract') {
      const profit = parseFloat(msg.proposal_open_contract.profit);
      user.profit += profit;
      bot.sendMessage(chatId,
                      `💹 ربح/خسارة الصفقة: ${profit.toFixed(2)} USD\nالربح الكلي: ${user.profit.toFixed(2)} USD`);

      if (profit < 0) {
        user.currentStake *= 2.5;
        bot.sendMessage(chatId, `⚠ خسارة، مضاعفة المبلغ للصفقة القادمة: ${user.currentStake.toFixed(2)} USD`);
      } else {
        user.currentStake = user.initialStake;
      }

      if (user.profit >= user.takeProfit) {
        user.active = false;
        bot.sendMessage(chatId, `🎉 تم الوصول إلى Take Profit! الربح النهائي: ${user.profit.toFixed(2)} USD\nتم إيقاف البوت.`);
        ws.close();
      } else if (user.profit <= -user.stopLoss) {
        user.active = false;
        bot.sendMessage(chatId, `💥 تم الوصول إلى Stop Loss! الخسارة النهائية: ${user.profit.toFixed(2)} USD\nتم إيقاف البوت.`);
        ws.close();
      }

      user.inTrade = false;
    }
  });

  ws.on('error', (err) => {
    bot.sendMessage(chatId, `❌ خطأ في WebSocket: ${err.message}`);
    });
  
  ws.on('error', (err) => {
    bot.sendMessage(chatId, `❌ خطأ في WebSocket: ${err.message}`);
  });

  ws.on('error', (err) => {
      bot.sendMessage(chatId, `❌ خطأ في WebSocket: ${err.message}`);
    });

    ws.on('close', () => {
      if (user.active) {
        bot.sendMessage(chatId, `⚠ اتصال WebSocket تم قطعه، يعاد الاتصال تلقائياً...`);
        setTimeout(() => {
          // أعد إنشاء الاتصال أو نفذ كود إعادة الاتصال هنا
          startBot(chatId, user);
        }, 5000);
      }
    });  // <--- هذا القوس مفقود في كودك

  }  // نهاية دالة startBot
