const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const app = express();

const accessList = JSON.parse(fs.readFileSync('access_list.json'));
const userStates = {};
const userDerivConnections = {}; // <--- تعديل جديد: لتخزين اتصال WebSocket لكل مستخدم

const bot = new TelegramBot('7761232484:AAGXAcAZfN0cQtBFHrEu9JKfCVgiaxw-Xs8', { polling: true }); // <--- تأكد من توكن التليجرام الخاص بك

// UptimeRobot
app.get('/', (req, res) => res.send('✅ Deriv bot is running'));
app.listen(3000, () => console.log('🌐 UptimeRobot is connected on port 3000'));

// أوامر تليجرام
bot.onText(/\/start/, (msg) => {
    const id = msg.chat.id;
    if (!accessList.includes(id)) return bot.sendMessage(id, '❌ غير مصرح لك باستخدام هذا البوت.');

    // <--- تعديل جديد: إغلاق أي اتصال Deriv قديم عند بدء البوت
    if (userDerivConnections[id]) {
        userDerivConnections[id].close();
        delete userDerivConnections[id];
    }

    userStates[id] = {
        step: 'api',
        // <--- تعديل جديد: إضافة خصائص جديدة لاستراتيجية التيكات
        priceAt9thMinuteStart: null,    // لتخزين السعر عند بداية الدقيقة X9 (الثانية 00)
        minuteOfLastDecision: -1,       // لتتبع الدقيقة X9 التي تم اتخاذ القرار بناءً عليها (لمنع التكرار)
        waitingForNextTrade: false      // لتتبع ما إذا كنا في انتظار نهاية الدقيقة X9 (أول تيك من X0) للدخول
    };
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
        state.running = false; // للتأكد أنه غير قيد التشغيل بعد الإعداد
        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
    }
});

bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];
    if (!user || user.running) return;

    user.running = true;
    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user); // استدعاء الدالة لبدء الاتصال بـ Deriv
});

bot.onText(/\/stop/, (msg) => {
    const id = msg.chat.id;
    if (userStates[id]) {
        userStates[id].running = false;
        // <--- تعديل جديد: إغلاق اتصال Deriv عند إيقاف البوت
        if (userDerivConnections[id] && userDerivConnections[id].readyState === WebSocket.OPEN) {
            userDerivConnections[id].close();
            delete userDerivConnections[id];
        }
        bot.sendMessage(id, '🛑 تم إيقاف البوت.');
    }
});

// <--- تعديل رئيسي: دالة startBotForUser تم إعادة هيكلتها بالكامل
function startBotForUser(chatId, config) {
    // <--- تعديل جديد: إغلاق أي اتصال Deriv قديم للمستخدم المحدد
    if (userDerivConnections[chatId]) {
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');
    userDerivConnections[chatId] = ws; // تخزين الاتصال

    ws.on('open', () => {
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token }));
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);

        // إذا توقف البوت، أغلق الاتصال وتوقف
        if (!config.running) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
                bot.sendMessage(chatId, '🛑 تم إغلاق اتصال Deriv.');
            }
            return;
        }

        // معالجة استجابات المصادقة
        if (msg.msg_type === 'authorize') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشلت المصادقة: ${msg.error.message}. يرجى التحقق من API Token.`);
                config.running = false;
                ws.close();
            } else {
                bot.sendMessage(chatId, `✅ تم تسجيل الدخول بنجاح! الرصيد: ${msg.authorize.balance} ${msg.authorize.currency}`);
                // <--- تعديل جديد: الاشتراك في التيكات بدلاً من الشموع
                ws.send(JSON.stringify({
                    "ticks": "R_100", // <<<<<<<<<<<<<<<<< الاشتراك في التيكات
                    "subscribe": 1
                }));
            }
        }
        // <--- تعديل جديد: كتلة معالجة التيكات الجديدة
        else if (msg.msg_type === 'tick' && msg.tick) {
            const currentTickPrice = parseFloat(msg.tick.quote);
            const tickEpoch = msg.tick.epoch;
            const tickDate = new Date(tickEpoch * 1000);
            const currentMinute = tickDate.getMinutes();
            const currentSecond = tickDate.getSeconds();

            // Log ticks for debugging (يمكن إزالتها لاحقاً إذا أردت)
            // console.log([Chat ID: ${chatId}] Tick: ${currentTickPrice} @ ${currentMinute}:${currentSecond});

            // --- الخطوة 1: تسجيل السعر في بداية الدقيقة X9 (أي عندما تكون الثانية 00) ---
            // هذا هو "سعر الافتتاح" للدقيقة التي سنحللها.
            if (currentSecond === 0 && (currentMinute % 10 === 9)) {
                // التحقق مما إذا كنا قد سجلنا هذا السعر بالفعل لهذه الدقيقة لمنع التكرار
                if (config.minuteOfLastDecision !== currentMinute) {
                    config.priceAt9thMinuteStart = currentTickPrice;
                    config.waitingForNextTrade = true; // نحن الآن ننتظر أول تيك من الدقيقة التالية
                    console.log(`[Chat ID: ${chatId}] تم تسجيل سعر الافتتاح للدقيقة ${currentMinute}:00: ${currentTickPrice}`);
                }
            }

            // --- الخطوة 2: تسجيل السعر في بداية الدقيقة X0 (أي عندما تكون الثانية 00) والدخول في الصفقة ---
            // هذا هو "سعر الإغلاق" للدقيقة X9 التي انتهت للتو.
            // يجب أن يحدث هذا بعد تسجيل priceAt9thMinuteStart من الدقيقة السابقة (X9).
            if (currentSecond === 0 && (currentMinute % 10 === 0) && config.waitingForNextTrade === true) {
                // تأكد أن الدقيقة الحالية هي بالفعل الدقيقة التالية للدقيقة X9 التي سجلنا سعر بدايتها
                const minuteBeforeCurrent = (currentMinute === 0) ? 59 : currentMinute - 1;
                if (minuteBeforeCurrent % 10 === 9 && config.minuteOfLastDecision !== minuteBeforeCurrent) {

                    const priceAt0thMinuteStart = currentTickPrice; // هذا هو سعر الإغلاق للدقيقة X9

                    let direction;
                    if (config.priceAt9thMinuteStart !== null) { // تأكد أن لدينا سعر بداية
                        if (priceAt0thMinuteStart > config.priceAt9thMinuteStart) {
                            direction = 'CALL'; // السعر ارتفع خلال الدقيقة X9
                        } else if (priceAt0thMinuteStart < config.priceAt9thMinuteStart) {
                            direction = 'PUT';  // السعر انخفض خلال الدقيقة X9
                        } else {
                            // السعر لم يتغير، لا اتجاه واضح، لا ندخل صفقة
                            console.log(`[Chat ID: ${chatId}] لا تغيير في السعر من ${minuteBeforeCurrent}:00 إلى ${currentMinute}:00. تخطي الصفقة.`);
                            config.priceAt9thMinuteStart = null; // إعادة تعيين
                            config.waitingForNextTrade = false; // إعادة تعيين
                            config.minuteOfLastDecision = minuteBeforeCurrent; // تم معالجة هذه الدقيقة
                            return;
                        }

                        console.log(`[Chat ID: ${chatId}] سعر ${minuteBeforeCurrent}:00 كان ${config.priceAt9thMinuteStart}، سعر ${currentMinute}:00 هو ${priceAt0thMinuteStart}. الاتجاه: ${direction}`);

                        if (config.running) {
                            await enterTrade(config, direction, chatId, ws); // الدخول في صفقة مدتها دقيقة واحدة
                            config.minuteOfLastDecision = minuteBeforeCurrent; // تسجيل الدقيقة التي تم اتخاذ القرار بناءً عليها
                        } else {
                            console.log(`[Chat ID: ${chatId}] البوت متوقف، لا يمكن دخول صفقة.`);
                        }
                    } else {
                        console.log(`[Chat ID: ${chatId}] لا يوجد سعر بداية (X9:00) مسجل. تخطي الصفقة.`);
                    }

                    // إعادة تعيين المتغيرات استعداداً للدورة التالية
                    config.priceAt9thMinuteStart = null;
                    config.waitingForNextTrade = false;
                }
            }
        }
        // <--- نهاية كتلة معالجة التيكات الجديدة

        // معالجة الاقتراح والشراء والمراقبة داخل المستمع الرئيسي للرسائل (تبقى كما هي)
        else if (msg.msg_type === 'proposal') {
            // هذه هي استجابة طلب الاقتراح
            // هنا يمكنك إرسال طلب الشراء 'buy'
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
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
            // هذه هي استجابة طلب الشراء
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
                return;
            }
            const contractId = msg.buy.contract_id;
            bot.sendMessage(chatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}`);

            // بعد الشراء، اشترك في حالة العقد لمراقبته
            ws.send(JSON.stringify({
                "proposal_open_contract": 1,
                "contract_id": contractId,
                "subscribe": 1
            }));
        }
        else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract && msg.proposal_open_contract.is_sold === 1) {
            // هذه هي رسالة تحديث حالة العقد بعد بيعه
            const contract = msg.proposal_open_contract;
            const profit = parseFloat(contract.profit);
            const win = profit > 0;

            config.profit += profit;
            if (win) {
                config.win++;
                config.currentStake = config.stake; // إعادة الـ stake الأصلي عند الربح
            } else {
                config.loss++;
                config.currentStake *= 2.2; // مضاعفة الـ stake عند الخسارة
            }

            bot.sendMessage(chatId, `📊 نتيجة الصفقة: ${win ? '✅ ربح' : '❌ خسارة'}\n💰 الرصيد الآن: ${config.profit.toFixed(2)}$\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`);
            // إلغاء الاشتراك من هذا العقد بعد بيعه
            ws.send(JSON.stringify({ "forget": contract.contract_id }));

            // <--- تعديل جديد: التحقق من TP/SL بعد كل صفقة
            if (config.profit >= config.tp && config.tp > 0) {
                bot.sendMessage(chatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: ${config.tp.toFixed(2)}$). تم إيقاف البوت تلقائياً.`);
                config.running = false;
                ws.close();
            } else if (config.profit <= -config.sl && config.sl > 0) {
                bot.sendMessage(chatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: ${config.sl.toFixed(2)}$). تم إيقاف البوت تلقائياً.`);
                config.running = false;
                ws.close();
            }
        }
        else if (msg.msg_type === 'error') {
            // رسائل الخطأ العامة من Deriv API
            bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            console.error(`Deriv API Error: ${JSON.stringify(msg.error)}`);
        }
    });

    // <--- بداية التعديل على ws.on('close')
    ws.on('close', () => {
        console.log(`[Chat ID: ${chatId}] Deriv WebSocket connection closed.`);
        // إذا كان البوت لا يزال قيد التشغيل (لم يتم إيقافه يدوياً عبر /stop)
        if (config.running) {
            // إرسال رسالة للمستخدم، ثم استدعاء دالة إعادة الاتصال
            bot.sendMessage(chatId, '⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...');
            reconnectDeriv(chatId, config); // استدعاء الدالة الجديدة هنا
        } else {
            // إذا كان البوت متوقفاً بالفعل (config.running كان false)،
            // فقط قم بتنظيف مرجع الاتصال.
            delete userDerivConnections[chatId];
        }
    });
    // <--- نهاية التعديل على ws.on('close')

// <--- بداية التعديل على ws.on('error')
ws.on('error', (error) => {
    console.error(`[Chat ID: ${chatId}] Deriv WebSocket error: ${error.message}`);
    bot.sendMessage(chatId, `❌ خطأ في اتصال Deriv: ${error.message}.`);
    // عند حدوث خطأ، نقوم بإغلاق الاتصال الحالي بشكل صريح.
    // إغلاق الاتصال سيؤدي إلى تشغيل حدث 'close' (ws.on('close')).
    // ثم، ws.on('close') هي التي ستقرر ما إذا كانت ستحاول إعادة الاتصال أم لا.
    if (ws.readyState === WebSocket.OPEN) {
        ws.close(); 
    }
    // لا حاجة لوضع config.running = false; أو delete userDerivConnections[chatId]; هنا،
    // لأن ws.on('close') ستتعامل مع ذلك.
});
     }
// <--- نهاية التعديل على ws.on('error')
// <--- بداية دالة enterTrade المصححة بالكامل
// هذه الدالة ترسل طلب الاقتراح باستخدام اتصال WebSocket الموجود.
// لا تقوم بإنشاء اتصال جديد أو معالجة الرسائل.
async function enterTrade(config, direction, chatId, ws) {
    // التحقق من أن اتصال WebSocket نشط ومفتوح
    if (ws && ws.readyState === WebSocket.OPEN) {
        // <--- هذا هو السطر الذي يضمن رقمين بعد الفاصلة
        const formattedStake = parseFloat(config.currentStake.toFixed(2)); 

        console.log(`[Chat ID: ${chatId}] إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake}`); 

        // إرسال طلب الاقتراح (proposal) إلى Deriv API
        // هذا هو المكان الوحيد الذي يجب أن يتم فيه إرسال طلب الاقتراح داخل هذه الدالة
        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake, // <--- وهنا يتم استخدام المبلغ المنسق (formattedStake)
            "basis": "stake",
            "contract_type": direction, // 'CALL' أو 'PUT'
            "currency": "USD", // العملة (يمكن أن تكون متغيراً في config إذا أردت)
            "duration": 1,
            "duration_unit": "m", // مدة الصفقة دقيقة واحدة
            "symbol": "R_100" // الأصل المالي (R_100)
        }));
    } else {
        // هذا الجزء يتم تنفيذه إذا لم يكن اتصال WebSocket مفتوحاً
        console.error(`[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط.`);
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
        // يمكنك هنا اختيار إيقاف البوت إذا كان الاتصال غير نشط بشكل دائم:
        // config.running = false;
        // if (ws) ws.close();
    }
    // <--- بداية دالة reconnectDeriv الجديدة (المكان الذي يجب أن تضعها فيه)
    // هذه الدالة هي المسؤولة عن محاولة إعادة الاتصال بـ Deriv API
    function reconnectDeriv(chatId, config) {
        // إذا كان البوت متوقفاً يدوياً بواسطة المستخدم (عبر أمر /stop مثلاً)،
        // فلا يجب أن نحاول إعادة الاتصال.
        if (!config.running) {
            console.log(`[Chat ID: ${chatId}] البوت متوقف، لن تتم محاولة إعادة الاتصال.`);
            return; // توقف هنا، لا تفعل شيئاً آخر
        }

        // إرسال رسالة للمستخدم لإعلامه بأننا نحاول إعادة الاتصال
        console.log(`[Chat ID: ${chatId}] جاري محاولة إعادة الاتصال بـ Deriv في 5 ثوانٍ...`);
        bot.sendMessage(chatId, '🔄 جاري محاولة إعادة الاتصال بـ Deriv...');

        // قبل محاولة إعادة الاتصال، نحتاج إلى "مسح" المرجع إلى الاتصال القديم.
        // هذا يضمن أن startBotForUser ستقوم بإنشاء اتصال WebSocket جديد تماماً.
        if (userDerivConnections[chatId]) {
            delete userDerivConnections[chatId]; // حذف المرجع للاتصال القديم
        }

        // ننتظر 5 ثوانٍ (5000 مللي ثانية) قبل محاولة إعادة الاتصال الفعلية
        setTimeout(() => {
            // نتحقق مرة أخرى إذا كان البوت لا يزال قيد التشغيل بعد انتهاء مدة الانتظار
            if (config.running) {
                // إذا كان لا يزال قيد التشغيل، نستدعي دالة startBotForUser مرة أخرى
                // لتقوم بإنشاء اتصال جديد وبدء العمل من جديد.
                startBotForUser(chatId, config);
            } else {
                console.log(`[Chat ID: ${chatId}] البوت توقف أثناء فترة انتظار إعادة الاتصال.`);
            }
        }, 1000); // 1000 مللي ثانية = 1 ثوانٍ
    }
    // <--- نهاية دالة reconnectDeriv الجديدة
}
