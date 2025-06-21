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

    // لتخزين آخر تيك تم استقباله (مهم لتحديد نتيجة الصفقة)
    config.lastReceivedTickPrice = null;

    ws.on('open', () => {
        console.log(`[Chat ID: ${chatId}] ✅ تم الاتصال بـ Deriv. جاري المصادقة...`);
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token }));
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);
        const currentChatId = chatId;

        // 🟢🟢🟢 DEBUG: سجل نوع الرسالة الواردة (تم تفعيله لأغراض التصحيح) 🟢🟢🟢
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

            // 🟢🟢🟢 تحديث آخر تيك تم استقباله باستمرار (مهم لتحديد نتيجة الصفقة لاحقاً) 🟢🟢🟢
            config.lastReceivedTickPrice = currentTickPrice;

            // 🟢🟢🟢 DEBUG: يمكنك تفعيل هذا لمراقبة التيكات 🟢🟢🟢
            console.log(`[Chat ID: ${currentChatId}] TICK: ${currentTickPrice.toFixed(3)} at ${tickDate.toLocaleTimeString()}`);
            console.log(`[Chat ID: ${currentChatId}] Current Minute: ${currentMinute}, Current Second: ${currentSecond}`);


            const current10MinIntervalStartMinute = Math.floor(currentMinute / 10) * 10;

            // منطق تحديد اتجاه الصفقة الأساسية (فقط عند بداية شمعة الـ 10 دقائق)
            if (config.running && !config.tradingCycleActive) {
                // 🟢🟢🟢 DEBUG: جديد لمعرفة دخول الكتلة 🟢🟢🟢
                console.log(`[Chat ID: ${currentChatId}] DEBUG: دخلنا كتلة التحقق الرئيسية لشمعة 10 دقائق.`);

                if (currentSecond === 0 && currentMinute === current10MinIntervalStartMinute) {
                     // 🟢🟢🟢 DEBUG: جديد لمعرفة توقيت بداية الشمعة 🟢🟢🟢
                    console.log(`[Chat ID: ${currentChatId}] DEBUG: الوقت الحالي هو الثانية 0 وبداية الفترة. آخر فترة تمت معالجتها: ${config.lastProcessed10MinIntervalStart}, الفترة الحالية: ${current10MinIntervalStartMinute}`);

                    if (config.lastProcessed10MinIntervalStart !== current10MinIntervalStartMinute) {
                        // 🟢🟢🟢 DEBUG: جديد لمعرفة بدء معالجة الشمعة 🟢🟢🟢
                        console.log(`[Chat ID: ${currentChatId}] DEBUG: جاري معالجة فترة شمعة 10 دقائق جديدة.`);

                        let tradeDirection = 'none';

                        if (config.candle10MinOpenPrice !== null) {
                            const previousCandleOpen = config.candle10MinOpenPrice;
                            // 🔴🔴🔴 هذا السطر تم إعادته كما كان يستخدم "currentTickPrice" 🔴🔴🔴
                            const previousCandleClose = currentTickPrice; 

                            if (previousCandleClose < previousCandleOpen) {
                                tradeDirection = 'CALL'; // شمعة هابطة -> الصفقة التالية صعود
                                console.log(`[Chat ID: ${currentChatId}] 📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                                bot.sendMessage(currentChatId,` 📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
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

                        // 🔴🔴🔴 هذا السطر تم إعادته كما كان يستخدم "currentTickPrice" 🔴🔴🔴
                        config.candle10MinOpenPrice = currentTickPrice;
                        config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute;
                        saveUserStates();

                        if (tradeDirection !== 'none') {
                            // 🟢🟢🟢 DEBUG: جديد لمعرفة تحديد اتجاه الصفقة 🟢🟢🟢
                            console.log(`[Chat ID: ${currentChatId}] DEBUG: تم تحديد اتجاه الصفقة: ${tradeDirection}. جاري التحضير لدخول الصفقة.`);
                            config.baseTradeDirection = tradeDirection;
                            config.nextTradeDirection = tradeDirection;
                            await enterTrade(config, config.nextTradeDirection, currentChatId, ws);
                            config.tradingCycleActive = true;
                            saveUserStates();
                        } else {
                            // 🟢🟢🟢 DEBUG: جديد لمعرفة عدم تحديد اتجاه الصفقة 🟢🟢🟢
                            console.log(`[Chat ID: ${currentChatId}] DEBUG: لم يتم تحديد اتجاه الصفقة. جاري إعادة ضبط الستيك.`);
                            config.currentStake = config.stake;
                            config.currentTradeCountInCycle = 0;
                            saveUserStates();
                        }
                    }
                }
            }
        }
        else if (msg.msg_type === 'proposal') {
            if (msg.error) {
                console.error(`[Chat ID: ${currentChatId}] ❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                bot.sendMessage(currentChatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
                // في حالة فشل الاقتراح، نمرره إلى handleTradeResult كخسارة
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, buy_error: true, message: msg.error.message });
                saveUserStates();
                return;
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
        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                // ❌ معالجة فشل شراء الصفقة
                console.error(`[Chat ID: ${currentChatId}] ❌ فشل شراء الصفقة: ${msg.error.message}`);
                bot.sendMessage(currentChatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, buy_error: true, message: msg.error.message });
                saveUserStates();
                return;
            } else {
                const contractId = msg.buy.contract_id;
                const entrySpot = parseFloat(msg.buy.spot_price); // سعر الدخول الفعلي للمؤشر
                const entryTime = parseFloat(msg.buy.spot_time); // وقت الدخول الفعلي للمؤشر
                const contractType = msg.buy.contract_type;

                // 🟢 تعديل: لن نعتمد على تاريخ انتهاء من Deriv. سنعتمد على 58 ثانية
                const tradeDurationSeconds = 58;
                const expiryTime = entryTime + tradeDurationSeconds; // وقت الانتهاء المستهدف (Epoch)

                // تخزين تفاصيل العقد المفتوح حالياً
                config.currentOpenContract = {
                    id: contractId,
                    entrySpot: entrySpot,
                    type: contractType,
                    expiryTime: expiryTime, // استخدام وقت الانتهاء المحسوب
                    longcode: msg.buy.longcode
                };
                saveUserStates();

                console.log(`[Chat ID: ${currentChatId}] 📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}, Entry: ${entrySpot.toFixed(3)}, Expiry Time (Target): ${new Date(expiryTime * 1000).toLocaleTimeString()}`);
                bot.sendMessage(currentChatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}\nسعر الدخول: ${entrySpot.toFixed(3)}\nينتهي في: ${new Date(expiryTime * 1000).toLocaleTimeString()}`);

                // 🟢🟢🟢 التعديل الجوهري هنا: جدولة التحقق من النتيجة باستخدام آخر تيك محلي 🟢🟢🟢
                if (config.predictionCheckTimer) {
                    clearTimeout(config.predictionCheckTimer);
                    config.predictionCheckTimer = null;
                }

                // حساب الوقت المتبقي لانتهاء الصفقة ليتم الفحص
                const timeToPredictSec = expiryTime - Math.floor(Date.now() / 1000);

                if (timeToPredictSec > 0) {
                    console.log(`[Chat ID: ${currentChatId}] جاري جدولة فحص النتيجة (بعد ${timeToPredictSec} ثواني) باستخدام التيك المحلي الأخير.`);
                    config.predictionCheckTimer = setTimeout(async () => {
                        // 🟢🟢🟢 هنا نستخدم "config.lastReceivedTickPrice" لتحديد النتيجة 🟢🟢🟢
                        if (config.running && config.currentOpenContract && config.lastReceivedTickPrice !== null) {
                            console.log(`[Chat ID: ${currentChatId}] 🧠 وصل المؤقت، جاري فحص النتيجة باستخدام التيك المحلي الأخير: ${config.lastReceivedTickPrice.toFixed(3)}`);
                            bot.sendMessage(currentChatId, `🧠 جاري فحص نتيجة الصفقة...`);

                            const latestTickPrice = config.lastReceivedTickPrice;
                            const contract = config.currentOpenContract;
                            let isWin = false;
                            let profit = 0;

                            if (isNaN(contract.entrySpot) || contract.entrySpot === null) {
                                console.error(`[Chat ID: ${currentChatId}] ❌ خطأ: contract.entrySpot غير صالح عند فحص النتيجة! القيمة: ${contract.entrySpot}`);
                                bot.sendMessage(currentChatId, `❌ خطأ داخلي: لا يمكن تحديد نتيجة الصفقة (سعر الدخول غير معروف).`);
                                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, internal_error: true });
                                return;
                            }

                            if (contract.type === 'CALL') {
                                isWin = latestTickPrice > contract.entrySpot;
                            } else if (contract.type === 'PUT') {
                                isWin = latestTickPrice < contract.entrySpot;
                            }

                            if (isWin) {
                                profit = config.currentStake * 0.95;
                            } else {
                                profit = -config.currentStake;
                            }

                            console.log(`[Chat ID: ${currentChatId}] 🧠 تنبؤ بالنتيجة عند الثانية 58: ${isWin ? 'ربح' : 'خسارة'} بسعر ${latestTickPrice.toFixed(3)}. الربح/الخسارة: ${profit.toFixed(2)}`);
                            bot.sendMessage(currentChatId, `🧠 تنبؤ عند الثانية 58: ${isWin ? '✅ ربح' : '❌ خسارة'}! ربح/خسارة: ${profit.toFixed(2)}`);

                            handleTradeResult(currentChatId, config, ws, { profit: profit, win: isWin });

                        } else {
                            console.log(`[Chat ID: ${currentChatId}] تم إلغاء فحص النتيجة: البوت غير فعال أو العقد غير موجود أو لم يتم استقبال تيك بعد.`);
                            handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, no_check: true });
                        }
                    }, timeToPredictSec * 1000);
                } else {
                    console.log(`[Chat ID: ${currentChatId}] ⚠ وقت الصفقة قصير جداً للتنبؤ. أعتبرها خسارة فورية.`);
                    handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, time_too_short: true });
                }
            }
        }
        else if (msg.msg_type === 'error') {
            console.error(`[Chat ID: ${currentChatId}] ⚠ خطأ من Deriv API: ${msg.error.message}`);
            bot.sendMessage(currentChatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            if (config.currentOpenContract) {
                console.log(`[Chat ID: ${currentChatId}] خطأ API أثناء وجود عقد مفتوح. أعتبرها خسارة.`);
                handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, api_error: true, message: msg.error.message });
            } else {
                config.tradingCycleActive = false;
                config.currentStake = config.stake;
                config.currentTradeCountInCycle = 0;
                saveUserStates();
            }
        }
    }); // نهاية ws.on('message')

    // دالة مساعدة لمعالجة نتائج الصفقة (تم فصلها لتجنب التكرار)
    function handleTradeResult(currentChatId, config, ws, result) {
        console.log(`[Chat ID: ${currentChatId}] Debug: handleTradeResult started. Result: `, result);

        const profit = result.profit;
        const isWin = result.win;

        config.profit += profit;

        if (isWin) {
            config.win++;
            console.log(`[Chat ID: ${currentChatId}] ✅ ربح! ربح: ${profit.toFixed(2)}`);
            bot.sendMessage(currentChatId, `📊 نتيجة الصفقة: ✅ ربح! ربح: ${profit.toFixed(2)}\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}\n\n✅ تم الربح. جاري انتظار شمعة 10 دقائق جديدة.`);

            config.currentTradeCountInCycle = 0;
            config.currentStake = config.stake;
            config.baseTradeDirection = null;
            config.nextTradeDirection = null;
            config.currentOpenContract = null;
            config.tradingCycleActive = false;

        } else { // حالة الخسارة
            config.loss++;
            config.currentTradeCountInCycle++;

            let messageText = `📊 نتيجة الصفقة: ❌ خسارة! خسارة: ${Math.abs(profit).toFixed(2)}\n💰 الرصيد الكلي: ${config.profit.toFixed(2)}\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`;

            if (config.currentTradeCountInCycle > MAX_MARTINGALE_TRADES) {
                messageText +=` \n🛑 تم الوصول إلى الحد الأقصى للمضاعفات (${MAX_MARTINGALE_TRADES} مرات خسارة متتالية). تم إيقاف البوت تلقائياً.`;
                console.log(`[Chat ID: ${currentChatId}] 🛑 وصل إلى الحد الأقصى للمضاعفات.`);
                bot.sendMessage(currentChatId, messageText);
                config.running = false;
                if (ws.readyState === WebSocket.OPEN) ws.close();
                config.currentOpenContract = null;
                config.tradingCycleActive = false;
            } else {
                config.currentStake = parseFloat((config.currentStake * MARTINGALE_FACTOR).toFixed(2));

                if (config.currentTradeCountInCycle === 1) {
                    config.nextTradeDirection = reverseDirection(config.baseTradeDirection);
                }

                messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى ${config.currentStake.toFixed(2)}. الصفقة التالية ستكون "${config.nextTradeDirection}".`;
                console.log(`[Chat ID: ${currentChatId}] ❌ خسارة. جاري المضاعفة. الصفقة التالية: ${config.nextTradeDirection}`);
                bot.sendMessage(currentChatId, messageText);

                config.currentOpenContract = null;
                setTimeout(() => {
                    if (config.running) {
                        enterTrade(config, config.nextTradeDirection, currentChatId, ws);
                    }
                }, 1000);
            }
        }
        saveUserStates();

        // فحص Take Profit / Stop Loss بعد كل صفقة
        if (config.tp > 0 && config.profit >= config.tp) {
            console.log(`[Chat ID: ${currentChatId}] 🎯 وصل إلى هدف الربح.`);
            bot.sendMessage(currentChatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: ${config.tp.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
            config.running = false;
            saveUserStates();
            if (ws.readyState === WebSocket.OPEN) ws.close();
            config.currentOpenContract = null;
            config.tradingCycleActive = false;
        } else if (config.sl > 0 && config.profit <= -config.sl) {
            console.log(`[Chat ID: ${currentChatId}] 🛑 وصل إلى حد الخسارة.`);
            bot.sendMessage(currentChatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: ${config.sl.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
            config.running = false;
            saveUserStates();
            if (ws.readyState === WebSocket.OPEN) ws.close();
            config.currentOpenContract = null;
            config.tradingCycleActive = false;
        }
    }


    ws.on('close', (code, reason) => {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[Chat ID: ${chatId}] [${timestamp}] ❌ اتصال Deriv WebSocket مغلق. الكود: ${code}, السبب: ${reason.toString() || 'لا يوجد سبب محدد'}`);

        if (config.predictionCheckTimer) {
            clearTimeout(config.predictionCheckTimer);
            config.predictionCheckTimer = null;
        }
        config.currentOpenContract = null; // مسح العقد المفتوح لضمان النظافة

        if (config.running) {
            bot.sendMessage(chatId, '⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...');
            reconnectDeriv(chatId, config);
        } else {
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
const port = process.env.PORT || 3000;
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
        tradingCycleActive: false,
        currentTradeCountInCycle: 0,
        profit: 0,
        win: 0,
        loss: 0,
        currentStake: 0,
        stake: 0,
        baseTradeDirection: null,
        nextTradeDirection: null,
        tp: 0,
        sl: 0,
        token: '',
        lastReceivedTickPrice: null // لتخزين آخر تيك تم استقباله
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
        bot.sendMessage(id, '💵 أرسل مبلغ الصفقة الأساسي (الستيك):');
    } else if (state.step === 'stake') {
        state.stake = parseFloat(text);
        state.currentStake = state.stake;
        state.step = 'tp';
        saveUserStates();
        bot.sendMessage(id, '🎯 أرسل الهدف (Take Profit):');
    } else if (state.step === 'tp') {
        state.tp = parseFloat(text);
        state.step = 'sl';
        saveUserStates();
        bot.sendMessage(id, '🛑 أرسل الحد الأقصى للخسارة (Stop Loss):');
    } else if (state.step === 'sl') {
        state.sl = parseFloat(text);
        state.running = false;
        state.candle10MinOpenPrice = null;
        state.lastProcessed10MinIntervalStart = -1;
        state.tradingCycleActive = false;
        state.currentTradeCountInCycle = 0;
        state.profit = 0;
        state.win = 0;
        state.loss = 0;
        state.currentStake = state.stake;
        state.baseTradeDirection = null;
        state.nextTradeDirection = null;
        state.lastReceivedTickPrice = null; // إعادة تهيئة المتغير

        saveUserStates();

        bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');
    }
});

bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];

    if (!user || !user.token || user.stake === 0) {
        bot.sendMessage(id, '⚠ الرجاء إعداد البوت أولاً باستخدام /start وتعبئة جميع البيانات.');
        return;
    }

    if (user.running) {
        bot.sendMessage(id, '🔄 البوت قيد التشغيل بالفعل.');
        return;
    }

    user.running = true;
    user.currentStake = user.stake;
    user.currentTradeCountInCycle = 0;
    user.tradingCycleActive = false;
    user.candle10MinOpenPrice = null;
    user.lastProcessed10MinIntervalStart = -1;
    user.profit = 0;
    user.win = 0;
    user.loss = 0;
    user.baseTradeDirection = null;
    user.nextTradeDirection = null;
    user.lastReceivedTickPrice = null; // إعادة تهيئة المتغير

    saveUserStates();
    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user);
});

bot.onText(/\/stop/, (msg) => {
    const id = msg.chat.id;
    if (userStates[id]) {
        userStates[id].running = false;
        saveUserStates();

        if (userStates[id].predictionCheckTimer) {
            clearTimeout(userStates[id].predictionCheckTimer);
            userStates[id].predictionCheckTimer = null;
        }
        userStates[id].currentOpenContract = null;
        userStates[id].lastReceivedTickPrice = null; // مسح المتغير عند الإيقاف

        if (userDerivConnections[id] && userDerivConnections[id].readyState === WebSocket.OPEN) {
            userDerivConnections[id].close();
            delete userDerivConnections[id];
            console.log(`[Chat ID: ${id}] تم إغلاق اتصال Deriv بناءً على طلب المستخدم.`);
        }
        bot.sendMessage(id, '🛑 تم إيقاف البوت.');
    } else {
        bot.sendMessage(id, '⚠ البوت ليس قيد التشغيل ليتم إيقافه.');
    }
});


console.log('Bot started and waiting for commands...');
loadUserStates();
