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

// -------------------------------------------------------------------------
// دوال المساعدة (Helper Functions)
// -------------------------------------------------------------------------

// دالة لحفظ جميع حالات المستخدمين إلى ملف JSON
function saveUserStates() {
    try {
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userStates, null, 2), 'utf8');
        // console.log('User states saved successfully.'); // يمكنك تفعيل هذا للتصحيح
    } catch (error) {
        console.error('Error saving user states:', error.message);
    }
}

// دالة لتحميل جميع حالات المستخدمين من ملف JSON عند بدء التشغيل
function loadUserStates() {
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
        console.log( `[Chat ID: ${chatId}] البوت متوقف، لن تتم محاولة إعادة الاتصال. `);
        return;
    }

    console.log( `[Chat ID: ${chatId}] جاري محاولة إعادة الاتصال بـ Deriv في 5 ثوانٍ... `);
    bot.sendMessage(chatId, '🔄 جاري محاولة إعادة الاتصال بـ Deriv...');

    if (userDerivConnections[chatId]) {
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    setTimeout(() => {
        if (config.running) {
            // هنا نمرر 'true' لـ isReconnect لكي لا يتم إعادة ضبط المتغيرات
            startBotForUser(chatId, config, true);
        } else {
            console.log( `[Chat ID: ${chatId}] البوت توقف أثناء فترة انتظار إعادة الاتصال. `);
        }
    }, 5000); // 5 ثوانٍ
}

// دالة للدخول في الصفقة
async function enterTrade(config, direction, chatId, ws) {
    // التحقق مما إذا كان اتصال WebSocket نشطًا ومفتوحًا قبل إرسال الطلب
    if (ws && ws.readyState === WebSocket.OPEN) {
        const formattedStake = parseFloat(config.currentStake.toFixed(2));
        bot.sendMessage(chatId,  `⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ... `);

        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake,
            "basis": "stake",
            "contract_type": direction, // 'CALL' (صعود) أو 'PUT' (هبوط)
            "currency": "USD",
            "duration": 60,         // <--- تم تغيير المدة إلى 60 ثانية
            "duration_unit": "s",   // <--- تم تغيير الوحدة إلى "s"
            "symbol": "R_100", // الرمز الذي تتداول عليه
        }));
    } else {
        bot.sendMessage(chatId,  `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة. `);
        console.error( `[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط. `);
        // إعادة ضبط الدورة إذا لم يتمكن من الدخول بسبب الاتصال
        config.tradingCycleActive = false;
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.initialTradeDirectionForCycle = 'none';
        config.currentContractId = null; // إعادة تعيين ID العقد
        config.outcomeDetermined = false; // إعادة تعيين حالة التقييم
        saveUserStates();
    }
}

// دالة لمعالجة نتائج الصفقة (الربح والخسارة) - تم تعديلها لدعم التقييم المخصص
async function handleTradeResult(chatId, config, msg, ws, customOutcome = null, customProfitLoss = null) {
    const contract = msg.proposal_open_contract;
    let profitLoss = customProfitLoss !== null ? customProfitLoss : parseFloat(contract.profit);
    let tradeOutcome = customOutcome !== null ? customOutcome : (profitLoss > 0 ? 'win' : 'lose');

    console.log( `[DEBUG] handleTradeResult for contract ${contract.contract_id}. Final Outcome: ${tradeOutcome}, P/L: ${profitLoss.toFixed(2)} `);

    // تأكد من تحديث الرصيد بغض النظر عن طريقة تحديد النتيجة
    if (typeof contract.balance_after_sell === 'number' || (typeof contract.balance_after_sell === 'string' && !isNaN(parseFloat(contract.balance_after_sell)))) {
        config.balance = parseFloat(contract.balance_after_sell); // تحديث الرصيد بعد البيع
    } else {
        console.error( `[Chat ID: ${chatId}] قيمة balance_after_sell غير صالحة: ${contract.balance_after_sell} `);
    }

    if (tradeOutcome === 'win') {
        config.profit += profitLoss;
        config.win++;
        bot.sendMessage(chatId,  `✅ ربح! مبلغ الربح: ${profitLoss.toFixed(2)}$. الرصيد الحالي: ${config.balance.toFixed(2)}$ `);
        console.log( `[Chat ID: ${chatId}] Trade result: WIN. Profit: ${profitLoss.toFixed(2)}$ `);

        // إعادة تعيين الستيك وعداد المارتينجال وإيقاف الدورة لبدء دورة جديدة عند شمعة 10 دقائق جديدة
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.tradingCycleActive = false;
        config.initialTradeDirectionForCycle = 'none';
        config.currentContractId = null;
        bot.sendMessage(chatId,  `💰 تم تحقيق ربح. البوت في وضع الانتظار لشمعة 10 دقائق جديدة. `);
        console.log( `[${chatId}] ربح في الصفقة. الرصيد: ${config.balance.toFixed(2)}. انتظار شمعة 10 دقائق جديدة. `);

    } else { // 'lose'
        config.profit += profitLoss; // الربح سيكون سالباً هنا
        config.loss++;
        config.currentTradeCountInCycle++;

        bot.sendMessage(chatId,  `❌ خسارة! مبلغ الخسارة: ${Math.abs(profitLoss).toFixed(2)}$. الرصيد الحالي: ${config.balance.toFixed(2)}$ `);
        console.log( `[${chatId}] خسارة في الصفقة. الرصيد: ${config.balance.toFixed(2)}. `);

        // التحقق من تجاوز أقصى عدد للمضاعفات
        if (config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
            bot.sendMessage(chatId,  `🛑 تم الوصول للحد الأقصى من المضاعفات (${config.maxMartingaleTrades} خسائر متتالية). إيقاف الدورة. `);
            console.log( `[${chatId}] Max Martingale trades reached. Stopping cycle. `);

            // إعادة ضبط الستيك وعداد المارتينجال وإيقاف الدورة
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            config.tradingCycleActive = false;
            config.initialTradeDirectionForCycle = 'none';
            config.currentContractId = null;
            config.running = false; // إيقاف البوت تلقائياً عند الوصول للحد الأقصى
            bot.sendMessage(chatId,  `💰 البوت في وضع الانتظار لشمعة 10 دقائق جديدة. `);

        } else {
            // الاستمرار في المضاعفة: زيادة الستيك والدخول في صفقة فوراً بنفس الاتجاه
            config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2)); // تطبيق المارتينجال وتقريب المبلغ
            const reverseDirection = config.initialTradeDirectionForCycle === 'CALL' ? 'PUT' : 'CALL';
            bot.sendMessage(chatId,  `🔄 جاري الدخول في صفقة مضاعفة رقم ${config.currentTradeCountInCycle} بمبلغ ${config.currentStake.toFixed(2)}$. `);
            console.log( `[${chatId}] جاري الدخول في مضاعفة رقم ${config.currentTradeCountInCycle} باتجاه ${reverseDirection} بمبلغ ${config.currentStake.toFixed(2)}. `);

            // الدخول الفوري في صفقة مضاعفة بنفس اتجاه الصفقة الأساسية للدورة
            await enterTrade(config, reverseDirection, chatId, ws);
        }
    }
    // مهم جداً: إعادة ضبط outcomeDetermined بعد معالجة الصفقة بالكامل
    config.outcomeDetermined = false;
    saveUserStates();
    // ... (الكود الحالي داخل دالة handleTradeResult، بعد معالجة الربح والخسارة) ...

        // مهم جداً: إعادة ضبط outcomeDetermined بعد معالجة الصفقة بالكامل
        config.outcomeDetermined = false;
        saveUserStates();

        // ***** إضافة جديدة: عرض الرصيد المحدث بعد 5 ثوانٍ *****
        setTimeout(() => {
            // نطلب الرصيد المحدث من Deriv
            ws.send(JSON_stringify({ "balance": 1 }));
            // سيتم معالجة استجابة الرصيد في كتلة msg.msg_type === 'balance'
        }, 5000); // 5 ثوانٍ تأخير
    // نهاية دالة handleTradeResult
}

// دالة رئيسية لبدء تشغيل البوت لكل مستخدم
// إضافة isReconnect = false كبارامتر افتراضي
function startBotForUser(chatId, config, isReconnect = false) {
    if (userDerivConnections[chatId]) {
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    // تهيئة المتغيرات عند بدء التشغيل
    config.running = true; // تأكيد أن البوت أصبح قيد التشغيل

    // هذه المتغيرات يتم إعادة ضبطها فقط إذا لم تكن عملية إعادة اتصال
    if (!isReconnect) {
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.tradingCycleActive = false;
        config.initialTradeDirectionForCycle = 'none';
        config.currentContractId = null;
        config.outcomeDetermined = false; // تهيئة متغير التقييم المخصص
        config.checkTimeForOutcome = null; // تهيئة وقت التحقق

        // إعادة تعيين الأرباح والخسائر والعدادات عند بدء تشغيل جديد فقط (وليس عند إعادة الاتصال)
        config.profit = 0;
        config.win = 0;
        config.loss = 0;

        // إعادة تهيئة متغيرات شمعة الـ 10 دقائق والدورة لضمان بداية نظيفة
        config.candle10MinOpenPrice = null;
        config.lastProcessed10MinIntervalStart = -1;
    }

    // إضافة إعدادات المضاعفة الافتراضية إذا لم تكن موجودة
    config.martingaleFactor = config.martingaleFactor || 2.2;
    config.maxMartingaleTrades = config.maxMartingaleTrades || 4;

    saveUserStates(); // حفظ حالة إعادة الضبط

    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');
    userDerivConnections[chatId] = ws;

    ws.on('open', () => {
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token }));
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);

        // إذا كان البوت ليس قيد التشغيل، أغلق الاتصال وتوقف عن المعالجة
        if (!config.running) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
                bot.sendMessage(chatId, '🛑 تم إغلاق اتصال Deriv.');
            }
            return;
        }

        if (msg.msg_type === 'authorize') {
            if (msg.error) {
                bot.sendMessage(chatId,  `❌ فشلت المصادقة: ${msg.error.message}. يرجى التحقق من API Token. `);
                config.running = false;
                ws.close();
                saveUserStates();
            } else {
                // الكود الذي ستضيفه داخل if (msg.msg_type === 'authorize')
                config.balance = parseFloat(msg.authorize.balance);
                if (!isReconnect) { // نضمن تسجيل الرصيد الأولي فقط عند التشغيل الأول وليس عند إعادة الاتصال
                    config.initialBalanceForTP = config.balance;
                }
                config.tpEnabled = (config.takeProfitAmount > 0);
                bot.sendMessage(chatId,  `✅ تم تسجيل الدخول بنجاح! الرصيد: ${config.balance.toFixed(2)} ${msg.authorize.currency} `);
                ws.send(JSON.stringify({
                    "ticks": "R_100",
                    "subscribe": 1
                }));

                // **** إضافة جديدة هنا: إعادة الاشتراك في العقد المفتوح عند إعادة الاتصال ****
                if (config.running && config.tradingCycleActive && config.currentContractId) {
                    bot.sendMessage(chatId,  `🔄 تم إعادة الاتصال. جاري متابعة العقد القديم: ${config.currentContractId} `);
                    ws.send(JSON.stringify({
                        "proposal_open_contract": 1,
                        "contract_id": config.currentContractId,
                        "subscribe": 1 // إعادة الاشتراك لتلقي تحديثات هذا العقد
                    }));
                }
                // *******************************************************
            }
        }
        else if (msg.msg_type === 'tick' && msg.tick) {
            const currentTickPrice = parseFloat(msg.tick.quote);
            const tickEpoch = msg.tick.epoch;
            const tickDate = new Date(tickEpoch * 1000);
            const currentMinute = tickDate.getMinutes();
            const currentSecond = tickDate.getSeconds();

            const current10MinIntervalStartMinute = Math.floor(currentMinute / 10) * 10;

            // عند بداية شمعة 10 دقائق جديدة (00 ثانية)
            if (currentSecond === 0 && currentMinute === current10MinIntervalStartMinute) {
                // هذا الشرط يضمن معالجة بداية شمعة 10 دقائق مرة واحدة فقط
                if (config.lastProcessed10MinIntervalStart !== current10MinIntervalStartMinute) {
                    let tradeDirection = 'none';

                    // حساب اتجاه الشمعة الـ 10 دقائق السابقة (إذا كانت موجودة)
                    if (config.candle10MinOpenPrice !== null) {
                        const previousCandleOpen = config.candle10MinOpenPrice;
                        const previousCandleClose = currentTickPrice;

                        if (previousCandleClose < previousCandleOpen) {
                            tradeDirection = 'CALL'; // شمعة هابطة، ندخل CALL
                            bot.sendMessage(chatId,  `📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}). `);
                        } else if (previousCandleClose > previousCandleOpen) {
                            tradeDirection = 'PUT'; // شمعة صاعدة، ندخل PUT
                            bot.sendMessage(chatId,  `📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}). `);
                        } else {
                            bot.sendMessage(chatId,  `↔ الشمعة السابقة (10 دقائق) بدون تغيير. لا يوجد اتجاه واضح. `);
                        }
                    } else {
                        bot.sendMessage(chatId,  `⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه. `);
                    }

                    // تحديث سعر فتح الشمعة الـ 10 دقائق الحالية
                    config.candle10MinOpenPrice = currentTickPrice;
                    config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute;
                    saveUserStates(); // حفظ بعد تحديث بيانات الشمعة

                    // شرط الدخول في الصفقة الأساسية لدورة جديدة:
                    // 1. يوجد اتجاه واضح
                    // 2. البوت قيد التشغيل
                    // 3. لا توجد دورة تداول نشطة حالياً (أي ليست صفقة مارتينجال)
                    if (tradeDirection !== 'none' && config.running && !config.tradingCycleActive) {
                        config.tradingCycleActive = true; // بدء دورة تداول جديدة
                        config.initialTradeDirectionForCycle = tradeDirection; // حفظ الاتجاه الأساسي للدورة

                        bot.sendMessage(chatId,  `✅ جاري الدخول في صفقة أساسية بمبلغ ${config.currentStake.toFixed(2)}$ بناءً على شمعة الـ 10 دقائق (${tradeDirection}). `);
                        await enterTrade(config, tradeDirection, chatId, ws);
                        saveUserStates(); // حفظ بعد بدء دورة التداول
                    } else {
                        // إذا لم يتم الدخول في صفقة (لعدم وجود اتجاه أو وجود دورة نشطة)،
                        // نقوم بإعادة ضبط الستيك والعداد إذا لم تكن هناك دورة نشطة
                        if (!config.tradingCycleActive) {
                             config.currentStake = config.stake;
                             config.currentTradeCountInCycle = 0;
                             config.initialTradeDirectionForCycle = 'none';
                             saveUserStates();
                        }
                    }
                    return; // مهم: الخروج بعد معالجة الثانية 00 لمنع التكرار
                }
            }
        }
        else if (msg.msg_type === 'proposal') {
            if (msg.error) {
                bot.sendMessage(chatId,  `❌ فشل اقتراح الصفقة: ${msg.error.message} `);
                // في حالة فشل الاقتراح، نعتبرها خسارة ونطبق المضاعفة الفورية
                config.profit += -config.currentStake; // اعتبار الستيك خسارة
                config.loss++;
                config.currentTradeCountInCycle++;

                // التحقق من تجاوز أقصى عدد للمضاعفات
                if (config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
                    bot.sendMessage(chatId, '⛔ تم الوصول إلى أقصى عدد للمضاعفات. جاري إعادة ضبط الدورة.');
                    config.currentStake = config.stake;
                    config.currentTradeCountInCycle = 0;
                    config.tradingCycleActive = false;
                    config.initialTradeDirectionForCycle = 'none';
                    config.currentContractId = null;
                    config.running = false; // إيقاف البوت تلقائياً عند الوصول للحد الأقصى
                    config.outcomeDetermined = false; // إعادة تعيين حالة التقييم
                    bot.sendMessage(chatId,  `💰 البوت في وضع الانتظار لشمعة 10 دقائق جديدة. `);
                    saveUserStates();
                } else {
                    config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2));
                    const reverseDirection = config.initialTradeDirectionForCycle === 'CALL' ? 'PUT' : 'CALL';
                    bot.sendMessage(chatId,  `❌ فشل الاقتراح. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والدخول فوراً. `);
                    await enterTrade(config, reverseDirection, chatId, ws);
                    saveUserStates();
                }
                return;
            }

            const proposalId = msg.proposal.id;
            const askPrice = msg.proposal.ask_price;
            bot.sendMessage(chatId,  `✅ تم الاقتراح: السعر المطلوب ${askPrice.toFixed(2)}$. جاري الشراء... `);

            ws.send(JSON.stringify({
                "buy": proposalId,
                "price": askPrice
            }));
        }
        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                bot.sendMessage(chatId,  `❌ فشل شراء الصفقة: ${msg.error.message} `);
                // في حالة فشل الشراء، نعتبرها خسارة ونطبق المضاعفة الفورية
                config.profit += -config.currentStake; // اعتبار الستيك خسارة
                config.loss++;
                config.currentTradeCountInCycle++;

                // التحقق من تجاوز أقصى عدد للمضاعفات
                if (config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
                    bot.sendMessage(chatId, '⛔ تم الوصول إلى أقصى عدد للمضاعفات. جاري إعادة ضبط الدورة.');
                    config.currentStake = config.stake;
                    config.currentTradeCountInCycle = 0;
                    config.tradingCycleActive = false;
                    config.initialTradeDirectionForCycle = 'none';
                    config.currentContractId = null;
                    config.running = false; // إيقاف البوت تلقائياً
                    config.outcomeDetermined = false; // إعادة تعيين حالة التقييم
                    bot.sendMessage(chatId,  `💰 البوت في وضع الانتظار لشمعة 10 دقائق جديدة. `);
                    saveUserStates();
                } else {
                    config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2));
                    const reverseDirection = config.initialTradeDirectionForCycle === 'CALL' ? 'PUT' : 'CALL';
                    bot.sendMessage(chatId,  `❌ فشل الشراء. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والدخول فوراً. `);
                    await enterTrade(config, reverseDirection, chatId, ws);
                    saveUserStates();
                }
                return;
            }

            const contract = msg.buy;
            const contractId = contract.contract_id;
            const buyPrice = contract.buy_price;
            const entryTickQuote = contract.entry_tick_quote;   // سعر الدخول الفعلي
            const entryTickTime = contract.entry_tick_time;     // وقت الدخول الفعلي

            config.currentContractId = contractId; // حفظ Contract ID للعقد المفتوح
            config.currentContractEntrySpot = parseFloat(entryTickQuote); // حفظ سعر الدخول
            config.currentContractEntryTime = entryTickTime;             // حفظ وقت الدخول

            // ***** إضافة جديدة: حساب وقت بداية الشمعة ووقت التحقق (الثانية 58) *****
            const entryMinuteStartTime = Math.floor(entryTickTime / 60) * 60; // بداية الدقيقة التي دخلت فيها الصفقة
            config.checkTimeForOutcome = entryMinuteStartTime + 58; // وقت الثانية 58 من تلك الشمعة
            config.outcomeDetermined = false; // تهيئة عند شراء صفقة جديدة
            // *******************************************************************

            saveUserStates(); // حفظ حالة المستخدم

            bot.sendMessage(chatId,  `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$. Contract ID: ${contractId}. سعر الدخول: ${entryTickQuote}. `);
            console.log( `[Chat ID: ${chatId}] Contract bought: ${contractId} for ${buyPrice.toFixed(2)}$. Entry Spot: ${entryTickQuote}, Entry Time: ${entryTickTime}, Check Time (58s candle): ${config.checkTimeForOutcome} `);

            // الاشتراك في حالة العقد المفتوح
            ws.send(JSON.stringify({
                "proposal_open_contract": 1,
                "contract_id": contractId,
                "subscribe": 1
            }));
        }
        // ***********************************************************************************
        // تعديل: منطق التقييم عند الثانية 58
        // هذا الجزء سيعالج تحديثات العقد المفتوح قبل أن يتم بيعه تلقائياً بواسطة Deriv
        // ***********************************************************************************
        else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
            const contract = msg.proposal_open_contract;

            // إذا الصفقة لسا مفتوحة وعندنا معلوماتها ومعلومات وقت التحقق ولم يتم تحديد النتيجة بعد
            if (config.running && config.tradingCycleActive && config.currentContractId === contract.contract_id && contract.is_sold !== 1 && config.currentContractEntrySpot !== null && config.checkTimeForOutcome !== null && !config.outcomeDetermined) {
                const currentSpot = parseFloat(contract.current_spot); // السعر الحالي
                const currentTime = contract.current_spot_time;       // الوقت الحالي للسعر (Unix timestamp)

                // // لغرض التشخيص: اطبع القيم في السجلات
                // console.log([DEBUG] Monitoring contract ${contract.contract_id}. Current Time: ${currentTime}, Check Time: ${config.checkTimeForOutcome}, Current Spot: ${currentSpot}, Entry Spot: ${config.currentContractEntrySpot});


                // الشرط الحاسم: هل الوقت الحالي وصل أو تجاوز وقت التحقق (الثانية 58 من الشمعة)؟
                if (currentTime >= config.checkTimeForOutcome) {
                    let customOutcome = 'undefined';

                    // تحديد النتيجة بناءً على اتجاه الصفقة الأصلي
                    if (config.initialTradeDirectionForCycle === 'CALL') { // لو الصفقة كانت صعود
                        if (currentSpot > config.currentContractEntrySpot) {
                            customOutcome = 'win';
                        } else {
                            customOutcome = 'lose';
                        }
                    } else if (config.initialTradeDirectionForCycle === 'PUT') { // لو الصفقة كانت هبوط
                        if (currentSpot < config.currentContractEntrySpot) {
                            customOutcome = 'win';
                        } else {
                            customOutcome = 'lose';
                        }
                    }

                    if (customOutcome !== 'undefined') {
                        // تقدير الربح أو الخسارة بناءً على النتيجة اليدوية (تقريبية)
                        // Deriv عادةً ما يدفع ~95% ربح للعقد، لذا نستخدم هذا للتقدير
                        const estimatedProfitLoss = customOutcome === 'win' ? config.currentStake * 0.95 : -config.currentStake;

                        bot.sendMessage(chatId,  `⏱ تم تقييم الصفقة عند الثانية 58 من الشمعة: ${customOutcome.toUpperCase()}! `);
                        console.log( `[Chat ID: ${chatId}] Trade assessed at candle 58s: ${customOutcome.toUpperCase()}. Estimated P/L: ${estimatedProfitLoss.toFixed(2)}$ `);

                        // إرسال أمر بيع فوري لـ Deriv لإغلاق الصفقة
                        ws.send(JSON.stringify({ "sell": contract.contract_id, "price": 0 }));

                        // تحديد أن النتيجة تم تحديدها يدوياً لمنع التقييم المزدوج لاحقاً
                        config.outcomeDetermined = true;
                        // استدعاء دالة معالجة النتيجة مع النتيجة اللي قررناها
                        await handleTradeResult(chatId, config, msg, ws, customOutcome, estimatedProfitLoss);

                        // مهم جداً: بعد إغلاقها يدويًا، قم بإفراغ معرف العقد لمنع المعالجة المزدوجة من Deriv
                        config.currentContractId = null;
                        // لا ننسى إفراغ checkTimeForOutcome و currentContractEntrySpot
                        config.checkTimeForOutcome = null;
                        config.currentContractEntrySpot = null;
                        saveUserStates();
                        return; // وقف معالجة هذه الرسالة
                    }
                }
            }

            // هذا الجزء يتعامل مع الصفقة بعد إغلاقها النهائي (سواء بالبيع اليدوي أو بانتهاء الدقيقة الأصلية)
            // بما أننا سنقوم بإغلاقها يدويًا، فمن المفترض أن هذا الجزء لن يعالجها إلا إذا فشل الإغلاق اليدوي
            // أو في حالات نادرة جداً. الشرط هو: الصفقة تم بيعها و لم يتم تحديد نتيجتها يدوياً بعد (أو كانت الصفقة مغلقة بالفعل)
            if (contract.is_sold === 1 && !config.outcomeDetermined) {
                // إذا وصلت هذه الحالة، فهذا يعني أن الصفقة قد تم بيعها بطريقة ما (انتهت مدتها أو تم بيعها تلقائيًا)
                // ولم يتم معالجتها بمنطق الثانية 58.
                // في هذه الحالة، يمكننا ببساطة استدعاء handleTradeResult لتقييمها بناءً على بيانات Deriv النهائية.
                // تأكد من عدم وجود تكرار إذا تم استدعاء handleTradeResult بالفعل من منطق الثانية 58
                handleTradeResult(chatId, config, msg, ws);
            }
        }
            else if (msg.msg_type === 'balance') {
                if (msg.error) {
                    console.error( `[Chat ID: ${chatId}] خطأ في جلب الرصيد: ${msg.error.message} `);
                    bot.sendMessage(chatId,  `❌ لم أتمكن من تحديث الرصيد: ${msg.error.message} `);
                } else {
                    const currentBalance = parseFloat(msg.balance.balance);
                    const currency = msg.balance.currency;
                    config.balance = currentBalance;
                    saveUserStates();
                    bot.sendMessage(chatId,  `✅ تم تحديث الرصيد بنجاح! الرصيد الحالي: ${currentBalance.toFixed(2)} ${currency} `);
                    console.log( `[Chat ID: ${chatId}] الرصيد بعد الصفقة: ${currentBalance.toFixed(2)} ${currency} `);
                    if (config.tpEnabled && config.initialBalanceForTP > 0) {
                        const profitAchieved = config.balance - config.initialBalanceForTP;
                        if (profitAchieved >= config.takeProfitAmount) {
                            bot.sendMessage(chatId, `🎉 **تهانينا! تم الوصول إلى Take Profit!**`);
                            bot.sendMessage(chatId, `الربح المحقق: ${profitAchieved.toFixed(2)}$`);
                            bot.sendMessage(chatId, `الرصيد الحالي: ${config.balance.toFixed(2)}$`);
                            bot.sendMessage(chatId, `🛑 جاري إيقاف البوت. أرسل /run لإعادة التشغيل.`);

                            config.running = false;
                            config.tpEnabled = false; // تعطيل TP لمنع إعادة التشغيل الفوري بنفس الهدف

                            saveUserStates();
                            // إغلاق اتصال Deriv بشكل نظيف
                            if (userDerivConnections[chatId] && userDerivConnections[chatId].readyState === WebSocket.OPEN) {
                                userDerivConnections[chatId].close();
                                delete userDerivConnections[chatId];
                            }
                            return; // إيقاف المزيد من المعالجة
                        }
                    }
                }
            }
        // ***********************************************************************************
        // نهاية التعديلات لمنطق التقييم عند الثانية 58
        // ***********************************************************************************
        else if (msg.msg_type === 'error') {
            bot.sendMessage(chatId,  `⚠ خطأ من Deriv API: ${msg.error.message} `);
            // في حالة وجود خطأ عام من Deriv، قد نحتاج لإعادة ضبط الدورة
            config.tradingCycleActive = false;
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            config.initialTradeDirectionForCycle = 'none';
            config.currentContractId = null;
            config.outcomeDetermined = false; // إعادة تعيين حالة التقييم
            config.checkTimeForOutcome = null; // إعادة تعيين وقت التحقق
            config.currentContractEntrySpot = null; // إعادة تعيين سعر الدخول
            saveUserStates();
        }
    });

    ws.on('close', () => {
        console.log( `[Chat ID: ${chatId}] Deriv WebSocket connection closed. `);
        if (config.running) {
            bot.sendMessage(chatId, '⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...');
            reconnectDeriv(chatId, config);
        } else {
            delete userDerivConnections[chatId];
            saveUserStates();
        }
    });

    ws.on('error', (error) => {
        console.error( `[Chat ID: ${chatId}] Deriv WebSocket error: ${error.message} `);
        bot.sendMessage(chatId,  `❌ خطأ في اتصال Deriv: ${error.message}. `);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });
} // نهاية دالة startBotForUser


// -------------------------------------------------------------------------
// أوامر تيليجرام
// -------------------------------------------------------------------------

const bot = new TelegramBot('7944266089:AAGhe5nRuZ1c8jKPK-lDn4-6O6jikKH56PQ', { polling: true }); // <--- تأكد من توكن التليجرام الخاص بك

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
        candle10MinOpenPrice: null,
        lastProcessed10MinIntervalStart: -1,

        martingaleFactor: 2.2,
        maxMartingaleTrades: 4,
        initialTradeDirectionForCycle: 'none',

        tradingCycleActive: false,
        currentTradeCountInCycle: 0,
        currentContractId: null,

        profit: 0,
        win: 0,
        loss: 0,
        currentStake: 0,
        stake: 0,
        token: '',
        balance: 0,

        // ***** متغيرات جديدة للتقييم عند الثانية 58 *****
        currentContractEntrySpot: null,
        currentContractEntryTime: null,
        checkTimeForOutcome: null,
        outcomeDetermined: false,

        takeProfitAmount: 0,
            initialBalanceForTP: 0,
            tpEnabled: false,
        
    };
    saveUserStates();

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
        saveUserStates();
        bot.sendMessage(id, '💵 أرسل مبلغ الصفقة:');
    }
    // *******************************************************************
    // تعديل: إلغاء خطوات TP/SL من الإعداد
    // *******************************************************************
    else if (state.step === 'stake') {
        state.stake = parseFloat(text);
        if (isNaN(state.stake) || state.stake <= 0) { // التحقق من صلاحية المبلغ
            bot.sendMessage(id, '❌ مبلغ الرهان غير صالح. يرجى إدخال رقم موجب.');
            return;
        }
        state.currentStake = state.stake;

        // ***** التعديل هنا: الانتقال إلى خطوة "take_profit" بدلاً من "done_setup" *****
        state.step = 'take_profit'; // الخطوة الجديدة لطلب مبلغ Take Profit
        saveUserStates();
        bot.sendMessage(id, '🎯 أرسل مبلغ Take Profit (مثلاً 15 لـ 15$ ربح)، أو 0 لتعطيل الـ TP:');
        // ***********************************************************************************
        // تم حذف الكود القديم هنا الذي كان ينتقل مباشرة إلى 'done_setup'
        // هذه المتغيرات سيتم ضبطها في خطوة 'take_profit' الجديدة أو عند تشغيل البوت
        state.running = false;
        state.tradingCycleActive = false;
        state.currentTradeCountInCycle = 0;
        state.initialTradeDirectionForCycle = 'none';
        state.currentContractId = null;
        state.outcomeDetermined = false;
        state.checkTimeForOutcome = null;
        state.currentContractEntrySpot = null;
        saveUserStates();
        state.step = 'done_setup'; // خطوة جديدة تدل على انتهاء الإعداد
        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
    }
    // تم حذف كتل else if (state.step === 'tp') و else if (state.step === 'sl') بالكامل
    // *******************************************************************
});


bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];

    if (!user) {
        bot.sendMessage(id, '⚠ الرجاء إعداد البوت أولاً باستخدام /start.');
        return;
    }

    // التأكد من أن المستخدم قد أكمل الإعدادات الأساسية (مثلاً خطوة 'done_setup')
    if (user.step !== 'done_setup' && user.step !== 'api') { // يمكن أن يكون 'api' إذا لم يكمل الإعداد بعد
        bot.sendMessage(id, '⚠ يرجى إكمال إعدادات البوت أولاً باستخدام /start.');
        return;
    }

    if (user.running) {
        bot.sendMessage(id, '🔄 البوت قيد التشغيل بالفعل.');
        return;
    }

    user.running = true;
    saveUserStates();
    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user);
});

bot.onText(/\/stop/, (msg) => {
    const id = msg.chat.id;
    if (userStates[id]) {
        userStates[id].running = false;
        saveUserStates();

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
console.log('Bot started and waiting for commands...');
loadUserStates(); // تحميل البيانات
