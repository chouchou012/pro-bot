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
        console.log(`[Chat ID: ${chatId}] البوت متوقف، لن تتم محاولة إعادة الاتصال.`);
        return;
    }

    console.log(`[Chat ID: ${chatId}] جاري محاولة إعادة الاتصال بـ Deriv في 5 ثوانٍ...`);
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
            "duration": 57,
            "duration_unit": "s", // 1 دقيقة
            "symbol": "R_100", // الرمز الذي تتداول عليه
            // لا نرسل TP/SL هنا، بل نعتمد على متابعتها في البوت
            // "take_profit": config.tp > 0 ? config.tp : undefined, 
            // "stop_loss": config.sl > 0 ? config.sl : undefined 
        }));
    } else {
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
        console.error(`[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط.`);
        // إعادة ضبط الدورة إذا لم يتمكن من الدخول بسبب الاتصال
        config.tradingCycleActive = false;
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.initialTradeDirectionForCycle = 'none';
        saveUserStates();
    }
}

// دالة لمعالجة نتائج الصفقة (الربح والخسارة)
async function handleTradeResult(chatId, config, msg, ws) {
    const contract = msg.proposal_open_contract;

    // ************* تصحيح مشكلة NaN في الرصيد *************
    // أضفنا هذه السطور لمساعدتك في Debugging، يمكنك إزالتها بعد التأكد من أن المشكلة حلت
    console.log('Received contract message:', JSON.stringify(msg, null, 2));
    console.log('balance_after_sell raw value:', contract.balance_after_sell);
    // *****************************************************

    if (contract.is_sold === 1) { // الصفقة تم إغلاقها
        const profit_loss = parseFloat(contract.profit);

        // تأكد من أن contract.balance_after_sell هو قيمة صالحة قبل تحويله
        if (typeof contract.balance_after_sell === 'number' || (typeof contract.balance_after_sell === 'string' && !isNaN(parseFloat(contract.balance_after_sell)))) {
            config.balance = parseFloat(contract.balance_after_sell); // تحديث الرصيد بعد البيع
        } else {
            console.error(`[Chat ID: ${chatId}] قيمة balance_after_sell غير صالحة: ${contract.balance_after_sell}`);
            // يمكن هنا إضافة منطق للتعامل مع هذا الخطأ، مثلاً جلب الرصيد مرة أخرى
            // أو استخدام الرصيد السابق إذا كان متاحاً. حالياً، سنتجنب تعيين NaN.
        }

        if (profit_loss > 0) { // إذا كانت الصفقة رابحة
            config.profit += profit_loss;
            config.win++;
            bot.sendMessage(chatId, `✅ ربح! مبلغ الربح: ${profit_loss.toFixed(2)}$. الرصيد الحالي: ${config.profit.toFixed(2)}$`);

            // إعادة تعيين الستيك وعداد المارتينجال ووقف الدورة لبدء دورة جديدة عند شمعة 10 دقائق جديدة
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            config.tradingCycleActive = false; // مهم جداً: إيقاف الدورة الحالية
            config.initialTradeDirectionForCycle = 'none'; // إعادة تعيين اتجاه الصفقة الأساسية للدورة
            config.currentContractId = null; // إعادة تعيين ID العقد الحالي بعد انتهائه
            saveUserStates(); // حفظ حالة المستخدم بعد التغييرات
            bot.sendMessage(chatId, `💰 تم تحقيق ربح. البوت في وضع الانتظار لشمعة 10 دقائق جديدة.`);
            console.log(`[${chatId}] ربح في الصفقة. الرصيد: ${config.balance.toFixed(2)}. انتظار شمعة 10 دقائق جديدة.`);

        } else { // إذا كانت الصفقة خاسرة (profit_loss <= 0)
            config.profit += profit_loss; // الربح سيكون سالباً هنا
            config.loss++;
            config.currentTradeCountInCycle++; // زيادة عداد صفقات المارتينجال

            bot.sendMessage(chatId, `❌ خسارة! مبلغ الخسارة: ${Math.abs(profit_loss).toFixed(2)}$. الرصيد الحالي: ${config.profit.toFixed(2)}$`);
            console.log(`[${chatId}] خسارة في الصفقة. الرصيد: ${config.profit.toFixed(2)}.`);

            // التحقق من تجاوز حد الخسارة (SL) أو أقصى عدد للمضاعفات
            // تأكد أن config.sl و config.maxMartingaleTrades معرفين ولديهما قيم صحيحة
            if (config.profit <= -Math.abs(config.sl) || config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
                bot.sendMessage(chatId, '⛔ تم الوصول إلى حد الخسارة (SL) أو أقصى عدد للمضاعفات. جاري إعادة ضبط الدورة.');
                console.log(`[${chatId}] تم الوصول إلى SL أو أقصى عدد للمضاعفات. إعادة ضبط الدورة.`);

                // إعادة ضبط الستيك وعداد المارتينجال وإيقاف الدورة
                config.currentStake = config.stake;
                config.currentTradeCountInCycle = 0;
                config.tradingCycleActive = false; // إيقاف الدورة الحالية
                config.initialTradeDirectionForCycle = 'none'; // إعادة تعيين اتجاه الصفقة الأساسية
                config.currentContractId = null; // إعادة تعيين ID العقد الحالي بعد انتهائه
                config.running = false; // إيقاف البوت تلقائياً عند الوصول للحد الأقصى
                saveUserStates();
                bot.sendMessage(chatId, `💰 البوت في وضع الانتظار لشمعة 10 دقائق جديدة.`);

            } else {
                // الاستمرار في المضاعفة: زيادة الستيك والدخول في صفقة فوراً بنفس الاتجاه
                config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2)); // تطبيق المارتينجال وتقريب المبلغ

                bot.sendMessage(chatId, `🔄 جاري الدخول في صفقة مضاعفة رقم ${config.currentTradeCountInCycle} بمبلغ ${config.currentStake.toFixed(2)}$.`);
                console.log(`[${chatId}] جاري الدخول في مضاعفة رقم ${config.currentTradeCountInCycle} باتجاه ${config.initialTradeDirectionForCycle} بمبلغ ${config.currentStake.toFixed(2)}.`);

                // الدخول الفوري في صفقة مضاعفة بنفس اتجاه الصفقة الأساسية للدورة
                // تأكد أن initialTradeDirectionForCycle تم تعيينه بشكل صحيح عند بدء الدورة
                await enterTrade(config, config.initialTradeDirectionForCycle, chatId, ws);
                // tradingCycleActive يبقى true لأننا ما زلنا في نفس الدورة
                saveUserStates(); // حفظ حالة المستخدم بعد التغييرات (الستيك والعداد)
            }
        }
        // إلغاء الاشتراك من العقد المفتوح بعد إغلاقه
        ws.send(JSON.stringify({ "forget": contract.contract_id }));
    }
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

    // ************ هذا هو التغيير الرئيسي ************
    // هذه المتغيرات يتم إعادة ضبطها فقط إذا لم تكن عملية إعادة اتصال
    if (!isReconnect) {
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.tradingCycleActive = false; // تأكيد عدم وجود دورة تداول نشطة عند البدء
        config.initialTradeDirectionForCycle = 'none'; // إعادة تعيين الاتجاه الأساسي للدورة
        config.currentContractId = null; // إعادة تعيين ID العقد الحالي

        // إعادة تعيين الأرباح والخسائر والعدادات عند بدء تشغيل جديد فقط (وليس عند إعادة الاتصال)
        config.profit = 0;
        config.win = 0;
        config.loss = 0;

        // إعادة تهيئة متغيرات شمعة الـ 10 دقائق والدورة لضمان بداية نظيفة
        config.candle10MinOpenPrice = null;
        config.lastProcessed10MinIntervalStart = -1;
    }
    // *************************************************

    // إضافة إعدادات المضاعفة الافتراضية إذا لم تكن موجودة
    config.martingaleFactor = config.martingaleFactor || 2.2;
    config.maxMartingaleTrades = config.maxMartingaleTrades || 4; // الحد الأقصى للمضاعفات

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
                bot.sendMessage(chatId, `❌ فشلت المصادقة: ${msg.error.message}. يرجى التحقق من API Token.`);
                config.running = false;
                ws.close();
                saveUserStates();
            } else {
                config.balance = parseFloat(msg.authorize.balance); // تحديث الرصيد عند المصادقة
                bot.sendMessage(chatId, `✅ تم تسجيل الدخول بنجاح! الرصيد: ${config.balance.toFixed(2)} ${msg.authorize.currency}`);
                ws.send(JSON.stringify({
                    "ticks": "R_100",
                    "subscribe": 1
                }));

                // **** إضافة جديدة هنا: إعادة الاشتراك في العقد المفتوح عند إعادة الاتصال ****
                if (config.running && config.tradingCycleActive && config.currentContractId) {
                    bot.sendMessage(chatId, `🔄 تم إعادة الاتصال. جاري متابعة العقد القديم: ${config.currentContractId}`);
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
                            bot.sendMessage(chatId, `📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                        } else if (previousCandleClose > previousCandleOpen) {
                            tradeDirection = 'PUT'; // شمعة صاعدة، ندخل PUT
                            bot.sendMessage(chatId, `📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                        } else {
                            bot.sendMessage(chatId, `↔ الشمعة السابقة (10 دقائق) بدون تغيير. لا يوجد اتجاه واضح.`);
                        }
                    } else {
                        bot.sendMessage(chatId, `⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه.`);
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

                        bot.sendMessage(chatId, `✅ جاري الدخول في صفقة أساسية بمبلغ ${config.currentStake.toFixed(2)}$ بناءً على شمعة الـ 10 دقائق (${tradeDirection}).`);
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
                bot.sendMessage(chatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                // في حالة فشل الاقتراح، نعتبرها خسارة ونطبق المضاعفة الفورية
                config.profit += -config.currentStake; // اعتبار الستيك خسارة
                config.loss++;
                config.currentTradeCountInCycle++;

                // التحقق من تجاوز حد الخسارة (SL) أو أقصى عدد للمضاعفات
                if (config.profit <= -Math.abs(config.sl) || config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
                    bot.sendMessage(chatId, '⛔ تم الوصول إلى حد الخسارة (SL) أو أقصى عدد للمضاعفات. جاري إعادة ضبط الدورة.');
                    config.currentStake = config.stake;
                    config.currentTradeCountInCycle = 0;
                    config.tradingCycleActive = false;
                    config.initialTradeDirectionForCycle = 'none';
                    config.currentContractId = null; // إعادة تعيين ID العقد الحالي بعد فشل الاقتراح
                    config.running = false; // إيقاف البوت تلقائياً عند الوصول للحد الأقصى
                    saveUserStates();
                } else {
                    config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2));
                    bot.sendMessage(chatId, `❌ فشل الاقتراح. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والدخول فوراً.`);
                    // نستخدم initialTradeDirectionForCycle لأنه تم تحديده عند بدء الدورة
                    await enterTrade(config, config.initialTradeDirectionForCycle, chatId, ws);
                    saveUserStates();
                }
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
                 // في حالة فشل الشراء، نعتبرها خسارة ونطبق المضاعفة الفورية
                config.profit += -config.currentStake; // اعتبار الستيك خسارة
                config.loss++;
                config.currentTradeCountInCycle++;

                // التحقق من تجاوز حد الخسارة (SL) أو أقصى عدد للمضاعفات
                if (config.profit <= -Math.abs(config.sl) || config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
                    bot.sendMessage(chatId, '⛔ تم الوصول إلى حد الخسارة (SL) أو أقصى عدد للمضاعفات. جاري إعادة ضبط الدورة.');
                    config.currentStake = config.stake;
                    config.currentTradeCountInCycle = 0;
                    config.tradingCycleActive = false;
                    config.initialTradeDirectionForCycle = 'none';
                    config.currentContractId = null; // إعادة تعيين ID العقد الحالي بعد فشل الشراء
                    config.running = false; // إيقاف البوت تلقائياً
                    saveUserStates();
                } else {
                    config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2));
                    bot.sendMessage(chatId, `❌ فشل الشراء. جاري مضاعفة المبلغ إلى ${config.currentStake.toFixed(2)}$ والدخول فوراً.`);
                    // نستخدم initialTradeDirectionForCycle لأنه تم تحديده عند بدء الدورة
                    await enterTrade(config, config.initialTradeDirectionForCycle, chatId, ws);
                    saveUserStates();
                }
                return;
            }

            const contractId = msg.buy.contract_id;
            config.currentContractId = contractId; // حفظ Contract ID للعقد المفتوح
            saveUserStates(); // حفظ حالة المستخدم

            bot.sendMessage(chatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$. Contract ID: ${contractId}`);

            // الاشتراك في حالة العقد المفتوح
            ws.send(JSON.stringify({
                "proposal_open_contract": 1,
                "contract_id": contractId,
                "subscribe": 1
            }));
        }
        else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract && msg.proposal_open_contract.is_sold === 1) {
            // عندما يتم بيع العقد (أي انتهاء الصفقة)، نقوم بمعالجة النتيجة
            handleTradeResult(chatId, config, msg, ws);
        }
        else if (msg.msg_type === 'error') {
            bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            // في حالة وجود خطأ عام من Deriv، قد نحتاج لإعادة ضبط الدورة
            config.tradingCycleActive = false;
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            config.initialTradeDirectionForCycle = 'none';
            config.currentContractId = null; // إعادة تعيين ID العقد الحالي
            saveUserStates();
        }
    });

    ws.on('close', () => {
        console.log(`[Chat ID: ${chatId}] Deriv WebSocket connection closed.`);
        if (config.running) {
            bot.sendMessage(chatId, '⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...');
            reconnectDeriv(chatId, config);
        } else {
            delete userDerivConnections[chatId];
            saveUserStates();
        }
    });

    ws.on('error', (error) => {
        console.error(`[Chat ID: ${chatId}] Deriv WebSocket error: ${error.message}`);
        bot.sendMessage(chatId, `❌ خطأ في اتصال Deriv: ${error.message}.`);
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
        candle10MinOpenPrice: null, // سعر فتح الشمعة الـ 10 دقائق
        lastProcessed10MinIntervalStart: -1, // لتتبع آخر وقت تم فيه معالجة شمعة الـ 10 دقائق

        // متغيرات المارتينجال الجديدة
        martingaleFactor: 2.2, // عامل المضاعفة
        maxMartingaleTrades: 5, // أقصى عدد لصفقات المضاعفة في الدورة  <--- هنا القيمة الافتراضية 5
        initialTradeDirectionForCycle: 'none', // اتجاه الصفقة الأساسية للدورة

        tradingCycleActive: false, // هل دورة تداول (سلسلة مارتينجال) نشطة؟
        currentTradeCountInCycle: 0, // عدد الصفقات في دورة المارتينجال الحالية
        currentContractId: null, // لتتبع العقد النشط

        profit: 0,
        win: 0,
        loss: 0,
        currentStake: 0,
        stake: 0,
        tp: 0,
        sl: 0,
        token: '',
        balance: 0, // الرصيد الأولي، سيتم تحديثه من Deriv
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
        state.running = false; // البوت متوقف افتراضياً بعد الإعداد

        // إعادة تهيئة متغيرات شمعة الـ 10 دقائق والمارتينجال لضمان بداية نظيفة
        state.candle10MinOpenPrice = null;
        state.lastProcessed10MinIntervalStart = -1;
        state.tradingCycleActive = false;
        state.currentTradeCountInCycle = 0;
        state.initialTradeDirectionForCycle = 'none';
        state.currentContractId = null;

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

    // هنا يتم استدعاء startBotForUser بدون بارامتر isReconnect، مما يعني أنه سيتم إعادة ضبط المتغيرات (دورة جديدة)
    user.running = true;
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
