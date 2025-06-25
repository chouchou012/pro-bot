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
    if (ws && ws.readyState === WebSocket.OPEN) {
        const formattedStake = parseFloat(config.currentStake.toFixed(2));
        console.log(`[Chat ID: ${chatId}] ⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ...`);
        bot.sendMessage(chatId, `⏳ جاري إرسال اقتراح لصفقة ${direction} بمبلغ ${formattedStake.toFixed(2)}$ ...`);

        // 🔴🔴🔴 هذا هو الكود الجديد هنا 🔴🔴🔴
        // نفترض أن سعر الدخول هو آخر تيك استقبلناه
        const assumedEntrySpot = config.lastReceivedTickPrice; 
        // نفترض أن وقت الدخول هو وقتنا الحالي
        const assumedEntryTime = Math.floor(Date.now() / 1000); 
        // 🔴🔴🔴 التعديل هنا: تحديد وقت الانتهاء ليكون عند الثانية 0 من الدقيقة التالية 🔴🔴🔴
        const entryDate = new Date(assumedEntryTime * 1000);
        entryDate.setSeconds(0, 0); // نضبط الثواني إلى 0
        entryDate.setMinutes(entryDate.getMinutes() + 1); // ونزيد الدقيقة بواحد
        const assumedExpiryTime = Math.floor(entryDate.getTime() / 1000);
        // 🔴🔴🔴 نهاية التعديل 🔴🔴🔴

        if (assumedEntrySpot === null || isNaN(assumedEntrySpot)) {
            console.error(`[Chat ID: ${chatId}] ❌ لا يمكن الدخول في الصفقة: لم يتم استقبال أي تيك بعد أو قيمة التيك غير صالحة.`);
            bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: لم يتم استقبال أي تيك بعد. الرجاء الانتظار حتى يصل أول تيك.`);
            config.tradingCycleActive = false; // إلغاء دورة التداول للبدء من جديد
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            saveUserStates();
            return;
        }

        // تخزين تفاصيل العقد المفتوح حالياً باستخدام القيم المفترضة
        config.currentOpenContract = {
            id: null, // ID العقد سيأتي من Deriv لاحقاً
            entrySpot: assumedEntrySpot, // سعر الدخول المفترض
            entryTime: assumedEntryTime, // وقت الدخول المفترض
            type: direction, // نوع العقد
            expiryTime: assumedExpiryTime, // وقت الانتهاء المحسوب
            longcode: null // سيتم تحديثه لاحقاً
        };
        saveUserStates();

        // 🟢🔴 DEBUG: تأكيد القيم المفترضة قبل إرسال طلب الشراء 🔴🟢
        console.log(`[Chat ID: ${chatId}] DEBUG: قيم الصفقة المفترضة: Entry: ${assumedEntrySpot.toFixed(3)}, Time: ${new Date(assumedEntryTime * 1000).toLocaleTimeString()}, Expiry: ${new Date(assumedExpiryTime * 1000).toLocaleTimeString()}`);
        // 🔴🔴🔴 نهاية الكود الجديد 🔴🔴🔴

        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake,
            "basis": "stake",
            "contract_type": direction, // 'CALL' (صعود) أو 'PUT' (هبوط)
            "currency": "USD",
            "duration": 58,
            "duration_unit": "s", // 1 دقيقة
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


    config.currentOpenContract = null; 
    config.predictionCheckTimer = null; 
    config.lastReceivedTickPrice = null;
    config.candle15MinOpenPrice = null;
    config.lastProcessed15MinIntervalStart = null;
    config.waitingForNextTrade = false;
    config.waitingForCandleClose = false;

    ws.on('open', () => {
        console.log(`[Chat ID: ${chatId}] ✅ تم الاتصال بـ Deriv. جاري المصادقة...`);
        bot.sendMessage(chatId, '✅ تم الاتصال بـ Deriv. جاري المصادقة...');
        ws.send(JSON.stringify({ authorize: config.token }));
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);
        const currentChatId = chatId;

        // 🟢🟢🟢 DEBUG: سجل نوع الرسالة الواردة (تم تفعيله لأغراض التصحيح) 🟢🟢🟢


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
          config.lastReceivedTickPrice = currentTickPrice; 
          if (config.running && !config.tradingCycleActive) { 
            const current15MinIntervalStartMinute = Math.floor(currentMinute / 15) * 15; 
            if (currentSecond === 0 && currentMinute === current15MinIntervalStartMinute) { 
              if (config.lastProcessed15MinIntervalStart !== current15MinIntervalStartMinute) { 
                config.candle15MinOpenPrice = config.candleClosePrice || currentTickPrice;
                config.lastProcessed15MinIntervalStart = current15MinIntervalStartMinute; 
                config.waitingForCandleClose = true; 
                config.candleStartTime = tickEpoch; 
                saveUserStates(); 
                console.log(`[Chat ID: ${currentChatId}] تم تسجيل سعر الافتتاح للشمعة 15 دقيقة: ${config.candle15MinOpenPrice.toFixed(3)}`); 
                bot.sendMessage(currentChatId, `⏳ جاري تحليل شمعة 15 دقيقة. تسجيل سعر الافتتاح: ${config.candle15MinOpenPrice.toFixed(3)}`); 
              } 
            } 
            if (currentMinute % 15 === 14 && currentSecond >= 58 && config.waitingForCandleClose === true) { 
              const candleClosePrice = currentTickPrice; 
              config.candleClosePrice = candleClosePrice;
              let tradeDirection = 'none'; 
              if (candleClosePrice < config.candle15MinOpenPrice) { 
                tradeDirection = 'CALL'; 
              } else if (candleClosePrice > config.candle15MinOpenPrice) { 
                tradeDirection = 'PUT'; 
              } else { 
                tradeDirection = 'none'; 
              } 
              console.log(`[Chat ID: ${currentChatId}] سعر الافتتاح: ${config.candle15MinOpenPrice.toFixed(3)}, سعر الإغلاق: ${candleClosePrice.toFixed(3)}. الاتجاه: ${tradeDirection}`); 
              bot.sendMessage(currentChatId, `📊 تحليل الشمعة 15 دقيقة:\nسعر الافتتاح: ${config.candle15MinOpenPrice.toFixed(3)}\nسعر الإغلاق: ${candleClosePrice.toFixed(3)}\nالاتجاه المتوقع: ${tradeDirection}`); 
              if (tradeDirection !== 'none' && !config.tradingCycleActive) { 
                setTimeout(async function() { 
                  config.baseTradeDirection = tradeDirection; 
                  config.nextTradeDirection = tradeDirection; 
                  config.currentOpenContract = true; 
                  config.tradingCycleActive = true; 
                  saveUserStates(); 
                  console.log(`[Chat ID: ${currentChatId}] DEBUG: جاري الدخول في صفقة ${config.nextTradeDirection} بمبلغ ${config.currentStake.toFixed(2)}.`);
                  await enterTrade(config, config.nextTradeDirection, currentChatId, ws); 
                }, 2000); 
              } else if (tradeDirection === 'none') { 
                console.log(`[Chat ID: ${currentChatId}] ↔ لا يوجد تغيير في الشمعة. لا دخول في صفقة.`); 
                bot.sendMessage(currentChatId, `↔ لا يوجد تغيير في الشمعة. لا دخول في صفقة.`); 
                config.currentStake = config.stake; 
                config.currentTradeCountInCycle = 0; 
                config.tradingCycleActive = false; 
                config.baseTradeDirection = null; 
                config.nextTradeDirection = null; 
                saveUserStates(); 
              } 
              config.waitingForCandleClose = false; 
              config.lastProcessed15MinIntervalStart = null; 
              config.candleStartTime = null; 
              saveUserStates(); 
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

            // 🔴🔴🔴 هذا هو الكود الجديد هنا 🔴🔴🔴
            if (config.currentOpenContract) {
                config.currentOpenContract.id = proposalId; // تخزين الـ ID المؤقت (proposal_id)
                saveUserStates();
            }
            // 🔴🔴🔴 نهاية الكود الجديد 🔴🔴🔴

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
                    // 🔴🔴🔴 هذا هو الكود الجديد هنا (تم حذف الكود القديم المتعلق بـ spot_price/spot_time) 🔴🔴🔴
                    // لم نعد نعتمد على spot_price و spot_time من رسالة buy
                    // سنستخدم القيم المخزنة مسبقاً في config.currentOpenContract
                    // ولكن نحدث الـ contractId والـ longcode من رسالة buy إذا كانت متوفرة
                    const contractId = msg.buy.contract_id;
                    const longcode = msg.buy.longcode;

                    if (config.currentOpenContract) {
                        config.currentOpenContract.id = contractId; // تحديث الـ ID النهائي
                        config.currentOpenContract.longcode = longcode; // تحديث الـ longcode
                        saveUserStates();

                        const contract = config.currentOpenContract; // الآن contract تحتوي على entrySpot و expiryTime الصحيحة من التخزين المحلي

                        console.log(`[Chat ID: ${currentChatId}] 📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contract.id}, Entry: ${contract.entrySpot.toFixed(3)}, Expiry Time (Target): ${new Date(contract.expiryTime * 1000).toLocaleTimeString()}`);
                        bot.sendMessage(currentChatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contract.id}\nسعر الدخول: ${contract.entrySpot.toFixed(3)}\nينتهي في: ${new Date(contract.expiryTime * 1000).toLocaleTimeString()}`);

                        // 🟢🟢🟢 جدولة التحقق من النتيجة باستخدام القيم المخزنة محلياً 🟢🟢🟢
                        if (config.predictionCheckTimer) {
                            clearTimeout(config.predictionCheckTimer);
                            config.predictionCheckTimer = null;
                        }

                        // حساب الوقت المتبقي لانتهاء الصفقة ليتم الفحص
                        const timeToPredictSec = contract.expiryTime - Math.floor(Date.now() / 1000);

                        if (timeToPredictSec > 0) {
                            console.log(`[Chat ID: ${currentChatId}] جاري جدولة فحص النتيجة (بعد ${timeToPredictSec} ثواني) باستخدام التيك المحلي الأخير.`);
                            config.predictionCheckTimer = setTimeout(async () => {
                                if (config.running && config.currentOpenContract && config.lastReceivedTickPrice !== null) {
                                    console.log(`[Chat ID: ${currentChatId}] 🧠 وصل المؤقت، جاري فحص النتيجة باستخدام التيك المحلي الأخير: ${config.lastReceivedTickPrice.toFixed(3)}`);
                                    bot.sendMessage(currentChatId, `🧠 جاري فحص نتيجة الصفقة...`);

                                    const latestTickPrice = config.lastReceivedTickPrice;
                                    const contractToCheck = config.currentOpenContract; // استخدام العقد المخزن

                                    let isWin = false;
                                    let profit = 0;

                                    if (isNaN(contractToCheck.entrySpot) || contractToCheck.entrySpot === null) {
                                        console.error(`[Chat ID: ${currentChatId}] ❌ خطأ: contract.entrySpot غير صالح عند فحص النتيجة! القيمة: ${contractToCheck.entrySpot}`);
                                        bot.sendMessage(currentChatId, `❌ خطأ داخلي: لا يمكن تحديد نتيجة الصفقة (سعر الدخول غير معروف).`);
                                        handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, internal_error: true });
                                        return;
                                    }

                                    if (contractToCheck.type === 'CALL') {
                                        isWin = latestTickPrice > contractToCheck.entrySpot;
                                    } else if (contractToCheck.type === 'PUT') {
                                        isWin = latestTickPrice < contractToCheck.entrySpot;
                                    }

                                    if (isWin) {
                                        profit = config.currentStake * 0.89;
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
                    } else {
                        console.error(`[Chat ID: ${currentChatId}] ❌ خطأ: config.currentOpenContract غير موجود بعد تلقي رسالة الشراء!`);
                        bot.sendMessage(currentChatId, `❌ خطأ داخلي: فشل في تتبع الصفقة. جاري معالجة كخسارة.`);
                        handleTradeResult(currentChatId, config, ws, { profit: -config.currentStake, win: false, internal_error: true });
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



                messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى ${config.currentStake.toFixed(2)}. الصفقة التالية ستكون "${config.nextTradeDirection}".`;
                console.log(`[Chat ID: ${currentChatId}] ❌ خسارة. جاري المضاعفة. الصفقة التالية: ${config.nextTradeDirection}`);
                bot.sendMessage(currentChatId, messageText);

                config.currentOpenContract = null;
               if (config.running) {
                    enterTrade(config, config.nextTradeDirection, currentChatId, ws);
                }
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
        candle15MinOpenPrice: null,
        lastProcessed15MinIntervalStart: null,
        waitingForCandleClose: false,
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
        lastReceivedTickPrice: null,
        candle15MinOpenPrice: null,
        waitingForCandleClose: false,
        lastProcessed15MinIntervalStart: null,
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
        state.candle15MinOpenPrice = null;
        state.lastProcessed15MinIntervalStart = null;
        state.waitingForCandleClose = false;
        state.currentTradeCountInCycle = 0;
        state.profit = 0;
        state.win = 0;
        state.loss = 0;
        state.currentStake = state.stake;
        state.baseTradeDirection = null;
        state.nextTradeDirection = null;
        state.lastReceivedTickPrice = null;
        state.waitingForNextTrade = false;

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
    user.waitingForCandleClose = false;
    user.candle15MinOpenPrice = null;
    user.lastProcessed15MinIntervalStart = null;
    user.profit = 0;
    user.win = 0;
    user.loss = 0;
    user.baseTradeDirection = null;
    user.nextTradeDirection = null;
    user.lastReceivedTickPrice = null;
    user.waitingForNextTrade = false;

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
