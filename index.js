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
        bot.sendMessage(chatId, `⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ...`);

        // حفظ اتجاه الصفقة الذي تم اختياره لهذه الدورة
        // هذا مهم لكي نعرف اتجاه الصفقة عند تحديد النتيجة لاحقاً
        config.initialTradeDirectionForCycle = direction;
        saveUserStates(); // حفظ الحالة بعد تحديث الاتجاه

        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake,
            "basis": "stake",
            "contract_type": direction, // 'CALL' (صعود) أو 'PUT' (هبوط)
            "currency": "USD",
            "duration": 60,
            "duration_unit": "s",
            "symbol": "R_100", // الرمز الذي تتداول عليه
        }));
    } else {
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
        console.error(`[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط.`);
        // إعادة ضبط الدورة إذا لم يتمكن من الدخول بسبب الاتصال
        config.tradingCycleActive = false;
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.initialTradeDirectionForCycle = 'none';
        config.currentContractId = null;
        config.outcomeDetermined = false;
        saveUserStates();
    }
}

// دالة لمعالجة نتائج الصفقة (الربح والخسارة) - تم تعديلها لدعم التقييم المخصص
async function handleTradeResult(chatId, config, msg, ws, customOutcome = null, customProfitLoss = null) {
    const contract = msg.proposal_open_contract;
    let profitLoss = customProfitLoss !== null ? customProfitLoss : parseFloat(contract.profit);
    let tradeOutcome = customOutcome !== null ? customOutcome : (profitLoss > 0 ? 'win' : 'lose');

    console.log(`[DEBUG] handleTradeResult for contract ${contract.contract_id}. Final Outcome: ${tradeOutcome}, P/L: ${profitLoss.toFixed(2)}`);

    // تأكد من تحديث الرصيد بغض النظر عن طريقة تحديد النتيجة
    if (typeof contract.balance_after_sell === 'number' || (typeof contract.balance_after_sell === 'string' && !isNaN(parseFloat(contract.balance_after_sell)))) {
        config.balance = parseFloat(contract.balance_after_sell); // تحديث الرصيد بعد البيع
    } else {
        console.error(`[Chat ID: ${chatId}] قيمة balance_after_sell غير صالحة: ${contract.balance_after_sell}`);
    }

    if (tradeOutcome === 'win') {
        config.profit += profitLoss;
        config.win++;
        bot.sendMessage(chatId, `✅ ربح! مبلغ الربح: ${profitLoss.toFixed(2)}$. الرصيد الحالي: ${config.balance.toFixed(2)}$`);
        console.log(`[Chat ID: ${chatId}] Trade result: WIN. Profit: ${profitLoss.toFixed(2)}$`);

        // إعادة تعيين الستيك وعداد المارتينجال وإيقاف الدورة لبدء دورة جديدة عند شمعة 10 دقائق جديدة
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
        config.tradingCycleActive = false; // هذا سيجعل البوت ينتظر الشمعة الجديدة لبدء دورة جديدة
        config.initialTradeDirectionForCycle = 'none';
        config.currentContractId = null;
        bot.sendMessage(chatId, `💰 تم تحقيق ربح. البوت في وضع الانتظار لشمعة 10 دقائق جديدة.`);
        console.log(`[${chatId}] ربح في الصفقة. الرصيد: ${config.balance.toFixed(2)}. انتظار شمعة 10 دقائق جديدة.`);

    } else { // 'lose'
        config.profit += profitLoss; // الربح سيكون سالباً هنا
        config.loss++;
        config.currentTradeCountInCycle++;

        bot.sendMessage(chatId, `❌ خسارة! مبلغ الخسارة: ${Math.abs(profitLoss).toFixed(2)}$. الرصيد الحالي: ${config.balance.toFixed(2)}$`);
        console.log(`[${chatId}] خسارة في الصفقة. الرصيد: ${config.balance.toFixed(2)}.`);

        // التحقق من تجاوز أقصى عدد للمضاعفات
        if (config.currentTradeCountInCycle >= config.maxMartingaleTrades) {
            bot.sendMessage(chatId, `🛑 تم الوصول للحد الأقصى من المضاعفات (${config.maxMartingaleTrades} خسائر متتالية). إيقاف الدورة.`);
            console.log(`[${chatId}] Max Martingale trades reached. Stopping cycle.`);

            // إعادة ضبط الستيك وعداد المارتينجال وإيقاف الدورة
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            config.tradingCycleActive = false;
            config.initialTradeDirectionForCycle = 'none';
            config.currentContractId = null;
            config.running = false; // هذا السطر يوقف البوت تماماً
            bot.sendMessage(chatId, `⚠ البوت متوقف الآن. أرسل /run لإعادة التشغيل.`); // رسالة أوضح
            console.log(`[${chatId}] البوت توقف بسبب الوصول للحد الأقصى للمضاعفات.`);

        } else {
            // الاستمرار في المضاعفة: زيادة الستيك والدخول في صفقة فوراً بنفس الاتجاه
            config.currentStake = parseFloat((config.currentStake * config.martingaleFactor).toFixed(2)); // تطبيق المارتينجال وتقريب المبلغ
            const reverseDirection = config.initialTradeDirectionForCycle === 'CALL' ? 'PUT' : 'CALL';
            bot.sendMessage(chatId, `🔄 جاري الدخول في صفقة مضاعفة رقم ${config.currentTradeCountInCycle} بمبلغ ${config.currentStake.toFixed(2)}$.`);
            console.log(`[${chatId}] جاري الدخول في مضاعفة رقم ${config.currentTradeCountInCycle} باتجاه ${reverseDirection} بمبلغ ${config.currentStake.toFixed(2)}.`);

            // الدخول الفوري في صفقة مضاعفة بنفس اتجاه الصفقة الأساسية للدورة
            await enterTrade(config, reverseDirection, chatId, ws);
        }
    }

    // ***** الأسطر المصححة هنا *****
    config.outcomeDetermined = false;
    saveUserStates(); // حفظ الحالة بعد معالجة النتيجة

    // طلب تحديث الرصيد بعد 5 ثوانٍ
    setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) { // تأكد أن ws موجود والاتصال مفتوح
            ws.send(JSON.stringify({ "balance": 1 })); // --> تم تصحيح JSON_stringify إلى JSON.stringify <--
        } else {
            console.error(`[Chat ID: ${chatId}] لا يمكن طلب الرصيد: اتصال WebSocket غير متاح أو مغلق.`);
        }
    }, 5000); // 5 ثوانٍ تأخير
    // *****************************
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

            // هذا هو الجزء الأهم في التواصل مع Deriv API
            ws.on('message', async (data) => {
                const msg = JSON.parse(data);
                const chatId = msg.req_id ? msg.req_id : Object.keys(userStates).find(id => userStates[id].ws === ws); // تحديد chatId بناءً على req_id أو العثور على المستخدم
                if (!chatId || !userStates[chatId]) {
                    console.error('لم يتم العثور على حالة المستخدم لـ chat ID أو req_id غير موجود.', msg);
                    return;
                }
                const config = userStates[chatId]; // تحديد config للمستخدم الحالي

                if (msg.msg_type === 'authorize') {
                    if (msg.error) {
                        console.error(`[Chat ID: ${chatId}] خطأ في المصادقة: ${msg.error.message}`);
                        bot.sendMessage(chatId, `❌ خطأ في المصادقة: ${msg.error.message}. يرجى التحقق من API Token.`);
                        config.running = false;
                        saveUserStates();
                        return;
                    }
                    config.isAuthorized = true;
                    config.balance = msg.authorize.balance; // تحديث الرصيد عند المصادقة
                    console.log(`[Chat ID: ${chatId}] تم المصادقة بنجاح. الرصيد: ${config.balance}`);
                    bot.sendMessage(chatId, `✅ تم المصادقة بنجاح! رصيدك الحالي: ${config.balance.toFixed(2)}$`);
                    // بعد المصادقة، إذا كان البوت في وضع التشغيل، يمكن أن تبدأ دورة التداول
                    if (config.running) {
                         console.log(`[Chat ID: ${chatId}] البوت في وضع التشغيل، جاري بدء دورة التداول.`);
                         startTradingCycle(chatId, config, ws); // استدعاء لبدء دورة التداول
                    }
                }
                else if (msg.msg_type === 'balance') {
                    if (msg.error) {
                        console.error(`[Chat ID: ${chatId}] خطأ في الحصول على الرصيد: ${msg.error.message}`);
                        return;
                    }
                    config.balance = msg.balance.balance;
                    bot.sendMessage(chatId, `✅ تم تحديث الرصيد بنجاح! الرصيد الحالي: ${config.balance.toFixed(2)}$`);
                    console.log(`[Chat ID: ${chatId}] تم تحديث الرصيد. الرصيد الحالي: ${config.balance.toFixed(2)}`);

                    // تحقق من Take Profit بعد كل تحديث للرصيد
                    if (config.running && config.tpEnabled && config.initialBalanceForTP !== null) {
                        const currentProfit = config.balance - config.initialBalanceForTP;
                        if (currentProfit >= config.takeProfitAmount) {
                            config.running = false; // إيقاف البوت
                            config.tradingCycleActive = false; // إيقاف الدورة
                            config.currentStake = config.stake; // إعادة تعيين الستيك
                            config.currentTradeCountInCycle = 0; // إعادة تعيين العداد
                            config.initialTradeDirectionForCycle = 'none';
                            config.currentContractId = null;
                            config.outcomeDetermined = false;
                            config.checkTimeForOutcome = null; // إعادة تعيين
                            config.initialBalanceForTP = null; // إعادة تعيين
                            saveUserStates();
                            bot.sendMessage(chatId, `🎉 تهانينا! تم الوصول إلى Take Profit (${config.takeProfitAmount.toFixed(2)}$). البوت متوقف الآن. أرسل /run لإعادة التشغيل.`);
                            console.log(`[Chat ID: ${chatId}] تم الوصول إلى Take Profit. البوت متوقف.`);
                             userDerivConnections[chatId].close();
                             delete userDerivConnections[chatId];
                            return; // مهم للخروج بعد إيقاف البوت
                        }
                    }

                    // إذا كان البوت لا يزال يعمل ولم يتم إيقافه بالـ TP، جاري بدء دورة جديدة
                    if (config.running && !config.tradingCycleActive) {
                        console.log(`[Chat ID: ${chatId}] البوت في وضع التشغيل، جاري بدء دورة تداول جديدة.`);
                        startTradingCycle(chatId, config, ws);
                    }
                }
                // ***** معالج الـ "proposal" (لشراء العقد بعد استلام العرض) *****
                else if (msg.msg_type === 'proposal' && msg.proposal) {
                    if (msg.error) {
                        console.error(`[Chat ID: ${chatId}] خطأ في عرض السعر (proposal): ${msg.error.message}`);
                        bot.sendMessage(chatId, `❌ خطأ في عرض سعر الصفقة: ${msg.error.message}. جاري إعادة ضبط الدورة.`);
                        config.tradingCycleActive = false;
                        config.currentStake = config.stake;
                        config.currentTradeCountInCycle = 0;
                        config.initialTradeDirectionForCycle = 'none';
                        config.currentContractId = null;
                        config.outcomeDetermined = false;
                        saveUserStates();
                        return;
                    }
                    const proposalId = msg.proposal.id;
                    const spotPrice = msg.proposal.spot; // سعر الدخول المقترح

                    // إرسال طلب الشراء بعد الحصول على عرض السعر
                    if (config.running) {
                        bot.sendMessage(chatId, `✅ تم استلام عرض سعر. جاري شراء الصفقة...`);
                        ws.send(JSON.stringify({
                            "buy": proposalId,
                            "price": msg.proposal.ask_price, // السعر المعروض للشراء
                        }));
                        console.log(`[Chat ID: ${chatId}] جاري شراء العقد بـ ID: ${proposalId}, بسعر: ${msg.proposal.ask_price}`);
                    } else {
                        console.log(`[Chat ID: ${chatId}] البوت ليس في وضع التشغيل، لن يتم شراء العقد.`);
                        bot.sendMessage(chatId, `البوت ليس في وضع التشغيل، لم يتم شراء العقد.`);
                    }
                }
                // ***** معالج الـ "buy" (هنا نحصل على تفاصيل العقد وحساب وقت التخمين) *****
                else if (msg.msg_type === 'buy' && msg.buy) {
                    if (msg.error) {
                        console.error(`[Chat ID: ${chatId}] خطأ في شراء العقد: ${msg.error.message}`);
                        bot.sendMessage(chatId, `❌ خطأ في شراء العقد: ${msg.error.message}. جاري إعادة ضبط الدورة.`);
                        config.tradingCycleActive = false;
                        config.currentStake = config.stake;
                        config.currentTradeCountInCycle = 0;
                        config.initialTradeDirectionForCycle = 'none';
                        config.currentContractId = null;
                        config.outcomeDetermined = false;
                        saveUserStates();
                        return;
                    }
                    const contractId = msg.buy.contract_id;
                    const entrySpot = msg.buy.bid_price; // سعر الدخول الفعلي
                    const entryTickTime = msg.buy.start_time * 1000; // وقت بدء العقد بالمللي ثانية

                    config.currentContractId = contractId;
                    config.currentContractEntrySpot = entrySpot; // حفظ سعر الدخول الفعلي
                    // اتجاه الصفقة تم حفظه بالفعل في enterTrade
                    config.tradingCycleActive = true; // تأكيد أن الدورة نشطة الآن
                    config.outcomeDetermined = false; // إعادة تعيين لصفقة جديدة

                    // حساب وقت التخمين المستهدف (الثانية 58 من الدقيقة التي بدأ فيها العقد)
                    const currentMinuteStartMs = Math.floor(entryTickTime / (60 * 1000)) * (60 * 1000); // بداية الدقيقة التي بدأ فيها العقد
                    const targetPredictionTime = currentMinuteStartMs + 58 * 1000; // الثانية 58 من تلك الدقيقة

                    // إذا كان وقت التخمين المستهدف قبل وقت الدخول الفعلي (مثلاً لو دخلت في 59 ثانية من الدقيقة)
                    // في هذه الحالة، يجب أن يتم التخمين في الثانية 58 من الدقيقة التالية
                    if (targetPredictionTime < entryTickTime) {
                        config.checkTimeForOutcome = targetPredictionTime + (60 * 1000); // اذهب للثانية 58 من الدقيقة التالية
                    } else {
                        config.checkTimeForOutcome = targetPredictionTime;
                    }

                    saveUserStates();
                    bot.sendMessage(chatId, `✅ تم شراء العقد بنجاح! ID: ${contractId}. سعر الدخول: ${entrySpot}. وقت التخمين المستهدف (الثانية 58): ${new Date(config.checkTimeForOutcome).toLocaleTimeString()}.`);
                    console.log(`[Chat ID: ${chatId}] تم شراء العقد. ID: ${contractId}, وقت الدخول: ${new Date(entryTickTime).toLocaleTimeString()}, وقت التخمين المستهدف: ${new Date(config.checkTimeForOutcome).toLocaleTimeString()}`);
                }
                // ***** معالج الـ "proposal_open_contract" (لمراقبة الصفقة والتخمين في الثانية 58) *****
                else if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
                    const contract = msg.proposal_open_contract;
                    const currentTime = contract.current_spot_time * 1000; // الوقت الحالي للنقطة (بالمللي ثانية)

                    // تجاهل التحديثات للعقود التي ليست هي العقد الحالي النشط
                    if (contract.contract_id !== config.currentContractId) {
                        return;
                    }

                    // فقط قم بتحديث سعر الدخول إذا لم يتم تعيينه بعد (قد يكون مفيداً إذا لم يتم تعيينه بدقة في 'buy')
                    if (!config.currentContractEntrySpot) {
                        config.currentContractEntrySpot = contract.entry_spot;
                        saveUserStates();
                    }

                    // ***** منطق التخمين في الثانية 58 *****
                    // نتحقق إذا كان وقت التخمين قد حان، ولم نكن قد خمنا النتيجة بعد، والبوت لا يزال يعمل
                    if (config.running && config.checkTimeForOutcome && currentTime >= config.checkTimeForOutcome && !config.outcomeDetermined) {
                        console.log(`[Chat ID: ${chatId}] وصول لزمن التخمين: ${new Date(currentTime).toLocaleTimeString()}. سعر الدخول: ${config.currentContractEntrySpot}, سعر الإغلاق الحالي: ${contract.current_spot}`);

                        let predictedOutcome;
                        let predictedProfitLoss;

                        // تحديد النتيجة بناءً على سعر الدخول (currentContractEntrySpot) والسعر الحالي (current_spot) واتجاه الصفقة
                        if (config.initialTradeDirectionForCycle === 'CALL') {
                            if (contract.current_spot > config.currentContractEntrySpot) {
                                predictedOutcome = 'win';
                                predictedProfitLoss = config.currentStake * 0.9; // مثال: 90% ربح
                            } else {
                                predictedOutcome = 'lose';
                                predictedProfitLoss = -config.currentStake;
                            }
                        } else if (config.initialTradeDirectionForCycle === 'PUT') {
                            if (contract.current_spot < config.currentContractEntrySpot) {
                                predictedOutcome = 'win';
                                predictedProfitLoss = config.currentStake * 0.9; // مثال: 90% ربح
                            } else {
                                predictedOutcome = 'lose';
                                predictedProfitLoss = -config.currentStake;
                            }
                        }

                        // تعيين outcomeDetermined لضمان عدم معالجة الصفقة مرة أخرى
                        config.outcomeDetermined = true;
                        config.currentContractId = null; // نلغي ID العقد الحالي لأننا خمنا نتيجته
                        config.checkTimeForOutcome = null; // نلغي وقت التخمين
                        saveUserStates(); // حفظ الحالة

                        bot.sendMessage(chatId, `🧠 البوت يتوقع نتيجة الصفقة: **${predictedOutcome.toUpperCase()}**.`);

                        // استدعاء handleTradeResult بالنتائج المخمنة يدوياً
                        // نمرر الـ msg (الذي يحتوي على proposal_open_contract) ووسيطي التخمين
                        handleTradeResult(chatId, config, msg, ws, predictedOutcome, predictedProfitLoss);

                        return; // توقف عن معالجة المزيد من تحديثات هذا العقد بعد التخمين
                    }

                    // إذا كانت الصفقة قد انتهت رسمياً من Deriv ولم نكن قد خمنا نتيجتها بعد،
                    // يمكننا معالجتها هنا كاحتياطي، ولكن يجب ألا نصل إلى هنا إذا كان التخمين يعمل.
                    if (contract.is_sold === 1 && !config.outcomeDetermined) {
                        console.log(`[Chat ID: ${chatId}] الصفقة بيعت رسمياً من Deriv (احتياطي).`);
                        config.outcomeDetermined = true;
                        config.currentContractId = null;
                        config.checkTimeForOutcome = null;
                        saveUserStates();
                        handleTradeResult(chatId, config, msg, ws);
                        return;
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

bot.on('message', async (msg) => {
    const id = msg.chat.id;
    const text = msg.text;
    const state = userStates[id];

    // هذا السطر يضمن أننا لا نعالج الأوامر (/start, /run, /stop)
    // إذا كان البوت لا يزال في وضع الإعداد، أو إذا لم يكن هناك حالة للمستخدم.
    if (!state || !state.step || text.startsWith('/')) {
        // إذا كان أمر /start ولم يكن هناك حالة، نعالجها في /start handler
        if (text === '/start' && !state) {
            // هذا سيعالج بواسطة bot.onText('/start')
        }
        return; // توقف عن معالجة الرسائل النصية هنا إذا كانت أمراً أو لا يوجد حالة
    }

    if (state.step === 'api') {
        state.token = text;
        state.step = 'stake';
        saveUserStates();
        bot.sendMessage(id, '💵 أرسل مبلغ الصفقة:');
    }
    // *******************************************************************
    // بداية كتلة Stake المعدلة (التي كانت سبب المشكلة)
    // *******************************************************************
    else if (state.step === 'stake') {
        state.stake = parseFloat(text);
        if (isNaN(state.stake) || state.stake <= 0) { // التحقق من صلاحية المبلغ
            bot.sendMessage(id, '❌ مبلغ الرهان غير صالح. يرجى إدخال رقم موجب.');
            return;
        }
        state.currentStake = state.stake;

        // ***** التعديل الصحيح: الانتقال إلى خطوة "take_profit" *****
        state.step = 'take_profit'; // الخطوة الجديدة لطلب مبلغ Take Profit
        saveUserStates();
        bot.sendMessage(id, '🎯 أرسل مبلغ Take Profit (مثلاً 15 لـ 15$ ربح)، أو 0 لتعطيل الـ TP:');
        // ***************************************************************
        // تم حذف جميع الأسطر الزائدة التي كانت تسبب القفز لـ 'done_setup' هنا.
    }
    // *******************************************************************
    // نهاية كتلة Stake المعدلة
    // *******************************************************************

    // *******************************************************************
    // بداية كتلة Take Profit الجديدة
    // *******************************************************************
    else if (state.step === 'take_profit') {
        const tpInput = parseFloat(text);
        if (isNaN(tpInput) || tpInput < 0) {
            bot.sendMessage(id, '❌ مبلغ Take Profit غير صالح. يرجى إدخال رقم موجب أو 0 لتعطيله.');
            return;
        }
        state.takeProfitAmount = tpInput;
        state.tpEnabled = (tpInput > 0); // تفعيل الـ TP إذا كان المبلغ أكبر من 0

        // إعادة ضبط هذه المتغيرات عند انتهاء الإعداد الجديد
        state.running = false;
        state.tradingCycleActive = false;
        state.currentTradeCountInCycle = 0;
        state.initialTradeDirectionForCycle = 'none';
        state.currentContractId = null;
        state.outcomeDetermined = false;
        state.checkTimeForOutcome = null;
        state.currentContractEntrySpot = null;

        saveUserStates();
        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
        state.step = 'done_setup'; // خطوة جديدة تدل على انتهاء الإعداد
    }

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
