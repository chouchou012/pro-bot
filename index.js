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
        candle10MinOpenPrice: null,        // لتخزين سعر افتتاح الشمعة العشر دقائق الحالية
            lastProcessed10MinIntervalStart: -1, // لمنع تكرار التحليل في نفس الشمعة
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
    // تهيئة متغيرات المارتينغال والتداول إذا لم تكن موجودة.
    // هذه الإعدادات مهمة لضمان عمل منطق المضاعفة بشكل صحيح.
    if (typeof config.currentTradeCountInCycle === 'undefined') {
        config.currentTradeCountInCycle = 0; // يتتبع عدد الخسائر المتتالية في دورة المارتينغال
    }
    if (typeof config.tradingCycleActive === 'undefined') {
        config.tradingCycleActive = false; // صحيح عندما تكون دورة مارتينغال نشطة
    }
    // متغيرات لتتبع الشمعة 10 دقائق
    if (typeof config.candle10MinOpenPrice === 'undefined') {
        config.candle10MinOpenPrice = null; // يخزن سعر افتتاح شمعة الـ 10 دقائق الحالية
    }
    if (typeof config.lastProcessed10MinIntervalStart === 'undefined') {
        config.lastProcessed10MinIntervalStart = -1; // يخزن الدقيقة التي تم فيها معالجة بداية شمعة الـ 10 دقائق الأخيرة
    }

    // إغلاق أي اتصال Deriv قديم للمستخدم المحدد قبل إنشاء اتصال جديد
    if (userDerivConnections[chatId]) {
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    // إنشاء اتصال WebSocket جديد بـ Deriv
    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');
    userDerivConnections[chatId] = ws; // تخزين الاتصال بهذا الـ chatId

    // عند فتح الاتصال
    ws.on('open', () => {
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token })); // إرسال توكن المصادقة
    });

    // عند تلقي رسالة من Deriv
    ws.on('message', async (data) => {
        const msg = JSON.parse(data);

        // إذا توقف البوت يدوياً (/stop)، أغلق الاتصال وتوقف
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
                config.running = false; // أوقف البوت إذا فشلت المصادقة
                ws.close();
            } else {
                bot.sendMessage(chatId, `✅ تم تسجيل الدخول بنجاح! الرصيد: ${msg.authorize.balance} ${msg.authorize.currency}`);
                // الاشتراك في التيكات (R_100 هو أصل عشوائي لتلقي بيانات السوق)
                ws.send(JSON.stringify({
                    "ticks": "R_100",
                    "subscribe": 1
                }));
            }
        }
        // معالجة رسائل التيكات (حركة السعر اللحظية)
        else if (msg.msg_type === 'tick' && msg.tick) {
            const currentTickPrice = parseFloat(msg.tick.quote);
            const tickEpoch = msg.tick.epoch;
            const tickDate = new Date(tickEpoch * 1000);
            const currentMinute = tickDate.getMinutes();
            const currentSecond = tickDate.getSeconds();

            // حساب بداية فترة الـ 10 دقائق الحالية (مثال: 00, 10, 20, 30, 40, 50)
            const current10MinIntervalStartMinute = Math.floor(currentMinute / 10) * 10;

            // هذا الجزء يتم تشغيله فقط في الثانية 00 من الدقائق 0, 10, 20, 30, 40, 50
            if (currentSecond === 0 && currentMinute === current10MinIntervalStartMinute) {
                // هذا الشرط يضمن أننا نعالج بداية شمعة 10 دقائق جديدة مرة واحدة فقط لكل فترة
                if (config.lastProcessed10MinIntervalStart !== current10MinIntervalStartMinute) {

                    let tradeDirection = 'none'; // الاتجاه لصفقة الدخول الحالية

                    // إذا كان لدينا سعر افتتاح مسجل من الشمعة الـ 10 دقائق السابقة،
                    // فهذا يعني أن الشمعة السابقة قد اكتملت الآن.
                    // السعر الحالي (أول تيك في الشمعة الجديدة) هو سعر إغلاق الشمعة السابقة.
                    if (config.candle10MinOpenPrice !== null) {
                        const previousCandleOpen = config.candle10MinOpenPrice;
                        const previousCandleClose = currentTickPrice; // إغلاق الشمعة السابقة هو افتتاح الشمعة الحالية

                        // تحليل اتجاه الشمعة السابقة (التي انتهت للتو)
                        if (previousCandleClose < previousCandleOpen) {
                            tradeDirection = 'CALL'; // الشمعة السابقة كانت هابطة
                            bot.sendMessage(chatId, `📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                        } else if (previousCandleClose > previousCandleOpen) {
                            tradeDirection = 'PUT'; // الشمعة السابقة كانت صاعدة
                            bot.sendMessage(chatId, `📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                        } else {
                            bot.sendMessage(chatId, `↔ الشمعة السابقة (10 دقائق) بدون تغيير. لا يوجد اتجاه واضح.`);
                        }
                    } else {
                        // هذه هي المرة الأولى التي يبدأ فيها البوت، أو بعد إعادة تشغيل،
                        // لا توجد شمعة سابقة للتحليل بعد.
                        bot.sendMessage(chatId, `⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه.`);
                        // في هذه الحالة، نسجل سعر الافتتاح للشمعة الحالية ونخرج لأننا لا ندخل صفقة بعد.
                        config.candle10MinOpenPrice = currentTickPrice;
                        config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute;
                        console.log(`[Chat ID: ${chatId}] Initial 10-min candle started. Open Price: ${config.candle10MinOpenPrice.toFixed(3)} at ${currentMinute}:${currentSecond}`);
                        return; // *هنا المكان الأول لـ return;* يوقف المعالجة لهذه الشمعة بعد تسجيل بياناتها الأولية.
                    }

                    // محاولة الدخول في صفقة إذا تم تحديد اتجاه صالح والبوت يعمل ولم يكن هناك دورة تداول نشطة
                    if (tradeDirection !== 'none' && config.running && !config.tradingCycleActive) { // *أهم إضافة هنا: && !config.tradingCycleActive*
                        // إرسال رسالة لتوضيح ما إذا كانت صفقة أساسية أم مارتينغال
                        if (config.currentTradeCountInCycle > 0) {
                             bot.sendMessage(chatId, `🔄 جاري الدخول في صفقة مارتينغال رقم (${config.currentTradeCountInCycle}) بمبلغ ${config.currentStake.toFixed(2)}$ بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                             console.log(`[Chat ID: ${chatId}] Entering Martingale trade (${config.currentTradeCountInCycle}): ${tradeDirection} for ${config.currentStake.toFixed(2)}$ at ${currentMinute}:00`);
                        } else {
                            bot.sendMessage(chatId, `✅ جاري الدخول في صفقة أساسية بمبلغ ${config.currentStake.toFixed(2)}$ بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                            console.log(`[Chat ID: ${chatId}] Entering base trade: ${tradeDirection} for ${config.currentStake.toFixed(2)}$ at ${currentMinute}:00`);
                        }
                        await enterTrade(config, tradeDirection, chatId, ws);
                        config.tradingCycleActive = true; // وضع علامة على أن دورة التداول نشطة

                        // تحديث سعر الافتتاح لشمعة الـ 10 دقائق الجديدة التي بدأت للتو.
                        config.candle10MinOpenPrice = currentTickPrice;
                        config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute; // وضع علامة على أن هذه الفترة قد تمت معالجتها
                        console.log(`[Chat ID: ${chatId}] New 10-min candle started. Open Price: ${config.candle10MinOpenPrice.toFixed(3)} at ${currentMinute}:${currentSecond}`);
                        return; // *هنا المكان الثاني لـ return;* يوقف المعالجة بعد محاولة الدخول في صفقة.
                    } else if (config.candle10MinOpenPrice !== null) { // إذا لم يتم الدخول في صفقة وكان هناك شمعة سابقة
                        console.log(`[Chat ID: ${chatId}] لا توجد صفقة: البوت غير فعال أو لا يوجد اتجاه واضح للشمعة السابقة أو دورة تداول نشطة.`);
                        // إذا لم يتم الدخول في صفقة، أعد تعيين الحالة للاستعداد للشمعة الـ 10 دقائق التالية
                        config.tradingCycleActive = false; // مهم: إعادة تعيين إذا لم يتمكن من الدخول
                        config.currentStake = config.stake; // إعادة الستيك الأساسي إذا لم يتم الدخول في صفقة في هذه الدورة
                        config.currentTradeCountInCycle = 0; // إعادة تعيين العداد

                        // تحديث سعر الافتتاح لشمعة الـ 10 دقائق الجديدة التي بدأت للتو.
                        config.candle10MinOpenPrice = currentTickPrice;
                        config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute; // وضع علامة على أن هذه الفترة قد تمت معالجتها
                        console.log(`[Chat ID: ${chatId}] New 10-min candle started. Open Price: ${config.candle10MinOpenPrice.toFixed(3)} at ${currentMinute}:${currentSecond}`);
                        return; // *هنا المكان الثالث لـ return;* يوقف المعالجة بعد تحديث الحالة لعدم الدخول.
                    }
                }
            }
        }

        // معالجة استجابات الاقتراح (بعد طلب الصفقة)
        else if (msg.msg_type === 'proposal') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                // في حالة فشل الاقتراح، نعتبرها خسارة ونطبق منطق المارتينغال
                config.loss++; 
                config.currentTradeCountInCycle++; // زيادة عداد الخسائر لدورة المارتينغال
                config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2)); // تطبيق مضاعفة المارتينغال
                bot.sendMessage(chatId, `❌ فشل الاقتراح. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والانتظار للشمعة الـ 10 دقائق التالية.`);
                config.tradingCycleActive = false; // إنهاء هذه المحاولة، والانتظار للشمعة التالية
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
        // معالجة استجابات الشراء (بعد تأكيد الشراء)
        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                bot.sendMessage(chatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
                // في حالة فشل الشراء، نعتبرها خسارة ونطبق منطق المارتينغال
                config.loss++; 
                config.currentTradeCountInCycle++; // زيادة عداد الخسائر لدورة المارتينغال
                config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2)); // تطبيق مضاعفة المارتينغال
                bot.sendMessage(chatId, `❌ فشل الشراء. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والانتظار للشمعة الـ 10 دقائق التالية.`);
                config.tradingCycleActive = false; // إنهاء هذه المحاولة، والانتظار للشمعة التالية
                return;
            }
            const contractId = msg.buy.contract_id;
            bot.sendMessage(chatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}`);

            // بعد الشراء، اشترك في حالة العقد لمراقبته حتى ينتهي
            ws.send(JSON.stringify({
                "proposal_open_contract": 1,
                "contract_id": contractId,
                "subscribe": 1
            }));
        }
        // معالجة تحديثات حالة العقد (عند انتهاء الصفقة)
        else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract && msg.proposal_open_contract.is_sold === 1) {
            // هذا الجزء يتم تشغيله عند انتهاء الصفقة (بيع العقد)
            const contract = msg.proposal_open_contract;
            const profit = parseFloat(contract.profit);
            const win = profit > 0;

            config.profit += profit; // تحديث إجمالي الربح/الخسارة

            // إلغاء الاشتراك من هذا العقد بعد بيعه لتجنب التحديثات غير الضرورية
            ws.send(JSON.stringify({ "forget": contract.contract_id }));

            if (win) {
                config.win++;
                bot.sendMessage(chatId, `📊 نتيجة الصفقة: ✅ ربح! ربح: ${profit.toFixed(2)}$\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}$\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}\n\n✅ تم الربح. جاري انتظار شمعة 10 دقائق جديدة.`);

                // عند الربح، إعادة تعيين دورة المارتينغال بالكامل
                config.tradingCycleActive = false; // لم تعد هناك دورة مارتينغال نشطة
                config.currentTradeCountInCycle = 0; // إعادة تعيين عداد الخسائر المتتالية
                config.currentStake = config.stake; // إعادة الستيك إلى المبلغ الأساسي
            } else { // التعامل مع الخسارة
                config.loss++;
                config.currentTradeCountInCycle++; // زيادة عداد الخسائر في دورة المارتينغال الحالية

                let messageText = `📊 نتيجة الصفقة: ❌ خسارة! خسارة: ${Math.abs(profit).toFixed(2)}$\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}$\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`;

                // يمكنك تحديد الحد الأقصى لعدد خسائر المارتينغال هنا، مثلاً 5 صفقات
                const maxMartingaleLosses = 5; 

                if (config.currentTradeCountInCycle >= maxMartingaleLosses) { 
                    messageText += `\n🛑 تم الوصول إلى الحد الأقصى للخسائر في دورة المارتينغال (${maxMartingaleLosses} صفقات متتالية). تم إيقاف البوت تلقائياً.`;
                    bot.sendMessage(chatId, messageText);
                    config.running = false; // إيقاف البوت
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                } else {
                    // المارتينغال: زيادة الستيك للمحاولة التالية
                    config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2));
                    messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى ${config.currentStake.toFixed(2)}$ والانتظار للشمعة الـ 10 الدقائق التالية لدخول صفقة.`;
                    bot.sendMessage(chatId, messageText);
                    // config.tradingCycleActive تظل 'true' مما يشير إلى أن دورة مارتينغال مستمرة
                }
            }

            // التحقق من أهداف جني الأرباح (TP) ووقف الخسارة (SL) الكلية للبوت
            // هذا المنطق يجب أن يكون بعد تحديث الربح الكلي و الستيك، وقبل محاولة الدخول في صفقة جديدة
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
        // معالجة رسائل الخطأ العامة من Deriv API
        else if (msg.msg_type === 'error') {
            bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            console.error(`Deriv API Error: ${JSON.stringify(msg.error)}`);
            // في حالة الخطأ، من الأفضل إعادة ضبط الحالة لضمان عدم دخول صفقات خاطئة
            config.tradingCycleActive = false;
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
        }
    });

    // معالجة إغلاق الاتصال بـ WebSocket
    ws.on('close', (code, reason) => {
        console.log(`[Chat ID: ${chatId}] Deriv connection closed. Code: ${code}, Reason: ${reason}`);
        if (config.running) { // إذا كان البوت لا يزال يفترض أنه يعمل (لم يتم إيقافه يدوياً)
            bot.sendMessage(chatId, `💔 تم قطع الاتصال بـ Deriv. جاري محاولة إعادة الاتصال...`);
            // تأكد أن دالة reconnectDeriv معرفة في النطاق العام (خارج هذه الدالة)
            // هذه الدالة (reconnectDeriv) يجب أن تكون موجودة في ملفك.
            reconnectDeriv(chatId, config); 
        } else {
            bot.sendMessage(chatId, `🛑 تم إغلاق اتصال Deriv بشكل نهائي.`);
        }
    });

    // معالجة أخطاء الاتصال بـ WebSocket
    ws.on('error', (error) => {
        console.error(`[Chat ID: ${chatId}] Deriv WebSocket Error:, error`);
        bot.sendMessage(chatId, `❌ حدث خطأ في اتصال Deriv: ${error.message}. جاري المحاولة مرة أخرى...`);
        // عند حدوث خطأ، نقوم بإغلاق الاتصال الحالي بشكل صريح.
        // إغلاق الاتصال سيؤدي إلى تشغيل حدث 'close' (ws.on('close')).
        // ثم، ws.on('close') هي التي ستقرر ما إذا كانت ستحاول إعادة الاتصال أم لا.
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(); 
        }
    });

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
    }
