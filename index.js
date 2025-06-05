const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');

const TOKEN = '7870976286:AAFdEkl8sIZBABUHY11LXFJ9zhR537BIqQs';
const bot = new TelegramBot(TOKEN, { polling: true });

const accessListPath = './access_list.json';
let accessList = JSON.parse(fs.readFileSync(accessListPath));

const app = express();
const PORT = process.env.PORT || 3000;

let usersData = {};  // لتخزين بيانات كل مستخدم (stake, tp, sl, token, وغيرها)

// وظيفة للتحقق من صلاحية المستخدم
function hasAccess(userId) {
  return accessList.allowed_ids.includes(userId);
}

// WebSocket لقراءة بيانات السوق والتحليل فقط (Volatility 100 Index)
const wsUrl = 'wss://green. derivws.com/websockets/v3?app_id=22168';
let ws;

// بدء WebSocket
function startWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('WebSocket connected');
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.msg_type === 'tick' && data.symbol === 'R_100') {
      // تحليل الشمعة بناءً على data.tick.quote
      // هنا تضيف منطق التحليل مثلا فتح/إغلاق الشمعة، شمعة 10 دقائق، إلخ

      // مثال مبسط: ارسال إشارة لكل مستخدم
      for (const userId in usersData) {
        if (hasAccess(Number(userId))) {
          // يمكن إرسال الإشارة للمستخدم هنا، أو يمكن تنفيذ استراتيجية محددة
          // هذا جزء للتحليل فقط
        }
      }
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting in 5 seconds...');
    setTimeout(startWebSocket, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

startWebSocket();

// Express للحفاظ على uptime
app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// استقبال رسائل التلجرام
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (!hasAccess(chatId)) {
    bot.sendMessage(chatId, 'عذرًا، ليس لديك صلاحية استخدام البوت.');
    return;
  }

  // استقبال أمر البدء وطلب بيانات التداول
  if (msg.text === '/start') {
    usersData[chatId] = {
      step: 'awaiting_token',
    };
    bot.sendMessage(chatId, 'مرحبًا! الرجاء إدخال Deriv API Token الخاص بك:');
    return;
  }

  if (!usersData[chatId]) {
    bot.sendMessage(chatId, 'يرجى استخدام الأمر /start لبدء العمل.');
    return;
  }

  const userState = usersData[chatId];

  switch (userState.step) {
    case 'awaiting_token':
      userState.token = msg.text.trim();
      userState.step = 'awaiting_stake';
      bot.sendMessage(chatId, 'ادخل مبلغ الستيك (Stake) بالعملة التي تريد التداول بها:');
      break;

    case 'awaiting_stake':
      const stake = parseFloat(msg.text);
      if (isNaN(stake) || stake <= 0) {
        bot.sendMessage(chatId, 'الرجاء إدخال مبلغ صحيح للستيك.');
        return;
      }
      userState.stake = stake;
      userState.step = 'awaiting_tp';
      bot.sendMessage(chatId, 'ادخل نقطة الربح (Take Profit) بالمبلغ:');
      break;

    case 'awaiting_tp':
      const tp = parseFloat(msg.text);
      if (isNaN(tp) || tp <= 0) {
        bot.sendMessage(chatId, 'الرجاء إدخال نقطة ربح صحيحة.');
        return;
      }
      userState.tp = tp;
      userState.step = 'awaiting_sl';
      bot.sendMessage(chatId, 'ادخل نقطة وقف الخسارة (Stop Loss) بالمبلغ:');
      break;

    case 'awaiting_sl':
      const sl = parseFloat(msg.text);
      if (isNaN(sl) || sl <= 0) {
        bot.sendMessage(chatId, 'الرجاء إدخال نقطة وقف خسارة صحيحة.');
        return;
      }
      userState.sl = sl;
      userState.step = 'ready';
      bot.sendMessage(chatId, 'تم حفظ الإعدادات! الآن سيتم تحليل السوق وإرسال إشارات التداول لك.');
      // هنا يمكنك بدء تنفيذ الدخول في الصفقات بناءً على التحليل باستخدام API
      break;

    case 'ready':
      bot.sendMessage(chatId, 'البوت يعمل ويحلل السوق، الرجاء الانتظار.');
      break;

    default:
      bot.sendMessage(chatId, 'حصل خطأ، يرجى البدء مجددًا باستخدام /start');
      delete usersData[chatId];
      break;
  }
});
