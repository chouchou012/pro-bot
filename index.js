const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const https = require('https');

const TOKEN = '7870976286:AAFdEkl8sIZBABUHY11LXFJ9zhR537BIqQs';
const bot = new TelegramBot(TOKEN, { polling: true });

const accessListPath = './access_list.json';
let accessList = JSON.parse(fs.readFileSync(accessListPath));

const app = express();
const PORT = process.env.PORT || 3000;

let usersData = {};  // لتخزين بيانات كل مستخدم

// صلاحية الوصول
function hasAccess(userId) {
  return accessList.allowed_ids.includes(userId);
}

// WebSocket لتحليل السوق فقط
const wsUrl = 'wss://green.derivws.com/websockets/v3?app_id=22168';
let ws;

function startWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('✅ WebSocket connected.');
    // يمكنك الاشتراك بإشارات السوق هنا
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    // تحليل البيانات سيتم لاحقًا هنا
  });

  ws.on('close', () => {
    console.log('⚠ WebSocket closed.');
    // لا نعيد الاتصال تلقائيًا
  });

  ws.on('error', (err) => {
    console.error('❗ WebSocket error:', err.message);
  });
}

startWebSocket();

// ⚙ Express لإبقاء البوت يعمل (UptimeRobot)
app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

// Telegram Bot
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (!hasAccess(chatId)) {
    bot.sendMessage(chatId, '❌ عذرًا، ليس لديك صلاحية استخدام هذا البوت.');
    return;
  }

  if (msg.text === '/start') {
    usersData[chatId] = { step: 'awaiting_token' };
    bot.sendMessage(chatId, '👋 مرحبًا! الرجاء إدخال Deriv API Token الخاص بك:');
    return;
  }

  if (!usersData[chatId]) {
    bot.sendMessage(chatId, '📌 الرجاء بدء المحادثة باستخدام /start.');
    return;
  }

  const userState = usersData[chatId];

  switch (userState.step) {
    case 'awaiting_token':
      userState.token = msg.text.trim();
      userState.step = 'awaiting_stake';
      bot.sendMessage(chatId, '💰 ادخل مبلغ الستيك (Stake):');

      // ✅ جلب الرصيد مباشرة بعد إدخال التوكن
      getBalance(userState.token, (balance) => {
        if (balance !== null) {
          bot.sendMessage(chatId, `💼 رصيد حسابك الحالي هو: ${balance} USD`);
        } else {
          bot.sendMessage(chatId, '⚠ لم يتم جلب الرصيد. تحقق من التوكن.');
        }
      });

      break;

    case 'awaiting_stake':
      const stake = parseFloat(msg.text);
      if (isNaN(stake) || stake <= 0) {
        bot.sendMessage(chatId, '❌ الرجاء إدخال مبلغ صحيح للستيك.');
        return;
      }
      userState.stake = stake;
      userState.step = 'awaiting_tp';
      bot.sendMessage(chatId, '🎯 ادخل نقطة الربح (Take Profit):');
      break;

    case 'awaiting_tp':
      const tp = parseFloat(msg.text);
      if (isNaN(tp) || tp <= 0) {
        bot.sendMessage(chatId, '❌ الرجاء إدخال رقم صحيح للربح.');
        return;
      }
      userState.tp = tp;
      userState.step = 'awaiting_sl';
      bot.sendMessage(chatId, '🛑 ادخل نقطة وقف الخسارة (Stop Loss):');
      break;

    case 'awaiting_sl':
      const sl = parseFloat(msg.text);
      if (isNaN(sl) || sl <= 0) {
        bot.sendMessage(chatId, '❌ الرجاء إدخال رقم صحيح للخسارة.');
        return;
      }
      userState.sl = sl;
      userState.step = 'ready';
      bot.sendMessage(chatId, '✅ تم حفظ الإعدادات! سيتم تحليل السوق وإعلامك بالإشارات.');

      // إعادة إرسال الرصيد تأكيدًا
      getBalance(userState.token, (balance) => {
        if (balance !== null) {
          bot.sendMessage(chatId, `📊 رصيدك الحالي هو: ${balance} USD`);
        }
      });

      break;

    case 'ready':
      bot.sendMessage(chatId, '🤖 البوت يعمل ويحلل السوق، الرجاء الانتظار...');
      break;

    default:
      bot.sendMessage(chatId, '⚠ خطأ في البيانات. يرجى إعادة البدء باستخدام /start.');
      delete usersData[chatId];
      break;
  }
});

// ✅ دالة لجلب الرصيد من Deriv
function getBalance(token, callback) {
  const postData = JSON.stringify({
    authorize: token
  });

  const options = {
    hostname: 'api.deriv.com',
    port: 443,
    path: '/websockets/v3',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=16929');

  ws.onopen = () => {
    ws.send(JSON.stringify({ authorize: token }));
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.msg_type === 'authorize') {
      ws.send(JSON.stringify({ balance: 1, subscribe: 0 }));
    } else if (data.msg_type === 'balance') {
      const balance = data.balance.balance;
      ws.close();
      callback(balance);
    }
  };

  ws.onerror = () => {
    callback(null);
  };
}
