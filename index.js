const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const express = require('express');

const TOKEN = '7870976286:AAFdEkl8sIZBABUHY11LXFJ9zhR537BIqQs';
const bot = new TelegramBot(TOKEN, { polling: true });

const accessList = JSON.parse(fs.readFileSync('./access_list.json'));
const PORT = process.env.PORT || 3000;
const app = express();

let usersData = {};
let stats = {};

// Express server for UptimeRobot
app.get('/', (req, res) => {
  res.send('Bot is running...');
});
app.listen(PORT, () => {
  console.log(`Express running on port ${PORT}`);
});

function hasAccess(userId) {
  return accessList.allowed_ids.includes(userId);
}

// Telegram: /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  if (!hasAccess(chatId)) {
    bot.sendMessage(chatId, '❌ لا تملك صلاحية الوصول لهذا البوت.');
    return;
  }

  usersData[chatId] = { step: 'awaiting_token' };
  bot.sendMessage(chatId, '🔐 أرسل Deriv API Token الخاص بك:');
});

// Telegram: Responses
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!hasAccess(chatId) || msg.text.startsWith('/')) return;

  const user = usersData[chatId];
  if (!user) return;

  switch (user.step) {
    case 'awaiting_token':
      user.token = msg.text.trim();
      user.step = 'awaiting_stake';
      bot.sendMessage(chatId, '💰 أرسل قيمة الستيك (Stake) بالدولار:');
      break;

    case 'awaiting_stake':
      const stake = parseFloat(msg.text);
      if (isNaN(stake) || stake <= 0) {
        bot.sendMessage(chatId, '❌ أدخل مبلغًا صحيحًا.');
        return;
      }
      user.stake = stake;
      user.step = 'ready';
      stats[chatId] = { wins: 0, losses: 0 };
      bot.sendMessage(chatId, `✅ تم الحفظ!\nStake: ${stake}$`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶ بدء البوت', callback_data: 'start_bot' }],
            [{ text: '⏹ إيقاف البوت', callback_data: 'stop_bot' }]
          ]
        }
      });
      break;
  }
});

// Telegram: Buttons
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const user = usersData[chatId];
  if (!user || user.step !== 'ready') return;

  if (query.data === 'start_bot') {
    if (user.botRunning) {
      bot.sendMessage(chatId, '⚠ البوت يعمل بالفعل.');
      return;
    }
    user.botRunning = true;
    bot.sendMessage(chatId, '✅ تم تشغيل البوت.');
    startTrading(user, chatId);
  }

  if (query.data === 'stop_bot') {
    user.botRunning = false;
    bot.sendMessage(chatId, '🛑 تم إيقاف البوت.');
  }
});

// ---------------------- TRADING FUNCTION ----------------------

function startTrading(user, chatId) {
  const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');

  let lastCandleTime = 0;

  ws.on('open', () => {
    ws.send(JSON.stringify({ authorize: user.token }));

    // Ping كل ثانية للحفاظ على الاتصال
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 1000);
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.msg_type === 'authorize') {
      ws.send(JSON.stringify({
        ticks_history: 'R_100',
        style: 'candles',
        granularity: 600, // 10 دقائق
        count: 1,
        subscribe: 1
      }));
    }

    if (data.msg_type === 'candles') {
      const candle = data.candles[0];

      // تأكد من أنه شمعة جديدة
      if (candle.epoch !== lastCandleTime) {
        lastCandleTime = candle.epoch;

        const direction = candle.close > candle.open ? 'FALL' : 'RISE';
        bot.sendMessage(chatId, `📊 شمعة جديدة:\n🕒 ${new Date(candle.epoch * 1000).toLocaleTimeString()}\n📉 Candle Close: ${candle.close}\n📈 Candle Open: ${candle.open}\n🧭 صفقة عكسية: ${direction}`);

        if (user.botRunning) {
          enterTrade(ws, user, chatId, direction);
        }
      }
    }

    if (data.msg_type === 'RISE') {
      bot.sendMessage(chatId, `✅ تم دخول الصفقة بقيمة ${user.stake}$`);
    }

    if (data.msg_type === 'proposal_open_contract') {
      const status = data.proposal_open_contract.status;
      const balance = data.proposal_open_contract.balance_after;

      if (status === 'won') {
        stats[chatId].wins++;
        bot.sendMessage(chatId, `🎉 ربحت الصفقة!\n💰 الرصيد الحالي: ${balance}`);
      } else if (status === 'lost') {
        stats[chatId].losses++;
        bot.sendMessage(chatId, `💥 خسرت الصفقة.\n💰 الرصيد الحالي: ${balance}`);
      }
    }
  });

  ws.on('error', (err) => {
    bot.sendMessage(chatId, `❌ خطأ في WebSocket: ${err.message}`);
  });

  ws.on('close', () => {
    bot.sendMessage(chatId, `⚠ تم قطع الاتصال. إعادة المحاولة خلال 3 ثوان...`);
    if (user.botRunning) {
      setTimeout(() => startTrading(user, chatId), 3000);
    }
  });
}

// تنفيذ الصفقة
function enterTrade(ws, user, chatId, direction) {
  ws.send(JSON.stringify({
    buy: 1,
    price: user.stake,
    parameters: {
      amount: user.stake,
      basis: 'stake',
      contract_type: direction,
      currency: 'USD',
      duration: 1,
      duration_unit: 'm',
      symbol: 'R_100'
    }
  }));
}
