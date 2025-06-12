const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const express = require('express');
const app = express();

const accessList = JSON.parse(fs.readFileSync('access_list.json'));
const userStates = {};

const bot = new TelegramBot('7761232484:AAGXAcAZfN0cQtBFHrEu9JKfCVgiaxw-Xs8', { polling: true });

// سيرفر لتشغيل البوت على UptimeRobot
app.get('/', (req, res) => res.send('✅ Deriv bot is running'));
app.listen(3000, () => console.log('🌐 UptimeRobot is connected on port 3000'));

bot.onText(/\/start/, (msg) => {
    const id = msg.chat.id;
    if (!accessList.includes(id)) return bot.sendMessage(id, '❌ غير مصرح لك باستخدام هذا البوت.');
    userStates[id] = { step: 'api' };
    bot.sendMessage(id, '🔐 أرسل Deriv API Token الخاص بك:');
});

bot.on('message', (msg) => {
    const id = msg.chat.id;
    const text = msg.text;
    const state = userStates[id];

    if (!state || !state.step || text.startsWith('/')) return;

    if (state.step === 'api') {
        state.token = text;
        state.step = 'stake';
        bot.sendMessage(id, '💵 أرسل مبلغ الصفقة:');
    } else if (state.step === 'stake') {
        state.stake = parseFloat(text);
        state.step = 'tp';
        bot.sendMessage(id, '🎯 أرسل الهدف (Take Profit):');
    } else if (state.step === 'tp') {
        state.tp = parseFloat(text);
        state.step = 'sl';
        bot.sendMessage(id, '🛑 أرسل الحد الأقصى للخسارة (Stop Loss):');
    } else if (state.step === 'sl') {
        state.sl = parseFloat(text);
        state.profit = 0;
        state.win = 0;
        state.loss = 0;
        state.currentStake = state.stake;
        state.running = false;
        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
    }
});

bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];
    if (!user || user.running) return;
    user.running = true;
    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user);
});

bot.onText(/\/stop/, (msg) => {
    const id = msg.chat.id;
    if (userStates[id]) {
        userStates[id].running = false;
        bot.sendMessage(id, '🛑 تم إيقاف البوت.');
    }
});

function startBotForUser(chatId, config) {
    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');

    ws.on('open', () => {
        ws.send(JSON.stringify({
            ticks_history: 'R_100',
            style: 'candles',
            count: 600,
            granularity: 60,
            end: 'latest',
            start: 1,
            subscribe: 1
        }));
    });

    let last10Minute = null;

    ws.on('message', async (data) => {
        if (!config.running) {
            ws.close();
            return;
        }
        const msg = JSON.parse(data);
        if (!msg.candles) return;

        const candles = msg.candles;
        const last = candles[candles.length - 1];
        const currentMinute = new Date(last.epoch * 1000).getMinutes();

        if (currentMinute % 10 === 0 && last10Minute !== last.epoch) {
            last10Minute = last.epoch;
            const dir = last.close > last.open ? 'CALL' : 'PUT';
            await enterTrade(config, dir, chatId);

            if (config.profit >= config.tp || config.profit <= -config.sl) {
                bot.sendMessage(chatId, '🚫 تم الوصول إلى TP أو SL. تم إيقاف البوت.');
                config.running = false;
                ws.close();
            }
        }
    });
}

async function enterTrade(config, direction, chatId) { return new Promise((resolve) => { const ws = new WebSocket('wss://ws.derivapi.com/websockets/v3?app_id=22168');

let contract_id = null;

    ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: config.token }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.msg_type === 'authorize') {
            ws.send(JSON.stringify({
                buy: 1,
                price: config.currentStake,
                parameters: {
                    amount: config.currentStake,
                    basis: 'stake',
                    contract_type: direction,
                    currency: 'USD',
                    duration: 1,
                    duration_unit: 'm',
                    symbol: 'R_100'
                }
            }));
        } else if (msg.msg_type === 'buy') {
            contract_id = msg.buy.contract_id;
            bot.sendMessage(chatId, `📥 تم الدخول صفقة ${direction} بمبلغ ${config.currentStake}$`);
        } else if (msg.msg_type === 'portfolio') {
            const contract = msg.portfolio.contracts.find(c => c.contract_id === contract_id);
            if (contract && contract.is_sold) {
                const profit = parseFloat(contract.profit);
                const win = profit > 0;

                config.profit += profit;
                if (win) {
                    config.win++;
                    config.currentStake = config.stake;
                } else {
                    config.loss++;
                    config.currentStake *= 2.2;
                }

                bot.sendMessage(chatId,
                    `📊 نتيجة الصفقة: ${win ? '✅ ربح' : '❌ خسارة'}\n💰 الرصيد الآن: ${config.profit.toFixed(2)}$\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`);
                ws.close();
                resolve();
            }
        }
    });

    // اشترك بعد الشراء لتحديث الرصيد
    setTimeout(() => {
        ws.send(JSON.stringify({ portfolio: 1 }));
    }, 70000);
});

}
