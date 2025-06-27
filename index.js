const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const app = express();

// تأكد من وجود ملف access_list.json في نفس المجلد
const accessList = JSON.parse(fs.readFileSync('access_list.json', 'utf8'));

const USER_DATA_FILE = 'user_data.json';
let userStates = {};
let userDerivConnections = {}; // لتخزين اتصال WebSocket لكل مستخدم

// دالة لحفظ جميع حالات المستخدمين إلى ملف JSON
function saveUserStates() { // <--- تم تصحيح الاسم: U كبيرة
    try {
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userStates, null, 2), 'utf8');
        // console.log('User states saved successfully.'); // يمكنك تفعيل هذا للتصحيح
    } catch (error) {
        console.error('Error saving user states:', error.message);
    }
}

// دالة لتحميل جميع حالات المستخدمين من ملف JSON عند بدء التشغيل
function loadUserStates() { // <--- تم تصحيح الاسم: U كبيرة
    try {
        if (fs.existsSync(USER_DATA_FILE)) {
            const data = fs.readFileSync(USER_DATA_FILE, 'utf8');
            userStates = JSON.parse(data);
            console.log('User states loaded successfully.');
        } else {
            console.log('User data file not found, starting with empty states.');
        }
    } catch (error) {
        console.error('Error loading user states:', error.message);
        userStates = {}; // في حالة الخطأ، نبدأ بحالات فارغة لتجنب التعطل
    }
}

// دالة لإعادة الاتصال بـ Deriv
function reconnectDeriv(chatId, config) {
    if (!config.running) {
        console.log(`[Chat ID: ${chatId}] البوت متوقف، لن تتم محاولة إعادة الاتصال.`);
        return;
    }

    console.log(`[Chat ID: ${chatId}] جاري محاولة إعادة الاتصال بـ Deriv في 5 ثوانٍ...`); // تم تعديل الوقت
    bot.sendMessage(chatId, '🔄 جاري محاولة إعادة الاتصال بـ Deriv...');

    if (userDerivConnections[chatId]) {
        delete userDerivConnections[chatId];
    }

    setTimeout(() => {
        if (config.running) {
            startBotForUser(chatId, config);
        } else {
            console.log(`[Chat ID: ${chatId}] البوت توقف أثناء فترة انتظار إعادة الاتصال.`);
        }
    }, 5000); // 5 ثوانٍ
}
// هذا هو الكود الذي يجب عليك إضافته إلى ملفك
async function enterTrade(config, direction, chatId, ws) {
    // التحقق مما إذا كان اتصال WebSocket نشطًا ومفتوحًا قبل إرسال الطلب
    if (ws && ws.readyState === WebSocket.OPEN) {
        const formattedStake = parseFloat(config.currentStake.toFixed(2));
        bot.sendMessage(chatId, `⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ...`);
        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake,
            "basis": "stake",
            "contract_type": direction, // 'CALL' (صعود) أو 'PUT' (هبوط)
            "currency": "USD",
            "duration": 56,
            "duration_unit": "s", // 1 دقيقة
            "symbol": "R_100" // الرمز الذي تتداول عليه
        }));
    } else {
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
        console.error(`[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط.`);
    }
    }

// دالة رئيسية لبدء تشغيل البوت لكل مستخدم
function startBotForUser(chatId, config) { // <--- تم نقلها هنا لتكون دالة عالمية
    if (userDerivConnections[chatId]) {
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');
    userDerivConnections[chatId] = ws;

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

        if (msg.msg_type === 'authorize') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشلت المصادقة: ${msg.error.message}. يرجى التحقق من API Token.`);
                config.running = false;
                ws.close();
                saveUserStates(); // حفظ الحالة بعد الفشل
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

                const current5MinIntervalStartMinute = Math.floor(currentMinute / 5) * 5;

                if (currentSecond === 0 && currentMinute === current5MinIntervalStartMinute) {
                    if (config.lastProcessed5MinIntervalStart !== current5MinIntervalStartMinute) {
                        let tradeDirection = 'none';

                        if (config.candle5MinOpenPrice !== null) {
                            const previousCandleOpen = config.candle5MinOpenPrice;
                            const previousCandleClose = currentTickPrice;

                            if (previousCandleClose < previousCandleOpen) {
                                tradeDirection = 'PUT';
                                bot.sendMessage(chatId, `📉 الشمعة السابقة (5 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                            } else if (previousCandleClose > previousCandleOpen) {
                                tradeDirection = 'CALL';
                                bot.sendMessage(chatId, `📈 الشمعة السابقة (5 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                            } else {
                                bot.sendMessage(chatId, `↔ الشمعة السابقة (5 دقائق) بدون تغيير. لا يوجد اتجاه واضح.`);
                            }
                        } else {
                            bot.sendMessage(chatId, `⏳ جاري جمع بيانات الشمعة الأولى (5 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه.`);
                        }

                        config.candle5MinOpenPrice = currentTickPrice;
                        config.lastProcessed5MinIntervalStart = current5MinIntervalStartMinute;
                        saveUserStates(); // حفظ بعد تحديث بيانات الشمعة

                        if (tradeDirection !== 'none' && config.running && !config.tradingCycleActive) {
                            if (config.currentTradeCountInCycle > 0) {
                                bot.sendMessage(chatId, `🔄 جاري الدخول في صفقة مارتينغال رقم (${config.currentTradeCountInCycle}) بمبلغ ${config.currentStake.toFixed(2)} بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                            } else {
                                bot.sendMessage(chatId, `✅ جاري الدخول في صفقة أساسية بمبلغ ${config.currentStake.toFixed(2)} بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                            }
                            await enterTrade(config, tradeDirection, chatId, ws);
                            config.tradingCycleActive = true;
                            saveUserStates(); // حفظ بعد بدء دورة التداول
                        } else {
                            if (!config.tradingCycleActive) {
                                config.currentStake = config.stake;
                                config.currentTradeCountInCycle = 0;
                                saveUserStates(); // حفظ بعد إعادة ضبط الستيك والعداد
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
    bot.sendMessage(chatId, `❌ فشل الاقتراح. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}.`);
    config.tradingCycleActive = false;
    saveUserStates(); // حفظ بعد فشل الاقتراح
    // إزالة الجزء الذي يذكر انتظار الشمعة التالية
    return; 
  }
  const proposalId = msg.proposal.id;
  const askPrice = msg.proposal.ask_price;
  bot.sendMessage(chatId, `✅ تم الاقتراح: السعر المطلوب ${askPrice.toFixed(2)}$. جاري الشراء...`);
  ws.send(JSON.stringify({ "buy": proposalId, "price": askPrice }));
}
        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
                config.loss++;
                config.currentTradeCountInCycle++;
                config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2));
                bot.sendMessage(chatId, `❌ فشل الشراء. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)} والانتظار للشمعة الـ 5 دقائق التالية.`);
                config.tradingCycleActive = false;
                saveUserStates(); // حفظ بعد فشل الشراء
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
                bot.sendMessage(chatId, `📊 نتيجة الصفقة: ✅ ربح! ربح: ${profit.toFixed(2)}\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}\n\n✅ تم الربح. جاري انتظار شمعة 5 دقائق جديدة.`);
                config.tradingCycleActive = false;
                config.currentTradeCountInCycle = 0;
                config.currentStake = config.stake;
            } else {
                config.loss++;
                config.currentTradeCountInCycle++;

                let messageText = `📊 نتيجة الصفقة: ❌ خسارة! خسارة: ${Math.abs(profit).toFixed(2)}\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`;

                const maxMartingaleLosses = 4;

                if (config.currentTradeCountInCycle >= maxMartingaleLosses) {
                    messageText += `\n🛑 تم الوصول إلى الحد الأقصى للخسائر في دورة المارتينغال (${maxMartingaleLosses} صفقات متتالية). تم إيقاف البوت تلقائياً.`;
                    bot.sendMessage(chatId, messageText);
                    config.running = false;
                    saveUserStates(); // حفظ الحالة عند الوصول للحد الأقصى للمارتينغال
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                } else {
                    config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2));
                    messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى ${config.currentStake.toFixed(2)}`;                    bot.sendMessage(chatId, messageText);
                }
            }
            saveUserStates(); // حفظ بعد كل صفقة (ربح أو خسارة)

            if (config.tp > 0 && config.profit >= config.tp) {
                bot.sendMessage(chatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: ${config.tp.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
                config.running = false;
                saveUserStates(); // حفظ الحالة عند الوصول للـ TP
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            } else if (config.sl > 0 && config.profit <= -config.sl) {
                bot.sendMessage(chatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: ${config.sl.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
                config.running = false;
                saveUserStates(); // حفظ الحالة عند الوصول للـ SL
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            }
            config.tradingCycleActive = false; // إعادة ضبط دورة التداول بعد انتهاء الصفقة (بغض النظر عن النتيجة)
        }
        else if (msg.msg_type === 'error') {
            bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            config.tradingCycleActive = false;
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            saveUserStates(); // حفظ بعد خطأ من API
        }
    });

    ws.on('close', () => {
        console.log(`[Chat ID: ${chatId}] Deriv WebSocket connection closed.`);
        if (config.running) {
            bot.sendMessage(chatId, '⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...');
            reconnectDeriv(chatId, config);
        } else {
            delete userDerivConnections[chatId];
            saveUserStates(); // حفظ الحالة عند إغلاق الاتصال إذا كان البوت متوقفًا (تنظيف)
        }
    });

    ws.on('error', (error) => {
        console.error(`[Chat ID: ${chatId}] Deriv WebSocket error: ${error.message}`);
        bot.sendMessage(chatId, `❌ خطأ في اتصال Deriv: ${error.message}.`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        // لا حاجة لـ saveUserStates هنا لأن ws.on('close') ستُشغل
    });
} // <--- نهاية دالة startBotForUser



    

// -------------------------------------------------------------------------
// أوامر تيليجرام
// -------------------------------------------------------------------------

const bot = new TelegramBot('8021935025:AAHgxw8_cr1EsXKlRb_EYOeCxItPN8ELLBM', { polling: true }); // <--- تأكد من توكن التليجرام الخاص بك

// UptimeRobot (لا علاقة لها بالبوت مباشرة، ولكن للحفاظ على تشغيل السيرفر)
app.get('/', (req, res) => res.send('✅ Deriv bot is running'));
app.listen(3000, () => console.log('🌐 UptimeRobot is connected on port 3000'));


bot.onText(/\/start/, (msg) => {
    const id = msg.chat.id;

    if (!accessList.includes(id)) {
        return bot.sendMessage(id, '❌ غير مصرح لك باستخدام هذا البوت.');
    }

    if (userDerivConnections[id]) {
        userDerivConnections[id].close();
        delete userDerivConnections[id];
    }

    userStates[id] = {
        step: 'api',
        candle5MinOpenPrice: null,
        lastProcessed5MinIntervalStart: -1,
        tradingCycleActive: false,
        currentTradeCountInCycle: 0,
        profit: 0, // تهيئة الربح
        win: 0,    // تهيئة عدد مرات الربح
        loss: 0,   // تهيئة عدد مرات الخسارة
        currentStake: 0, // سيتم تعيينه لاحقًا
        stake: 0, // سيتم تعيينه لاحقًا
        tp: 0, // سيتم تعيينه لاحقًا
        sl: 0, // سيتم تعيينه لاحقًا
        token: '' // سيتم تعيينه لاحقًا
    };
    saveUserStates(); // حفظ الحالة الأولية

    bot.sendMessage(id, '🔐 أرسل Deriv API Token الخاص بك:');
});

bot.on('message', (msg) => {
    const id = msg.chat.id;
    const text = msg.text;
    const state = userStates[id];

    // إذا لم يكن هناك حالة للمستخدم أو كانت رسالة أمر
    if (!state || !state.step || text.startsWith('/')) return;

    if (state.step === 'api') {
        state.token = text;
        state.step = 'stake';
        saveUserStates(); // حفظ بعد تحديث API Token
        bot.sendMessage(id, '💵 أرسل مبلغ الصفقة:');
    } else if (state.step === 'stake') {
        state.stake = parseFloat(text);
        state.currentStake = state.stake;
        state.step = 'tp';
        saveUserStates(); // حفظ بعد تحديث Stake
        bot.sendMessage(id, '🎯 أرسل الهدف (Take Profit):');
    } else if (state.step === 'tp') {
        state.tp = parseFloat(text);
        state.step = 'sl';
        saveUserStates(); // حفظ بعد تحديث TP
        bot.sendMessage(id, '🛑 أرسل الحد الأقصى للخسارة (Stop Loss):');
    } else if (state.step === 'sl') {
        state.sl = parseFloat(text);
        state.running = false;
        state.candle5MinOpenPrice = null;
        state.lastProcessed5MinIntervalStart = -1;
        state.tradingCycleActive = false;
        state.currentTradeCountInCycle = 0;
        // الأرباح والخسائر والستيك الحالي يتم تعيينها عند البدء أو في (/run)
        saveUserStates(); // حفظ بعد تحديث SL وجميع الإعدادات

        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
    }
});

bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];

    if (!user) { // إذا لم يكن المستخدم مجهزاً
        bot.sendMessage(id, '⚠ الرجاء إعداد البوت أولاً باستخدام /start.');
        return;
    }

    if (user.running) { // إذا كان البوت يعمل بالفعل
        bot.sendMessage(id, '🔄 البوت قيد التشغيل بالفعل.');
        return;
    }

    // إعادة تعيين بعض القيم عند بدء التشغيل
    user.running = true;
    user.currentStake = user.stake; // إعادة تعيين الستيك الأساسي عند التشغيل
    user.currentTradeCountInCycle = 0; // إعادة تعيين عداد المارتينغال
    user.tradingCycleActive = false; // التأكد من عدم وجود دورة نشطة سابقة
    user.candle5MinOpenPrice = null; // إعادة تعيين بيانات الشمعة
    user.lastProcessed5MinIntervalStart = -1; // إعادة تعيين بيانات الشمعة
    user.profit = 0; // إعادة تعيين الأرباح
    user.win = 0;    // إعادة تعيين عدد مرات الربح
    user.loss = 0;   // إعادة تعيين عدد مرات الخسارة

    saveUserStates(); // حفظ الحالة بعد بدء التشغيل
    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user); // استدعاء الدالة الصحيحة
});

bot.onText(/\/stop/, (msg) => {
    const id = msg.chat.id;
    if (userStates[id]) {
        userStates[id].running = false;
        saveUserStates(); // حفظ حالة "stopped"

        if (userDerivConnections[id] && userDerivConnections[id].readyState === WebSocket.OPEN) {
            userDerivConnections[id].close();
            delete userDerivConnections[id];
        }
        bot.sendMessage(id, '🛑 تم إيقاف البوت.');
    } else {
        bot.sendMessage(id, '⚠ البوت ليس قيد التشغيل ليتم إيقافه.');
    }
});


// بدء البوت والاستماع للأوامر
// لا داعي لـ bot.startPolling() هنا لأن { polling: true } في إنشاء الكائن يقوم بذلك.
console.log('Bot started and waiting for commands...');
loadUserStates(); // تحميل البيانات 
