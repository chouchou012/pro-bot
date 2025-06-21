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

// تعريف الثوابت للمضاعفات
const MARTINGALE_FACTOR = 2.2;
const MAX_MARTINGALE_TRADES = 4; // الحد الأقصى لعدد صفقات المضاعفة بعد الخسارة الأساسية

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

    setTimeout(() => {
        if (config.running) {
            startBotForUser(chatId, config);
        } else {
            console.log(`[Chat ID: ${chatId}] البوت توقف أثناء فترة انتظار إعادة الاتصال.`);
        }
    }, 5000); // 5 ثوانٍ
}

async function enterTrade(config, direction, chatId, ws) {
    // التحقق مما إذا كان اتصال WebSocket نشطًا ومفتوحًا قبل إرسال الطلب
    if (ws && ws.readyState === WebSocket.OPEN) {
        const formattedStake = parseFloat(config.currentStake.toFixed(2));
        console.log(`[Chat ID: ${chatId}] ⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ...`);
        bot.sendMessage(chatId, `⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ...`);
        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake,
            "basis": "stake",
            "contract_type": direction, // 'CALL' (صعود) أو 'PUT' (هبوط)
            "currency": "USD",
            "duration": 1,
            "duration_unit": "m", // 1 دقيقة
            "symbol": "R_100" // الرمز الذي تتداول عليه
        }));
    } else {
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
        console.error(`[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط.`);
    }
}

// دالة مساعدة لقلب الاتجاه
function reverseDirection(direction) {
    return direction === 'CALL' ? 'PUT' : 'CALL';
}

// دالة رئيسية لبدء تشغيل البوت لكل مستخدم
function startBotForUser(chatId, config) {
    // إغلاق أي اتصال سابق لهذا المستخدم قبل إنشاء اتصال جديد
    if (userDerivConnections[chatId] && userDerivConnections[chatId].readyState !== WebSocket.CLOSED) {
        console.log(`[Chat ID: ${chatId}] إغلاق اتصال Deriv سابق قبل بدء اتصال جديد.`);
        userDerivConnections[chatId].close();
        delete userDerivConnections[chatId];
    }

    // *** هام جداً: هذا هو URL الخاص بالخادم التجريبي (Demo) ***
    // تأكد أن الـ API Token الذي تستخدمه هو لحساب تجريبي ليعمل بشكل مستقر
    const ws = new WebSocket('wss://green.derivws.com/websockets/v3?app_id=22168');
    userDerivConnections[chatId] = ws;

    // تهيئة متغيرات خاصة بالتنبؤ بالنتيجة
    config.currentOpenContract = null; // لتخزين تفاصيل العقد النشط
    config.predictionCheckTimer = null; // مؤقت التنبؤ
    config.processingTradeResult = false; // لمنع معالجة النتيجة مرتين

    ws.on('open', () => {
        console.log(`[Chat ID: ${chatId}] ✅ تم الاتصال بـ Deriv. جاري المصادقة...`);
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token }));
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);
        const currentChatId = chatId;

        // 🟢🟢🟢 DEBUG: سجل نوع الرسالة الواردة 🟢🟢🟢
        console.log(`[Chat ID: ${currentChatId}] RECEIVED MSG TYPE: ${msg.msg_type}`);

        // إذا توقف البوت، أغلق الاتصال وتجاهل الرسائل
        if (!config.running && ws.readyState === WebSocket.OPEN) {
            console.log(`[Chat ID: ${currentChatId}] البوت متوقف، جاري إغلاق اتصال Deriv.`);
            ws.close();
            bot.sendMessage(currentChatId, '🛑 تم إغلاق اتصال Deriv.');
            return;
        }

        if (msg.msg_type === 'authorize') {
            if (msg.error) {
                console.error(`[Chat ID: ${currentChatId}] ❌ فشلت المصادقة: ${msg.error.message}`);
                bot.sendMessage(currentChatId, `❌ فشلت المصادقة: ${msg.error.message}. يرجى التحقق من API Token.`);
                config.running = false;
                if (ws.readyState === WebSocket.OPEN) ws.close();
                saveUserStates();
            } else {
                console.log(`[Chat ID: ${currentChatId}] ✅ تم تسجيل الدخول بنجاح! الرصيد: ${msg.authorize.balance} ${msg.authorize.currency}`);
                bot.sendMessage(currentChatId, `✅ تم تسجيل الدخول بنجاح! الرصيد: ${msg.authorize.balance} ${msg.authorize.currency}`);
                // بعد المصادقة، ابدأ الاشتراك في التيكات
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

            // منطق تحديد اتجاه الصفقة الأساسية (فقط عند بداية شمعة الـ 10 دقائق)
            // 🎯 هنا نتحقق من أن البوت يعمل وأننا لسنا في دورة تداول نشطة (أي لا توجد صفقة مفتوحة أو مضاعفة جارية).
            if (config.running && !config.tradingCycleActive) {
                if (currentSecond === 0 && currentMinute === current10MinIntervalStartMinute) {
                    if (config.lastProcessed10MinIntervalStart !== current10MinIntervalStartMinute) {
                        let tradeDirection = 'none';

                        if (config.candle10MinOpenPrice !== null) {
                            const previousCandleOpen = config.candle10MinOpenPrice;
                            const previousCandleClose = currentTickPrice; // سعر الإغلاق هو سعر التيك الحالي

                            if (previousCandleClose < previousCandleOpen) {
                                tradeDirection = 'CALL'; // شمعة هابطة -> الصفقة التالية صعود
                                console.log(`[Chat ID: ${currentChatId}] 📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                                bot.sendMessage(currentChatId, `📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                            } else if (previousCandleClose > previousCandleOpen) {
                                tradeDirection = 'PUT'; // شمعة صاعدة -> الصفقة التالية هبوط
                                console.log(`[Chat ID: ${currentChatId}] 📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                                bot.sendMessage(currentChatId, `📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                            } else {
                                console.log(`[Chat ID: ${currentChatId}] ↔ الشمعة السابقة (10 دقائق) بدون تغيير.`);
                                bot.sendMessage(currentChatId, `↔ الشمعة السابقة (10 دقائق) بدون تغيير. لا يوجد اتجاه واضح.`);
                            }
                        } else {
                            console.log(`[Chat ID: ${currentChatId}] ⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق).`);
                            bot.sendMessage(currentChatId, `⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه.`);
                        }

                        // تحديث سعر الافتتاح للشمعة الحالية
                        config.candle10MinOpenPrice = currentTickPrice;
                        config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute;
                        saveUserStates();

                        if (tradeDirection !== 'none') {
                            // تعيين الاتجاه الأساسي للصفقة الأولى في هذه الدورة
                            config.baseTradeDirection = tradeDirection;
                            // الصفقة الأولى في دورة المارتينجال تكون بنفس الاتجاه المستنتج من الشمعة
                            config.nextTradeDirection = tradeDirection;

                            // 🎯🎯🎯 هذا هو التعديل الأساسي هنا 🎯🎯🎯
                            // نقوم باستدعاء enterTrade فقط هنا لبدء الصفقة الأولى للدورة.
                            await enterTrade(config, config.nextTradeDirection, currentChatId, ws);
                            config.tradingCycleActive = true; // الآن نحن في دورة تداول نشطة
                            saveUserStates();
                        } else {
                            // إذا لم يكن هناك اتجاه واضح، أعد ضبط الستيك والعداد
                            config.currentStake = config.stake;
                            config.currentTradeCountInCycle = 0;
                            saveUserStates();
                        }
                    }
                }
            }
            // ⚠ مهم جداً: لا تضع أي منطق للدخول في صفقة هنا خارج الشرط !config.tradingCycleActive
            // هذا يضمن أن الصفقات تبدأ فقط عند بداية الشمعة 10 دقائق (إذا لم تكن هناك صفقة جارية).
        }
        else if (msg.msg_type === 'proposal') {
            if (msg.error) {
                console.error(`[Chat ID: ${currentChatId}] ❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                bot.sendMessage(currentChatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                // في حالة فشل الاقتراح، نعتبره خسارة وننتقل للمضاعفة
                // هنا لا نزيد config.loss أو currentTradeCountInCycle بعد
                // لأنه سيتم التعامل مع ذلك في handleTradeResult.
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, buy_error: true, message: msg.error.message });
                saveUserStates(); // حفظ الحالة
                return; // مهم جداً: الخروج من الدالة بعد معالجة الخطأ
            }

            const proposalId = msg.proposal.id;
            const askPrice = msg.proposal.ask_price;
            console.log(`[Chat ID: ${currentChatId}] ✅ تم الاقتراح: السعر المطلوب ${askPrice.toFixed(2)}$. جاري الشراء...`);
            bot.sendMessage(currentChatId, `✅ تم الاقتراح: السعر المطلوب ${askPrice.toFixed(2)}$. جاري الشراء...`);
            ws.send(JSON.stringify({
                "buy": proposalId,
                "price": askPrice
            }));
        }
        // 🔴🔴🔴 هام جداً 🔴🔴🔴
        // تأكد أن هذا الكود يبدأ مباشرة بعد 'else if' أو 'if' آخر
        // داخل دالة ws.on('message', async (message) => { ... })
        // ولا يوجد أي قوس { أو } زائد قبله أو بعده يغلقه أو يفتحه بشكل خاطئ.

        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                // ❌ معالجة فشل شراء الصفقة: نعتبرها خسارة ونمررها إلى handleTradeResult
                console.error(`[Chat ID: ${currentChatId}] ❌ فشل شراء الصفقة: ${msg.error.message}`);
                bot.sendMessage(currentChatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, buy_error: true, message: msg.error.message });
                saveUserStates(); // حفظ الحالة
                return; // مهم جداً: الخروج من الدالة بعد معالجة الخطأ لمنع استكمال باقي الكود في حالة الخطأ.
            } else {
                // ✅ تم شراء الصفقة بنجاح: هنا نبدأ عملية تتبع وتوقع النتيجة

                // استخراج المعلومات الأساسية من رسالة الشراء
                const contractId = msg.buy.contract_id;
                const entrySpot = parseFloat(msg.buy.buy_price); // سعر الدخول
                const contractType = msg.buy.contract_type; // نوع العقد (CALL/PUT)

                // 🎯🎯🎯 هذا هو الكود الجديد الذي يعتمد على الوقت المحلي (58 ثانية) 🎯🎯🎯
                const currentLocalPurchaseTimeEpoch = Math.floor(Date.now() / 1000); // وقت الشراء بالثواني بناءً على توقيت البوت
                const tradeDurationSeconds = 58; // الصفقة تنتهي عند الثانية 58 من وقت الشراء المحلي (بدلاً من 60)
                const expiryTime = currentLocalPurchaseTimeEpoch + tradeDurationSeconds; // وقت الانتهاء المتوقع (epoch - ثواني)

                // 🟢🟢🟢 DEBUG: للتأكد من القيمة المحسوبة محلياً ونوعها 🟢🟢🟢
                console.log(`[Chat ID: ${currentChatId}] Debug: Calculated Expiry Time (Local) = ${expiryTime}, Type: ${typeof expiryTime}`);
                // 🎯🎯🎯 انتهاء الكود الجديد 🎯🎯🎯

                // 1. تخزين تفاصيل العقد المفتوح حالياً في config.currentOpenContract
                // expiryTime هنا ستكون القيمة التي حسبناها محلياً
                config.currentOpenContract = {
                    id: contractId,
                    entrySpot: entrySpot, // تم تحويله إلى رقم عشري بالفعل أعلاه
                    type: contractType, // نوع الصفقة (CALL أو PUT)
                    expiryTime: expiryTime, // وقت انتهاء الصفقة بالثواني (epoch) - هذه هي القيمة الصحيحة الآن
                    longcode: msg.buy.longcode // هذا السطر اختياري لكنه مفيد لتتبع العقد
                };
                saveUserStates(); // حفظ الحالة فوراً بعد تحديث العقد المفتوح

                // رسائل تأكيد الدخول في الصفقة إلى الكونسول والتيليجرام
                // 🎯 استخدام entrySpot مباشرة لأنه تم تحويله لـ parseFloat أعلاه
                console.log(`[Chat ID: ${currentChatId}] 📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}, Entry: ${entrySpot.toFixed(3)}, Expiry: ${new Date(expiryTime * 1000).toLocaleTimeString()}`);
                bot.sendMessage(currentChatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}\nسعر الدخول: ${entrySpot.toFixed(3)}\nينتهي في: ${new Date(expiryTime * 1000).toLocaleTimeString()}`);

                // ⛔⛔⛔ ملاحظة مهمة جداً: لا يجب أن يكون هناك أي سطر هنا يقوم بـ "subscribe" على العقد المفتوح.
                // أي سطر مثل: ws.send(JSON.stringify({ "proposal_open_contract": 1, "contract_id": contractId, "subscribe": 1 }));
                // يجب أن يكون محذوفاً أو معلقاً تماماً، لأننا لم نعد نعتمد على رسائل is_sold الرسمية من Deriv.

                // 2. جدولة "إنذار" ليطلب آخر تيك عند الثانية 58 من دقيقة الصفقة
                const nowEpoch = Math.floor(Date.now() / 1000); // الوقت الحالي بالثواني (epoch)
                // نحسب الوقت المتبقي لطلب التيك.
                const timeToPredictSec = config.currentOpenContract.expiryTime - nowEpoch;

                // نتحقق من أن هناك وقتاً كافياً لجدولة هذا الإنذار (يجب أن يكون timeToPredictSec أكبر من صفر)
                if (timeToPredictSec > 0) {
                    console.log(`[Chat ID: ${currentChatId}] جاري جدولة فحص التنبؤ (بعد ${timeToPredictSec} ثواني).`);

                    // ⚠ مهم جداً: إذا كان هناك مؤقت سابق نشط (من صفقة سابقة لم يتم إلغاؤها بشكل صحيح)، نلغيه.
                    if (config.predictionCheckTimer) {
                        clearTimeout(config.predictionCheckTimer);
                        config.predictionCheckTimer = null; // 🎯 تم التأكيد على إفراغ المؤقت
                    }

                    // نقوم بضبط المؤقت (الإنذار) الذي سيقوم بطلب التيك في الوقت المحدد.
                    // الكود داخل setTimeout سيتم تشغيله تلقائياً عندما يحين الوقت.
                    config.predictionCheckTimer = setTimeout(async () => {
                        // هذا الجزء من الكود يعمل فقط إذا كان البوت لا يزال فعالاً
                        // وإذا كانت معلومات العقد الحالي لا تزال موجودة (لم يتم مسحها لسبب ما).
                        if (config.running && config.currentOpenContract && ws && ws.readyState === WebSocket.OPEN) {
                            console.log(`[Chat ID: ${currentChatId}] وصل المؤقت، جاري طلب آخر تيك لـ R_100 من Deriv...`);
                            bot.sendMessage(currentChatId, `🧠 جاري فحص نتيجة الصفقة...`); // رسالة لتنبيه المستخدم
                            // نرسل طلباً إلى Deriv للحصول على آخر سعر (تيك) لرمز R_100.
                            // الرد على هذا الطلب سيأتي في رسالة 'history' وسيتم معالجته في قسم
                            // else if (msg.msg_type === 'history')، والذي عدلناه مسبقاً.
                            ws.send(JSON.stringify({
                                "ticks_history": "R_100", // الرمز الذي نتداول عليه (يمكن استبداله بـ config.symbol إذا كان ديناميكياً)
                                "end": "latest",     // نريد آخر تيك متاح
                                "count": 1,          // نريد تيك واحد فقط
                                "subscribe": 0        // لا نريد الاشتراك في التيكات، فقط هذا الطلب لمرة واحدة
                            }));
                            // 🟢🟢🟢 DEBUG: تم إرسال طلب history 🟢🟢🟢
                            console.log(`[Chat ID: ${currentChatId}] Debug: ticks_history request sent.`);
                        } else {
                            // إذا لم يتم تلبية الشروط (البوت غير فعال أو العقد غير موجود أو الاتصال غير مفتوح)، نسجل ذلك.
                            console.log(`[Chat ID: ${currentChatId}] تم إلغاء فحص التنبؤ: البوت غير فعال أو العقد غير موجود أو الاتصال مغلق.`);
                            // هذه الحالة قد تعني أن الصفقة ألغيت أو انتهت بطريقة أخرى، يجب إعادة ضبط العلم
                            config.processingTradeResult = false; // إعادة ضبط إذا لم يتم الفحص
                            config.currentOpenContract = null; // تأكد من مسحه إذا لم يتم فحص الصفقة
                            // هنا يجب أن نعتبر الصفقة قد انتهت بخسارة لكسر الدورة إذا لم يتمكن من التحقق
                            handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, no_check: true });
                            saveUserStates();
                        }
                    }, timeToPredictSec * 1000); // setTimeout يتطلب الوقت بالمللي ثانية، لذلك نضرب timeToPredictSec في 1000
                } else {
                    // هذه الحالة تحدث إذا كانت الصفقة قصيرة جداً (أقل من ثانية متبقية)
                    // بناءً على طلبك بعدم انتظار أي شيء من Deriv، نعتبر هذه الصفقة خسارة فورية
                    // وننتقل مباشرة للمضاعفة عبر handleTradeResult.
                    console.log(`[Chat ID: ${currentChatId}] ⚠ وقت الصفقة قصير جداً للتنبؤ. أعتبرها خسارة فورية.`);
                    handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, time_too_short: true });
                    config.currentOpenContract = null; // مسح معلومات العقد المفتوح بعد معالجته
                    saveUserStates();
                }
            }
        }
        // ----------------------------------------------------------------------
        // 🎯🎯🎯 هذا هو قسم معالجة رسائل 'history' المعدل 🎯🎯🎯
        // ----------------------------------------------------------------------
            else if (msg.msg_type === 'ticks_history' && msg.history && msg.history.prices && msg.history.prices.length > 0 && config.currentOpenContract) {
            // 🟢🟢🟢 DEBUG: تم استلام رسالة history 🟢🟢🟢
            console.log(`[Chat ID: ${currentChatId}] Debug: Received history message.`);
            console.log(`[Chat ID: ${currentChatId}] Debug: config.processingTradeResult before check: ${config.processingTradeResult}`);

            if (config.processingTradeResult) {
                console.log(`[Chat ID: ${currentChatId}] تم استلام رسالة history ولكن النتيجة قيد المعالجة بالفعل، جاري التجاهل.`);
                return; // تجاهل إذا كنا بالفعل في عملية معالجة
            }
            config.processingTradeResult = true; // نضبط العلم: الآن بدأنا في معالجة نتيجة الصفقة.
            console.log(`[Chat ID: ${currentChatId}] Debug: config.processingTradeResult set to TRUE.`);

            // 🗑 إلغاء مؤقت التنبؤ الخاص بالصفقة الحالية (للتأكد من عدم تشغيله مرة أخرى بالخطأ).
            if (config.predictionCheckTimer) {
                clearTimeout(config.predictionCheckTimer);
                config.predictionCheckTimer = null;
                console.log(`[Chat ID: ${currentChatId}] Debug: predictionCheckTimer cleared.`);
            }

            const latestTickPrice = parseFloat(msg.history.prices[0]);
            const contract = config.currentOpenContract;
            let isWin = false;
            let profit = 0;

            // 🟢🟢🟢 DEBUG: تفاصيل العقد والتيك 🟢🟢🟢
            console.log(`[Chat ID: ${currentChatId}] Debug: Contract Type: ${contract.type}, Entry Spot: ${contract.entrySpot}, Latest Tick: ${latestTickPrice}`);


            if (isNaN(contract.entrySpot) || contract.entrySpot === null) {
                console.error(`[Chat ID: ${currentChatId}] ❌ خطأ: contract.entrySpot غير صالح في قسم history! القيمة: ${contract.entrySpot}`);
                bot.sendMessage(currentChatId, `❌ خطأ داخلي: لا يمكن تحديد نتيجة الصفقة (سعر الدخول غير معروف).`);
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, internal_error: true });
                config.processingTradeResult = false; // إعادة ضبط العلم
                saveUserStates();
                return;
            }

            // حساب النتيجة بناءً على التنبؤ
            if (contract.type === 'CALL') {
                isWin = latestTickPrice > contract.entrySpot;
            } else if (contract.type === 'PUT') {
                isWin = latestTickPrice < contract.entrySpot;
            }

            if (isWin) {
                profit = config.currentStake * 0.95; // الربح المتوقع حوالي 95%
            } else {
                profit = -config.currentStake; // خسارة كامل الستيك
            }

            console.log(`[Chat ID: ${currentChatId}] 🧠 تنبؤ بالنتيجة عند الثانية 58: ${isWin ? 'ربح' : 'خسارة'} بسعر ${latestTickPrice.toFixed(3)}. الربح/الخسارة: ${profit.toFixed(2)}`);
            bot.sendMessage(currentChatId, `🧠 تنبؤ عند الثانية 58: ${isWin ? '✅ ربح' : '❌ خسارة'}! ربح/خسارة: ${profit.toFixed(2)}`);

            // ✨ معالجة النتيجة هنا
            handleTradeResult(currentChatId, config, ws, { profit: profit, win: isWin });

            // 🔴🔴🔴 يجب إعادة ضبط processingTradeResult هنا فقط بعد اكتمال handleTradeResult بالكامل 🔴🔴🔴
            // لا تضع هذا السطر هنا: config.processingTradeResult = false;
            // لأنه سيتم التعامل معه داخل handleTradeResult نفسها لضمان التوقيت الصحيح.
            // أيضا، config.currentOpenContract يتم مسحه الآن داخل handleTradeResult() في الأماكن المناسبة.

        } else if (msg.msg_type === 'error') {
            console.error(`[Chat ID: ${currentChatId}] ⚠ خطأ من Deriv API: ${msg.error.message}`);
            bot.sendMessage(currentChatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            // في حالة خطأ عام من API، ننهي دورة التداول الحالية ونعيد ضبط الستيك
            // ولكن يجب أن نسمح لـ handleTradeResult بمعالجة الخسارة المتوقعة بشكل صحيح.
            // إذا كان هناك عقد مفتوح حاليا، فسنمرر هذا الخطأ كخسارة.
            if (config.currentOpenContract) {
                console.log(`[Chat ID: ${currentChatId}] خطأ API أثناء وجود عقد مفتوح. أعتبرها خسارة.`);
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, api_error: true, message: msg.error.message });
            } else {
                // إذا لم يكن هناك عقد مفتوح، فقط أعد ضبط الحالة
                config.tradingCycleActive = false;
                config.currentStake = config.stake;
                config.currentTradeCountInCycle = 0;
                saveUserStates();
            }
        }
    }); // نهاية ws.on('message')

    // دالة مساعدة لمعالجة نتائج الصفقة (تم فصلها لتجنب التكرار)
    function handleTradeResult(currentChatId, config, ws, result) {
        // 🟢🟢🟢 DEBUG: بدأ معالجة النتيجة 🟢🟢🟢
        console.log(`[Chat ID: ${currentChatId}] Debug: handleTradeResult started. Result: `, result);

        const profit = result.profit;
        const isWin = result.win;

        config.profit += profit;

        if (isWin) {
            config.win++;
            console.log(`[Chat ID: ${currentChatId}] ✅ ربح! ربح: ${profit.toFixed(2)}`);
            bot.sendMessage(currentChatId, `📊 نتيجة الصفقة: ✅ ربح! ربح: ${profit.toFixed(2)}\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}\n\n✅ تم الربح. جاري انتظار شمعة 10 دقائق جديدة.`);

            // إعادة ضبط للمضاعفات بعد الربح
            config.currentTradeCountInCycle = 0;
            config.currentStake = config.stake; // العودة للستيك الأساسي
            config.baseTradeDirection = null; // إعادة ضبط الاتجاه الأساسي
            config.nextTradeDirection = null; // إعادة ضبط الاتجاه التالي
            config.currentOpenContract = null; // 🎯 مسح العقد المفتوح بعد الربح

            // 🎯 هذا هو السطر المهم: إذا كان ربح، الدورة انتهت بنجاح.
            config.tradingCycleActive = false; // 🎯 تم النقل والتأكيد

        } else { // حالة الخسارة
            config.loss++;
            config.currentTradeCountInCycle++; // زيادة عداد الخسائر المتتالية

            let messageText = `📊 نتيجة الصفقة: ❌ خسارة! خسارة: ${Math.abs(profit).toFixed(2)}\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`;

            if (config.currentTradeCountInCycle > MAX_MARTINGALE_TRADES) {
                messageText += `\n🛑 تم الوصول إلى الحد الأقصى للمضاعفات (${MAX_MARTINGALE_TRADES} مرات خسارة متتالية). تم إيقاف البوت تلقائياً.`;
                console.log(`[Chat ID: ${currentChatId}] 🛑 وصل إلى الحد الأقصى للمضاعفات.`);
                bot.sendMessage(currentChatId, messageText);
                config.running = false;
                if (ws.readyState === WebSocket.OPEN) ws.close();
                config.currentOpenContract = null; // 🎯 مسح العقد المفتوح
                // 🎯 هنا أيضاً، الدورة انتهت (بفشل).
                config.tradingCycleActive = false; // 🎯 تم النقل والتأكيد
            } else {
                config.currentStake = parseFloat((config.currentStake * MARTINGALE_FACTOR).toFixed(2)); // مضاعفة الستيك

                // تحديد اتجاه الصفقة المضاعفة بناءً على قواعدك
                if (config.currentTradeCountInCycle === 1) { // إذا كانت هذه أول مضاعفة
                    config.nextTradeDirection = reverseDirection(config.baseTradeDirection);
                }
                // إذا كانت المضاعفات التالية، يبقى الاتجاه هو نفسه الذي تم تحديده في أول مضاعفة (لا يوجد تغيير هنا)

                messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى ${config.currentStake.toFixed(2)}. الصفقة التالية ستكون "${config.nextTradeDirection}".`;
                console.log(`[Chat ID: ${currentChatId}] ❌ خسارة. جاري المضاعفة. الصفقة التالية: ${config.nextTradeDirection}`);
                bot.sendMessage(currentChatId, messageText);

                // 🎯 هنا لا نلمس tradingCycleActive لأن الدورة لم تنته بعد، بل دخلنا مضاعفة
                // الدخول في الصفقة المضاعفة فوراً
                config.currentOpenContract = null; // 🎯 مسح العقد المفتوح بعد كل صفقة
                setTimeout(() => {
                    if (config.running) {
                        enterTrade(config, config.nextTradeDirection, currentChatId, ws);
                    }
                }, 1000); // 1 ثانية تأخير 🎯 تم التعديل إلى 1000 مللي ثانية (كان 3000)
            }
        }
        saveUserStates(); // حفظ الحالة بعد كل معالجة للنتيجة
        config.processingTradeResult = false; // 🟢🟢🟢 IMPORTANT: Reset this flag after handling the result 🟢🟢🟢
        console.log(`[Chat ID: ${currentChatId}] Debug: handleTradeResult finished. processingTradeResult set to FALSE.`);


        // فحص Take Profit / Stop Loss بعد كل صفقة
        if (config.tp > 0 && config.profit >= config.tp) {
            console.log(`[Chat ID: ${currentChatId}] 🎯 وصل إلى هدف الربح.`);
            bot.sendMessage(currentChatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: ${config.tp.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
            config.running = false;
            saveUserStates();
            if (ws.readyState === WebSocket.OPEN) ws.close();
            config.currentOpenContract = null;
            config.tradingCycleActive = false; // 🎯 الدورة تنتهي هنا أيضاً
        } else if (config.sl > 0 && config.profit <= -config.sl) {
            console.log(`[Chat ID: ${currentChatId}] 🛑 وصل إلى حد الخسارة.`);
            bot.sendMessage(currentChatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: ${config.sl.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
            config.running = false;
            saveUserStates();
            if (ws.readyState === WebSocket.OPEN) ws.close();
            config.currentOpenContract = null;
            config.tradingCycleActive = false; // 🎯 الدورة تنتهي هنا أيضاً
        }
    }


    ws.on('close', (code, reason) => {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[Chat ID: ${chatId}] [${timestamp}] ❌ اتصال Deriv WebSocket مغلق. الكود: ${code}, السبب: ${reason.toString() || 'لا يوجد سبب محدد'}`);

        // مسح أي مؤقتات معلقة للتنبؤ عند إغلاق الاتصال
        if (config.predictionCheckTimer) {
            clearTimeout(config.predictionCheckTimer);
            config.predictionCheckTimer = null;
        }
        // 🟢🟢🟢 إعادة ضبط العلم عند إغلاق الاتصال لضمان عدم بقائه عالقاً 🟢🟢🟢
        config.processingTradeResult = false;
        // 🔴🔴🔴 هذا السطر صحيح: config.currentOpenContract = null; لأنه يتم مسحه في handleTradeResult.
        // لكن إذا أغلق الاتصال فجأة قبل handleTradeResult، يجب مسحه أيضاً.
        config.currentOpenContract = null; // مسح العقد المفتوح لضمان النظافة

        if (config.running) {
            bot.sendMessage(chatId, '⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...');
            reconnectDeriv(chatId, config);
        } else {
            // إذا كان البوت متوقفاً بشكل متعمد، نزيل الاتصال ونحفظ الحالة
            if (userDerivConnections[chatId]) {
                delete userDerivConnections[chatId];
            }
            saveUserStates();
        }
    });

    ws.on('error', (error) => {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.error(`[Chat ID: ${chatId}] [${timestamp}] ❌ خطأ في اتصال Deriv WebSocket: ${error.message}`);
        bot.sendMessage(chatId, `❌ خطأ في اتصال Deriv: ${error.message}.`);
        // في حالة الخطأ، نغلق الاتصال ونترك ws.on('close') لتتعامل مع إعادة الاتصال
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });
} // نهاية دالة startBotForUser

// -------------------------------------------------------------------------
// أوامر تيليجرام
// -------------------------------------------------------------------------

const bot = new TelegramBot('7748492830:AAEJ_9UVXFkq-u8SlFOrAXzbdsfsoo2IsW0', { polling: true }); // <--- !!! استبدل هذا بتوكن التيليجرام الخاص بك !!!

// UptimeRobot (لا علاقة لها بالبوت مباشرة، ولكن للحفاظ على تشغيل السيرفر)
// 🎯🎯 هذا هو الجزء الذي يتصل بـ Express.js، باستخدام متغير البيئة PORT
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Deriv bot is running'));
app.listen(3000, () => console.log('🌐 UptimeRobot is connected on port 3000'));


bot.onText(/\/start/, (msg) => {
    const id = msg.chat.id;

    if (!accessList.includes(id)) {
        return bot.sendMessage(id, '❌ غير مصرح لك باستخدام هذا البوت.');
    }

    // إغلاق أي اتصال Deriv سابق للمستخدم إذا كان موجودًا
    if (userDerivConnections[id]) {
        userDerivConnections[id].close();
        delete userDerivConnections[id];
    }

    userStates[id] = {
        step: 'api',
        // بيانات الشمعة (لتحليل الشمعة الـ 10 دقائق)
        candle10MinOpenPrice: null,
        lastProcessed10MinIntervalStart: -1,
        // حالة دورة التداول
        tradingCycleActive: false,
        currentTradeCountInCycle: 0, // عداد لصفقات المارتينجال المتتالية

        // إحصائيات الربح والخسارة
        profit: 0, // الربح الإجمالي
        win: 0,    // عدد الصفقات الرابحة
        loss: 0,   // عدد الصفقات الخاسرة

        // إعدادات الرهان والمضاعفة
        currentStake: 0, // الرهان الحالي (يتغير مع المضاعفة)
        stake: 0, // الرهان الأساسي (المبلغ الذي تبدأ به الصفقة)
        // قيم المارتينجال ثابتة ولن تُطلب من المستخدم
        // martingaleFactor: MARTINGALE_FACTOR,
        // maxMartingaleTrades: MAX_MARTINGALE_TRADES,

        // متغيرات تتبع الاتجاه للمضاعفات
        baseTradeDirection: null, // اتجاه الصفقة الأساسية التي بدأت الدورة
        nextTradeDirection: null, // الاتجاه للصفقة التالية (بعد الخسارة)

        // إعدادات Take Profit و Stop Loss
        tp: 0, // هدف الربح (Take Profit)
        sl: 0, // حد الخسارة (Stop Loss)

        token: '' // API Token الخاص بـ Deriv
    };
    saveUserStates(); // حفظ الحالة الأولية

    bot.sendMessage(id, '🔐 أرسل Deriv API Token الخاص بك:');
});

bot.on('message', (msg) => { // هذا هو معالج رسائل التيليجرام، لا تخلط بينه وبين ws.on('message')
    const id = msg.chat.id;
    const text = msg.text;
    const state = userStates[id];

    // إذا لم يكن هناك حالة للمستخدم أو كانت رسالة أمر
    if (!state || !state.step || text.startsWith('/')) return;

    if (state.step === 'api') {
        state.token = text;
        state.step = 'stake';
        saveUserStates();
        bot.sendMessage(id, '💵 أرسل مبلغ الصفقة الأساسي (الستيك):');
    } else if (state.step === 'stake') {
        state.stake = parseFloat(text);
        state.currentStake = state.stake; // تهيئة الرهان الحالي بالأساسي
        state.step = 'tp'; // ننتقل مباشرة إلى TP لأن عامل المضاعفة والحد ثابتان
        saveUserStates();
        bot.sendMessage(id, '🎯 أرسل الهدف (Take Profit):');
    } else if (state.step === 'tp') {
        state.tp = parseFloat(text);
        state.step = 'sl';
        saveUserStates();
        bot.sendMessage(id, '🛑 أرسل الحد الأقصى للخسارة (Stop Loss):');
    } else if (state.step === 'sl') {
        state.sl = parseFloat(text);
        state.running = false; // البوت متوقف حتى يتم تشغيله يدوياً
        // إعادة تعيين جميع المتغيرات المتعلقة بالتداول لضمان بداية نظيفة
        state.candle10MinOpenPrice = null;
        state.lastProcessed10MinIntervalStart = -1;
        state.tradingCycleActive = false;
        state.currentTradeCountInCycle = 0;
        state.profit = 0;
        state.win = 0;
        state.loss = 0;
        state.currentStake = state.stake; // إعادة الستيك للأساسي
        state.baseTradeDirection = null;
        state.nextTradeDirection = null;

        saveUserStates();

        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
    }
});

bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];

    if (!user || !user.token || user.stake === 0) { // التحقق من أن المستخدم قام بالإعدادات الأساسية
        bot.sendMessage(id, '⚠ الرجاء إعداد البوت أولاً باستخدام /start وتعبئة جميع البيانات.');
        return;
    }

    if (user.running) {
        bot.sendMessage(id, '🔄 البوت قيد التشغيل بالفعل.');
        return;
    }

    // إعادة تعيين بعض القيم لضمان بداية جديدة ونظيفة عند كل تشغيل
    user.running = true;
    user.currentStake = user.stake; // إعادة تعيين الستيك الأساسي
    user.currentTradeCountInCycle = 0; // إعادة تعيين عداد المارتينغال
    user.tradingCycleActive = false; // التأكد من عدم وجود دورة نشطة سابقة
    user.candle10MinOpenPrice = null; // إعادة تعيين بيانات الشمعة
    user.lastProcessed10MinIntervalStart = -1; // إعادة تعيين بيانات الشمعة
    user.profit = 0; // إعادة تعيين الأرباح
    user.win = 0;    // إعادة تعيين عدد مرات الربح
    user.loss = 0;   // إعادة تعيين عدد مرات الخسارة
    user.baseTradeDirection = null;
    user.nextTradeDirection = null;

    saveUserStates();
    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user); // بدء اتصال Deriv وبدء العمل
});

bot.onText(/\/stop/, (msg) => {
    const id = msg.chat.id;
    if (userStates[id]) {
        userStates[id].running = false; // تعيين حالة التوقف
        saveUserStates(); // حفظ حالة "stopped"

        // مسح أي مؤقتات معلقة للتنبؤ عند إيقاف البوت
        // 🟢🟢🟢 تم تغيير predictionTimeout إلى predictionCheckTimer 🟢🟢🟢
        if (userStates[id].predictionCheckTimer) {
            clearTimeout(userStates[id].predictionCheckTimer);
            userStates[id].predictionCheckTimer = null;
        }
        userStates[id].processingTradeResult = false;
        userStates[id].currentOpenContract = null; // 🟢🟢🟢 تم تغيير currentContract إلى currentOpenContract 🟢🟢🟢


        // إغلاق اتصال WebSocket لـ Deriv إذا كان مفتوحًا
        if (userDerivConnections[id] && userDerivConnections[id].readyState === WebSocket.OPEN) {
            userDerivConnections[id].close();
            delete userDerivConnections[id]; // إزالته من القائمة
            console.log(`[Chat ID: ${id}] تم إغلاق اتصال Deriv بناءً على طلب المستخدم.`);
        }
        bot.sendMessage(id, '🛑 تم إيقاف البوت.');
    } else {
        bot.sendMessage(id, '⚠ البوت ليس قيد التشغيل ليتم إيقافه.');
    }
});


// بدء البوت والاستماع للأوامر
console.log('Bot started and waiting for commands...');
loadUserStates();
