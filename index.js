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
const accessList = JSON.parse(fs.readFileSync('./access_list.json', 'utf8'));
const users = {};

// --- بدء بوت Telegram ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id.toString();
  if (!accessList.includes(chatId)) {
    return bot.sendMessage(chatId, '❌ لا تملك صلاحية استخدام هذا البوت.');
  }
  users[chatId] = { step: 'awaiting_token' };
  bot.sendMessage(chatId, '✅ أرسل Deriv API Token الخاص بك:');
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  if (!users[chatId]) return;
  const user = users[chatId];
  const text = msg.text;

  if (user.step === 'awaiting_token') {
    user.token = text;
    user.step = 'awaiting_amount';
    return bot.sendMessage(chatId, '💵 أرسل مبلغ الصفقة:');
  }
  if (user.step === 'awaiting_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0)
      return bot.sendMessage(chatId, '❌ أدخل مبلغ صالح أكبر من صفر.');
    user.initialStake = amount;
    user.currentStake = amount;
    user.step = 'awaiting_tp';
    return bot.sendMessage(chatId, '📈 أرسل Take Profit (مثلاً: 10):');
  }
  if (user.step === 'awaiting_tp') {
    const tp = parseFloat(text);
    if (isNaN(tp) || tp <= 0)
      return bot.sendMessage(chatId, '❌ أدخل Take Profit صالح أكبر من صفر.');
    user.takeProfit = tp;
    user.step = 'awaiting_sl';
    return bot.sendMessage(chatId, '📉 أرسل Stop Loss (مثلاً: 10):');
  }
  if (user.step === 'awaiting_sl') {
    const sl = parseFloat(text);
    if (isNaN(sl) || sl <= 0)
      return bot.sendMessage(chatId, '❌ أدخل Stop Loss صالح أكبر من صفر.');
    user.stopLoss = sl;
    user.balance = 0;
    user.profit = 0;
    user.inTrade = false;
    user.active = true;
    bot.sendMessage(chatId, '✅ بدأ البوت بالتحليل والدخول في الصفقات.');
    startBot(chatId, user);
  }
  if (text.toLowerCase() === '/stop') {
    user.active = false;
    return bot.sendMessage(chatId, '⛔ تم إيقاف البوت مؤقتًا.');
  }
});

// --- دالة بدء البوت والاتصال بـ Deriv WebSocket ---

function startBot(chatId, user) {
  const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');

  ws.on('open', () => {
    ws.send(JSON.stringify({ authorize: user.token }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.msg_type === 'authorize') {
      user.balance = msg.authorize.balance;
      bot.sendMessage(chatId, `💰 رصيدك الحالي: ${user.balance} USD`);

      // الاشتراك في بيانات الشموع الدقيقة لزوج R_100
      ws.send(JSON.stringify({
        ticks_history: 'R_100',
        style: 'candles',
        end: 'latest',
        count: 3,
        subscribe: 1,
      }));
    }

    if (msg.msg_type === 'history' && msg.history && msg.history.candles) {
      const candles = msg.history.candles;
      if (!user.inTrade && user.active) {
        const signal = analyzeCandles(candles);
        if (signal) {
          enterTrade(ws, user, chatId, signal);
        }
      }
    }

    if (msg.msg_type === 'buy') {
      const info = msg.buy;
      bot.sendMessage(chatId,
                      `📄 تم تنفيذ الصفقة.\nاتجاه: ${info.contract_type}\nالمبلغ: ${info.buy_price} USD\nرقم: ${info.transaction_id}`);
      user.inTrade = true;

      setTimeout(() => {
        user.inTrade = false;
        user.currentStake = user.initialStake;
      }, 60000);
    }

    if (msg.msg_type === 'proposal_open_contract') {
      const profit = parseFloat(msg.proposal_open_contract.profit);
      user.profit += profit;
      bot.sendMessage(chatId,
                      `💹 ربح/خسارة الصفقة: ${profit.toFixed(2)} USD\nالربح الكلي: ${user.profit.toFixed(2)} USD`);

      if (profit < 0) {
        user.currentStake *= 2;
        bot.sendMessage(chatId, `⚠ خسارة، مضاعفة المبلغ للصفقة القادمة: ${user.currentStake.toFixed(2)} USD`);
      } else {
        user.currentStake = user.initialStake;
      }

      if (user.profit >= user.takeProfit) {
        user.active = false;
        bot.sendMessage(chatId, `🎉 تم الوصول إلى Take Profit! الربح النهائي: ${user.profit.toFixed(2)} USD\nتم إيقاف البوت.`);
      } else if (user.profit <= -user.stopLoss) {
        user.active = false;
        bot.sendMessage(chatId, `💥 تم الوصول إلى Stop Loss! الخسارة النهائية: ${user.profit.toFixed(2)} USD\nتم إيقاف البوت.`);
      }
    }
  });

  ws.on('error', (err) => {
    bot.sendMessage(chatId, `❌ خطأ في WebSocket: ${err.message}`);
  });
}

// --- دالة تحليل الشموع لشمعة ابتلاعية + تحليل مبسط ---

function analyzeCandles(candles) {
  // الشمعة الابتلاعية bullish engulfing:
  // شمعة سابقة هبوطية (close < open)
  // شمعة حالية صاعدة (close > open)
  // جسم الشمعة الحالية يغطي جسم الشمعة السابقة بالكامل

  if (candles.length < 2) return false;

  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];

  const prev_bearish = prev.close < prev.open;
  const curr_bullish = curr.close > curr.open;

  const engulfing = (curr.open < prev.close) && (curr.close > prev.open);

  // نضيف شرط بسيط للذكاء الاصطناعي: تحقق من أن جسم الشمعة الحالية أكبر من 50% من متوسط حجم آخر 3 شموع
  const avgBody = candles.slice(-3).reduce((a, c) => a + Math.abs(c.open - c.close), 0) / 3;
  const currBody = Math.abs(curr.close - curr.open);

  if (prev_bearish && curr_bullish && engulfing && currBody > avgBody * 0.5) {
    return 'CALL'; // اشارة شراء
  }

  // نفس الشيء للشمعة الابتلاعية الهبوطية bearish engulfing

  const prev_bullish = prev.close > prev.open;
  const curr_bearish = curr.close < curr.open;

  const engulfing_bear = (curr.open > prev.close) && (curr.close < prev.open);

  if (prev_bullish && curr_bearish && engulfing_bear && currBody > avgBody * 0.5) {
    return 'PUT'; // اشارة بيع
  }

  return false;
}

// --- دالة تنفيذ الصفقة ---

function enterTrade(ws, user, chatId, signal) {
  if (!user.active || user.inTrade) return;

  // عقد لمدة دقيقة واحدة (60 ثانية)
  const duration = 1;

  const buyRequest = {
    buy: 1,
    subscribe: 1,
    price: user.currentStake,
    parameters: {
      amount: user.currentStake,
      basis: 'stake',
      contract_type: signal === 'CALL' ? 'CALL' : 'PUT',
      currency: 'USD',
      duration: duration,
      duration_unit: 'm',
      symbol: 'R_100',
      //'barrier': null, // تركها null لصفقة عادية
      //'prediction': null,
    },
  };

  ws.send(JSON.stringify(buyRequest));
  bot.sendMessage(chatId, `⏳ إرسال طلب صفقة ${signal} بقيمة ${user.currentStake} USD لمدة ${duration} دقيقة.`);
}
