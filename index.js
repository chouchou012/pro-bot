const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');

// --- إعدادات البوت الأساسية ---
const telegramBotToken = '7761232484:AAGXAcAZfN0cQtBFHrEu9JKfCVgiaxw-Xs8'; 
const bot = new TelegramBot(telegramBotToken, { polling: true });

const userConfigs = {};
const userDerivConnections = {};

// --- تحميل قائمة الوصول ---
let accessList = { allowed_users: [], administrators: [] };
try {
    const accessListData = fs.readFileSync('./access_list.json', 'utf8');
    accessList = JSON.parse(accessListData);
} catch (error) {
    // يمكنك إضافة رسالة تنبيه لمرة واحدة إذا أردت، ولكن طلبت حذف console.log
}

// --- دالة مساعدة للدخول في صفقة (enterTrade) ---
async function enterTrade(config, direction, chatId, ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const formattedStake = parseFloat(config.currentStake.toFixed(2)); 

        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake, 
            "basis": "stake",
            "contract_type": direction, 
            "currency": "USD", 
            "duration": 1,
            "duration_unit": "m", 
            "symbol": "R_100" 
        }));
    } else {
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
    }
}

// --- دالة بدء البوت لمستخدم معين (startBotForUser) ---
function startBotForUser(chatId, config) {
    if (typeof config.currentTradeCountInCycle === 'undefined') {
        config.currentTradeCountInCycle = 0; 
    }
    if (typeof config.tradingCycleActive === 'undefined') {
        config.tradingCycleActive = false; 
    }
    if (typeof config.candle10MinOpenPrice === 'undefined') {
        config.candle10MinOpenPrice = null; 
    }
    if (typeof config.lastProcessed10MinIntervalStart === 'undefined') {
        config.lastProcessed10MinIntervalStart = -1; 
    }

    if (userDerivConnections[chatId]) {
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');
    userDerivConnections[chatId] = ws; 

    // --- معالجة أحداث اتصال WebSocket ---
    ws.on('open', () => {
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token })); 
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);

        if (!config.running) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
                bot.sendMessage(chatId, '🛑 تم إغلاق اتصال Deriv.');
            }
            return;
        }

        // --- معالجة أنواع الرسائل المختلفة من Deriv ---
        if (msg.msg_type === 'authorize') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشلت المصادقة: ${msg.error.message}. يرجى التحقق من API Token.`);
                config.running = false; 
                ws.close();
            } else {
                bot.sendMessage(chatId, `✅ تم تسجيل الدخول بنجاح! الرصيد: ${msg.authorize.balance} ${msg.authorize.currency}`);
                ws.send(JSON.stringify({
                    "ticks": "R_100",
                    "subscribe": 1
                }));
            }
        }
        else if (msg.msg_type === 'tick' && msg.tick) {
            const currentTickPrice = parseFloat(msg.tick.quote);
            const tickEpoch = msg.tick.epoch;
            const tickDate = new Date(tickEpoch * 1000);
            const currentMinute = tickDate.getMinutes();
            const currentSecond = tickDate.getSeconds();

            const current10MinIntervalStartMinute = Math.floor(currentMinute / 10) * 10;

            if (currentSecond === 0 && currentMinute === current10MinIntervalStartMinute) {
                if (config.lastProcessed10MinIntervalStart !== current10MinIntervalStartMinute) {
                    let tradeDirection = 'none'; 

                    if (config.candle10MinOpenPrice !== null) {
                        const previousCandleOpen = config.candle10MinOpenPrice;
                        const previousCandleClose = currentTickPrice; 

                        if (previousCandleClose < previousCandleOpen) {
                            tradeDirection = 'CALL'; 
                            bot.sendMessage(chatId, `📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                        } else if (previousCandleClose > previousCandleOpen) {
                            tradeDirection = 'PUT'; 
                            bot.sendMessage(chatId, `📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                        } else {
                            bot.sendMessage(chatId, `↔ الشمعة السابقة (10 دقائق) بدون تغيير. لا يوجد اتجاه واضح.`);
                        }
                    } else {
                        bot.sendMessage(chatId, `⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه.`);
                    }

                    config.candle10MinOpenPrice = currentTickPrice;
                    config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute; 

                    if (tradeDirection !== 'none' && config.running && !config.tradingCycleActive) { 
                        if (config.currentTradeCountInCycle > 0) {
                             bot.sendMessage(chatId, `🔄 جاري الدخول في صفقة مارتينغال رقم (${config.currentTradeCountInCycle}) بمبلغ ${config.currentStake.toFixed(2)}$ بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                        } else {
                            bot.sendMessage(chatId, `✅ جاري الدخول في صفقة أساسية بمبلغ ${config.currentStake.toFixed(2)}$ بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                        }
                        await enterTrade(config, tradeDirection, chatId, ws);
                        config.tradingCycleActive = true; 
                    } else {
                        if (!config.tradingCycleActive) { 
                            config.currentStake = config.stake; 
                            config.currentTradeCountInCycle = 0; 
                        }
                    }
                    return; 
                } 
            }
        }
        else if (msg.msg_type === 'proposal') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                config.loss++; 
                config.currentTradeCountInCycle++; 
                config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2)); 
                bot.sendMessage(chatId, `❌ فشل الاقتراح. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والانتظار للشمعة الـ 10 دقائق التالية.`);
                config.tradingCycleActive = false; 
                return;
            }
            const proposalId = msg.proposal.id;
            const askPrice = msg.proposal.ask_price;
            bot.sendMessage(chatId, `✅ تم الاقتراح: السعر المطلوب ${askPrice.toFixed(2)}$. جاري الشراء...`);
            ws.send(JSON.stringify({
                "buy": proposalId,
                "price": askPrice
            }));
        }
        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
                config.loss++; 
                config.currentTradeCountInCycle++; 
                config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2)); 
                bot.sendMessage(chatId, `❌ فشل الشراء. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والانتظار للشمعة الـ 10 دقائق التالية.`);
                config.tradingCycleActive = false; 
                return;
            }
            const contractId = msg.buy.contract_id;
            bot.sendMessage(chatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}`);

            ws.send(JSON.stringify({
                "proposal_open_contract": 1,
                "contract_id": contractId,
                "subscribe": 1
            }));
        }
        else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract && msg.proposal_open_contract.is_sold === 1) {
            const contract = msg.proposal_open_contract;
            const profit = parseFloat(contract.profit);
            const win = profit > 0;

            config.profit += profit; 

            ws.send(JSON.stringify({ "forget": contract.contract_id }));

            if (win) {
                config.win++;
                bot.sendMessage(chatId, `📊 نتيجة الصفقة: ✅ ربح! ربح: ${profit.toFixed(2)}$\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}$\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}\n\n✅ تم الربح. جاري انتظار شمعة 10 دقائق جديدة.`);

                config.tradingCycleActive = false; 
                config.currentTradeCountInCycle = 0; 
                config.currentStake = config.stake; 
            } else { 
                config.loss++;
                config.currentTradeCountInCycle++; 

                let messageText = `📊 نتيجة الصفقة: ❌ خسارة! خسارة: ${Math.abs(profit).toFixed(2)}$\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}$\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`;

                const maxMartingaleLosses = 5; 

                if (config.currentTradeCountInCycle >= maxMartingaleLosses) { 
                    messageText += `\n🛑 تم الوصول إلى الحد الأقصى للخسائر في دورة المارتينغال (${maxMartingaleLosses} صفقات متتالية). تم إيقاف البوت تلقائياً.`;
                    bot.sendMessage(chatId, messageText);
                    config.running = false; 
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                } else {
                    config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2));
                    messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى ${config.currentStake.toFixed(2)}$ والانتظار للشمعة الـ 10 الدقائق التالية لدخول صفقة.`;
                    bot.sendMessage(chatId, messageText);
                }
            }

            if (config.tp > 0 && config.profit >= config.tp) {
                bot.sendMessage(chatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: ${config.tp.toFixed(2)}$). تم إيقاف البوت تلقائياً.`);
                config.running = false;
                ws.close();
            } else if (config.sl > 0 && config.profit <= -config.sl) {
                bot.sendMessage(chatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: ${config.sl.toFixed(2)}$). تم إيقاف البوت تلقائياً.`);
                config.running = false;
                ws.close();
            }
        }
        else if (msg.msg_type === 'error') {
            bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            config.tradingCycleActive = false;
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
        }
    });

    // --- معالجة أحداث إغلاق وخطأ الاتصال ---
    ws.on('close', (code, reason) => {
        if (config.running) { 
            bot.sendMessage(chatId, `🔴 تم إغلاق اتصال Deriv بشكل غير متوقع. جاري محاولة إعادة الاتصال...`);
            setTimeout(() => {
                startBotForUser(chatId, config); 
            }, 5000); 
        }
    });

    ws.on('error', (error) => {
        bot.sendMessage(chatId, `❌ حدث خطأ في اتصال Deriv: ${error.message}.`);
        config.running = false; 
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });
}

// --- معالجات أوامر تيليجرام (Telegram Command Handlers) ---
bot.onText(/\/start (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userToken = match[1]; 

    if (!accessList.allowed_users.includes(chatId) && !accessList.administrators.includes(chatId)) {
        bot.sendMessage(chatId, '🚫 عذراً، لا تملك صلاحية استخدام هذا البوت. يرجى التواصل مع المسؤول.');
        return;
    }

    userConfigs[chatId] = {
        token: userToken,
        running: false, 
        stake: 1.00,
        currentStake: 1.00,
        profit: 0,
        win: 0,
        loss: 0,
        currentTradeCountInCycle: 0,
        tradingCycleActive: false,
        candle10MinOpenPrice: null,
        lastProcessed10MinIntervalStart: -1,
        tp: 0, 
        sl: 0 
    };
    bot.sendMessage(chatId, `أهلاً بك! تم حفظ توكن API الخاص بك. يمكنك الآن تعيين الستيك وأهداف الربح والخسارة.`);
    bot.sendMessage(chatId, `استخدم /setstake <المبلغ> لتعيين مبلغ الرهان الأساسي (مثال: /setstake 1).`);
    bot.sendMessage(chatId, `استخدم /settp <المبلغ> لتعيين هدف جني الأرباح الكلي (مثال: /settp 10).`);
    bot.sendMessage(chatId, `استخدم /setsl <المبلغ> لتعيين حد وقف الخسارة الكلي (مثال: /setsl 20).`);
    bot.sendMessage(chatId, `ثم ابدأ البوت باستخدام /run.`);
});

bot.onText(/\/run/, (msg) => {
    const chatId = msg.chat.id;
    if (!accessList.administrators.includes(chatId)) {
        bot.sendMessage(chatId, '🚫 عذراً، لا تملك صلاحية تشغيل البوت. هذه ميزة للمسؤولين فقط.');
        return;
    }

    if (!userConfigs[chatId] || !userConfigs[chatId].token) {
        bot.sendMessage(chatId, '⚠ الرجاء إرسال API Token الخاص بك أولاً باستخدام /start <your_api_token>.');
        return;
    }

    if (userConfigs[chatId].running) {
        bot.sendMessage(chatId, '🔄 البوت قيد التشغيل بالفعل.');
        return;
    }

    userConfigs[chatId].running = true;
    userConfigs[chatId].currentStake = userConfigs[chatId].stake; 
    userConfigs[chatId].currentTradeCountInCycle = 0; 
    userConfigs[chatId].tradingCycleActive = false; 
    userConfigs[chatId].candle10MinOpenPrice = null; 
    userConfigs[chatId].lastProcessed10MinIntervalStart = -1; 

    bot.sendMessage(chatId, '🚀 جاري تشغيل البوت...');
    startBotForUser(chatId, userConfigs[chatId]);
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (!accessList.administrators.includes(chatId)) {
        bot.sendMessage(chatId, '🚫 عذراً، لا تملك صلاحية إيقاف البوت. هذه ميزة للمسؤولين فقط.');
        return;
    }

    if (!userConfigs[chatId] || !userConfigs[chatId].running) {
        bot.sendMessage(chatId, 'ℹ البوت غير قيد التشغيل حالياً.');
        return;
    }

    userConfigs[chatId].running = false;
    bot.sendMessage(chatId, '🛑 تم إيقاف البوت. جاري إغلاق الاتصال.');
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const config = userConfigs[chatId];

    if (!config) {
        bot.sendMessage(chatId, 'ℹ لم يتم إعداد البوت بعد. يرجى البدء باستخدام /start <API_TOKEN>.');
        return;
    }

    let statusMessage = `⚙ **حالة البوت:**\n`;
    statusMessage += `حالة التشغيل: ${config.running ? '✅ يعمل' : '🛑 متوقف'}\n`;
    statusMessage += `الستيك الأساسي: ${config.stake.toFixed(2)}$\n`;
    statusMessage += `الستيك الحالي: ${config.currentStake.toFixed(2)}$\n`;
    statusMessage += `الربح الكلي: ${config.profit.toFixed(2)}$\n`;
    statusMessage += `عدد الربح: ${config.win}\n`;
    statusMessage += `عدد الخسارة: ${config.loss}\n`;
    statusMessage += `صفقات المارتينغال الحالية: ${config.currentTradeCountInCycle}\n`;
    statusMessage += `دورة التداول نشطة: ${config.tradingCycleActive ? '✅ نعم' : '❌ لا'}\n`;
    statusMessage += `TP: ${config.tp > 0 ? config.tp.toFixed(2) + '$' : 'غير محدد'}\n`;
    statusMessage += `SL: ${config.sl > 0 ? config.sl.toFixed(2) + '$' : 'غير محدد'}\n`;
    statusMessage +=` شمعة 10 دقائق مفتوحة: ${config.candle10MinOpenPrice !== null ? config.candle10MinOpenPrice.toFixed(3) : 'غير متوفر'}\n`;

    bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' }); 
});

bot.onText(/\/setstake (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!accessList.allowed_users.includes(chatId) && !accessList.administrators.includes(chatId)) {
        bot.sendMessage(chatId, '🚫 عذراً، لا تملك صلاحية استخدام هذه الميزة.');
        return;
    }
    if (!userConfigs[chatId]) {
        bot.sendMessage(chatId, '⚠ الرجاء إعداد البوت أولاً باستخدام /start <API_TOKEN>.');
        return;
    }
    const newStake = parseFloat(match[1]);
    if (isNaN(newStake) || newStake <= 0) {
        bot.sendMessage(chatId, '❌ مبلغ الرهان غير صالح. يرجى إدخال رقم موجب.');
        return;
    }
    userConfigs[chatId].stake = newStake;
    userConfigs[chatId].currentStake = newStake; 
    bot.sendMessage(chatId, `✅ تم تعيين الستيك الأساسي إلى ${newStake.toFixed(2)}$.`);
});

bot.onText(/\/settp (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!accessList.allowed_users.includes(chatId) && !accessList.administrators.includes(chatId)) {
        bot.sendMessage(chatId, '🚫 عذراً، لا تملك صلاحية استخدام هذه الميزة.');
        return;
    }
    if (!userConfigs[chatId]) {
        bot.sendMessage(chatId, '⚠ الرجاء إعداد البوت أولاً باستخدام /start <API_TOKEN>.');
        return;
    }
    const newTp = parseFloat(match[1]);
    if (isNaN(newTp) || newTp < 0) {
        bot.sendMessage(chatId, '❌ مبلغ TP غير صالح. يرجى إدخال رقم موجب أو صفر للإلغاء.');
        return;
    }
    userConfigs[chatId].tp = newTp;
    bot.sendMessage(chatId, `✅ تم تعيين هدف الربح (TP) إلى ${newTp.toFixed(2)}$.`);
});

bot.onText(/\/setsl (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!accessList.allowed_users.includes(chatId) && !accessList.administrators.includes(chatId)) {
        bot.sendMessage(chatId, '🚫 عذراً، لا تملك صلاحية استخدام هذه الميزة.');
        return;
    }
    if (!userConfigs[chatId]) {
        bot.sendMessage(chatId, '⚠ الرجاء إعداد البوت أولاً باستخدام /start <API_TOKEN>.');
        return;
    }
    const newSl = parseFloat(match[1]);
    if (isNaN(newSl) || newSl < 0) {
        bot.sendMessage(chatId, '❌ مبلغ SL غير صالح. يرجى إدخال رقم موجب أو صفر للإلغاء.');
        return;
    }
    userConfigs[chatId].sl = newSl;
    bot.sendMessage(chatId, `✅ تم تعيين حد الخسارة (SL) إلى ${newSl.toFixed(2)}$.`);
});

// --- لتكامل UptimeRobot ---
const app = express();
const PORT = process.env.PORT || 3000; 

app.get('/', (req, res) => {
    res.status(200).send('Bot is running and healthy!');
});

app.listen(PORT, () => {
    // هذه الرسالة ضرورية لتأكيد بدء خادم الويب
    // يمكنك إزالتها لاحقاً إذا تأكدت من أن البوت يعمل
    console.log(`UptimeRobot endpoint listening on port ${PORT}`);
});
