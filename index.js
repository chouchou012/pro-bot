const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs'); // لإدارة حفظ وتحميل الحالة
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('✅ Deriv bot is running'));
app.listen(3000, () => console.log('🌐 UptimeRobot is connected on port 3000'));


// 2. المتغيرات العامة والثوابت
// *تحذير: لا يوصى بهذا في بيئة الإنتاج لأسباب أمنية.*
const DERIV_APP_ID = '22168'; // !!! تأكد من أن هذا هو معرف تطبيقك الفعلي من Deriv !!!
const TELEGRAM_BOT_TOKEN = '8021935025:AAHgxw8_cr1EsXKlRb_EYOeCxItPN8ELLBM'; // !!! استبدل هذا بتوكن بوت تلغرام الخاص بك !!!
const DERIV_API_URL = `wss://green.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;

const USER_DATA_FILE = 'user_data.json';
const ACCESS_LIST_FILE = 'access_list.json'; // إضافة ثابت لاسم ملف قائمة الوصول
const TRADE_DURATION_SECONDS = 294; // مدة الصفقة (حوالي 4 دقائق و 54 ثانية)
const MARTINGALE_FACTOR = 2.2;
const MAX_MARTINGALE_LOSSES = 7; // الحد الأقصى للمضاعفات (كان 7 في كودك)
const WIN_PERCENTAGE = 0.88; // 88% نسبة الربح

// كائنات الحالة والاتصالات
let userStates = {};
let userDerivConnections = {}; // لتخزين اتصال WebSocket لكل مستخدم

// 3. وظائف مساعدة لحفظ وتحميل حالة المستخدمين
function saveUserStates() {
    try {
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userStates, null, 2), 'utf8');
        // console.log('User states saved successfully.');
    } catch (error) {
        console.error('Error saving user states:', error.message);
    }
}

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

    console.log(`[Chat ID: ${chatId}] جاري محاولة إعادة الاتصال بـ Deriv في 2 ثوانٍ...`); // تم تعديل الوقت إلى 2 ثانية
    bot.sendMessage(chatId, '🔄 جاري محاولة إعادة الاتصال بـ Deriv...');

    // مسح أي اتصال سابق
    if (userDerivConnections[chatId]) {
        if (userDerivConnections[chatId].readyState !== WebSocket.CLOSED) {
            userDerivConnections[chatId].close();
        }
        delete userDerivConnections[chatId];
    }

    // مسح مؤقت الصفقة عند إعادة الاتصال لمنع تشغيله إذا كان هناك مؤقت معلق
    if (config.currentTrade && config.currentTrade.timeoutId) {
        clearTimeout(config.currentTrade.timeoutId);
        config.currentTrade.timeoutId = null;
    }

    setTimeout(() => {
        if (config.running) {
            startBotForUser(chatId, config);
        } else {
            console.log(`[Chat ID: ${chatId}] البوت توقف أثناء فترة انتظار إعادة الاتصال.`);
        }
    }, 2000); // 2 ثوانٍ
}

// دالة لإرسال طلب دخول الصفقة
async function enterTrade(config, direction, chatId, ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const formattedStake = parseFloat(config.currentStake.toFixed(2));
        bot.sendMessage(chatId, `⏳ جاري إرسال اقتراح لصفقة ${direction === 'CALL' ? 'صعود' : 'هبوط'} بمبلغ ${formattedStake.toFixed(2)}$ ...`);
        ws.send(JSON.stringify({
            "proposal": 1,
            "amount": formattedStake,
            "basis": "stake",
            "contract_type": direction, // 'CALL' (صعود) أو 'PUT' (هبوط)
            "currency": "USD",
            "duration": TRADE_DURATION_SECONDS, // استخدام الثابت
            "duration_unit": "s",
            "symbol": "R_50"
        }));
    } else {
        bot.sendMessage(chatId, `❌ لا يمكن الدخول في الصفقة: الاتصال بـ Deriv غير نشط. يرجى إعادة تشغيل البوت إذا استمرت المشكلة.`);
        console.error(`[Chat ID: ${chatId}] لا يمكن الدخول في الصفقة: اتصال WebSocket بـ Deriv غير نشط.`);
    }
}

// 5. دالة المصادقة والحصول على الرصيد
async function authenticateAndGetBalance(chatId) {
    return new Promise((resolve) => {
        const tempWs = new WebSocket(DERIV_API_URL);
        let authHandled = false;

        tempWs.onopen = () => {
            console.log(`[Chat ID: ${chatId}] Temporary connection for authentication opened.`);
            tempWs.send(JSON.stringify({ "authorize": userStates[chatId].token }));
        };

        tempWs.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.msg_type === 'authorize') {
                authHandled = true;
                if (data.authorize) {
                    bot.sendMessage(chatId, `✅ تم التحقق من حسابك!`);
                    tempWs.send(JSON.stringify({ "balance": 1 }));
                } else {
                    console.error(`[Chat ID: ${chatId}] Authentication failed during balance check:, data.error.message`);
                    bot.sendMessage(chatId, `⚠ فشل التحقق من الحساب: ${data.error.message}`);
                    tempWs.close();
                    resolve(false);
                }
            } else if (data.msg_type === 'balance') {
                if (data.balance) {
                    const balance = parseFloat(data.balance.balance).toFixed(2);
                    const currency = data.balance.currency;
                    bot.sendMessage(chatId, `💰 رصيدك الحالي: ${balance} ${currency}`);
                    tempWs.close();
                    resolve(true);
                } else if (data.error) {
                    console.error(`[Chat ID: ${chatId}] Failed to get balance:, data.error.message`);
                    bot.sendMessage(chatId, `⚠ فشل الحصول على الرصيد: ${data.error.message}`);
                    tempWs.close();
                    resolve(false);
                }
            }
        };

        tempWs.onerror = (error) => {
            console.error(`[Chat ID: ${chatId}] Temporary WebSocket error during auth:, error.message`);
            bot.sendMessage(chatId, `⚠ خطأ في الاتصال أثناء التحقق: ${error.message}`);
            tempWs.close();
            resolve(false);
        };

        tempWs.onclose = () => {
            console.log(`[Chat ID: ${chatId}] Temporary connection closed.`);
            if (!authHandled) { // إذا تم إغلاق الاتصال قبل المصادقة
                resolve(false);
            }
        };

        setTimeout(() => {
            if (tempWs.readyState === WebSocket.OPEN) {
                tempWs.close();
                console.log(`[Chat ID: ${chatId}] Temporary authentication connection timed out.`);
                resolve(false);
            }
        }, 10000); // 10 ثواني مهلة
    });
}

// دالة رئيسية لبدء تشغيل البوت لكل مستخدم والتعامل مع رسائل Deriv
function startBotForUser(chatId, config) {
    if (userDerivConnections[chatId]) {
        if (userDerivConnections[chatId].readyState !== WebSocket.CLOSED) {
            userDerivConnections[chatId].close();
        }
        delete userDerivConnections[chatId];
    }

    const ws = new WebSocket(DERIV_API_URL);
    userDerivConnections[chatId] = ws;

    ws.onopen = () => {
        console.log(`[Chat ID: ${chatId}] Connected to Deriv API.`);
        bot.sendMessage(chatId, "🔗 تم الاتصال بـ Deriv API.");
        ws.send(JSON.stringify({ authorize: config.token }));
    };

    ws.onmessage = async (data) => {
        const msg = JSON.parse(data);
        //console.log([Chat ID: ${chatId}] RECEIVED MSG TYPE: ${msg.msg_type});

        if (!config.running && ws.readyState === WebSocket.OPEN) {
            console.log(`[Chat ID: ${chatId}] البوت متوقف، جاري إغلاق اتصال Deriv.`);
            ws.close();
            bot.sendMessage(chatId, '🛑 تم إغلاق اتصال Deriv.');
            return;
        }

        if (msg.msg_type === 'authorize') {
            if (msg.error) {
                console.error(`[Chat ID: ${chatId}] Authorization failed: ${msg.error.message}`);
                bot.sendMessage(chatId, `⚠ فشل الترخيص: ${msg.error.message}. يرجى التحقق من رمز API وإعادة تشغيل البوت.`);
                config.running = false;
                saveUserStates();
                ws.close();
            } else {
                console.log(`[Chat ID: ${chatId}] Authorized successfully!`);
                bot.sendMessage(chatId, "✅ تم الترخيص بنجاح! البوت جاهز للتداول.");

                // *منطق استئناف الصفقة عند إعادة الاتصال*
                if (config.currentTrade && config.currentTrade.contractId) {
                    console.log(`[Chat ID: ${chatId}] Found existing trade ${config.currentTrade.contractId}. Requesting contract details.`);
                    bot.sendMessage(chatId, `🔍 تم العثور على صفقة سابقة (ID: ${config.currentTrade.contractId}). جارٍ التحقق من حالتها...`);
                    // طلب معلومات العقد المفتوح لتأكيد حالته
                    ws.send(JSON.stringify({ "proposal_open_contract": 1, "contract_id": config.currentTrade.contractId, "subscribe": 1 }));
                } else {
                    console.log(`[Chat ID: ${chatId}] No active trade found or contractId is missing. Starting new trading cycle.`);
                    startTradingCycle(chatId, config, ws);
                }
                // الاشتراك في التكات يحدث دائماً
                ws.send(JSON.stringify({ "ticks": "R_50", "subscribe": 1 }));
                bot.sendMessage(chatId, "📈 جارٍ الاشتراك في تكات زوج R_50.");
            }
        }
        else if (msg.msg_type === 'tick' && msg.tick) {
            config.lastReceivedTickPrice = parseFloat(msg.tick.quote);
            // فقط قم بمعالجة التك إذا لم يكن هناك صفقة نشطة نراقبها بالفعل
            // منطق تحديد النتيجة يتم عبر المؤقت
            if (!config.currentTrade) {
                processTick(chatId, config, ws, msg.tick);
            }
        }
        else if (msg.msg_type === 'proposal') {
            if (msg.error) {
                console.error(`[Chat ID: ${chatId}] Proposal failed: ${msg.error.message}`);
                bot.sendMessage(chatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}.`);
                config.tradingCycleActive = false; // يمكن إعادة المحاولة في الدورة التالية
                config.currentStake = config.stake; // العودة للستيك الأصلي لأن الصفقة لم تتم
                config.currentTradeCountInCycle = 0; // إعادة تعيين مارتينغال
                saveUserStates();
                bot.sendMessage(chatId, `⚠ فشل الاقتراح. البوت جاهز لدورة تداول جديدة.`);
            } else {
                const proposalId = msg.proposal.id;
                const askPrice = msg.proposal.ask_price;
                bot.sendMessage(chatId, `✅ تم الاقتراح: السعر المطلوب ${askPrice.toFixed(2)}$. جاري الشراء...`);
                ws.send(JSON.stringify({ "buy": proposalId, "price": askPrice }));
            }
        }
        else if (msg.msg_type === 'buy') {
            if (msg.error) {
                console.error(`[Chat ID: ${chatId}] Buy order failed: ${msg.error.message}`);
                bot.sendMessage(chatId, `❌ فشل شراء الصفقة: ${msg.error.message}.`);
                // اعتبارها خسارة لغرض المضاعفة
                config.loss++;
                config.currentTradeCountInCycle++;
                handleTradeResult(chatId, config, ws, false); // تمرير false للإشارة إلى الخسارة
            } else {
                const contractId = msg.buy.contract_id;
                const entrySpot = config.lastReceivedTickPrice; // نعتمد على آخر تيك تلقيناه
                const entryTime = Date.now(); // وقت الدخول الفعلي بالمللي ثانية

                // تحديث currentTrade في userStates
                config.currentTrade = {
                    entryPrice: entrySpot,
                    tradeType: config.nextTradeDirection, // الاتجاه الذي قررنا الدخول فيه
                    startTime: entryTime,
                    symbol: "R_50", // يجب أن يكون ثابتاً
                    stake: config.currentStake,
                    contractId: contractId,
                    timeoutId: null // لإلغاء المؤقت لاحقاً
                };
                saveUserStates();

                bot.sendMessage(chatId, `📥 تم الدخول صفقة بمبلغ ${config.currentStake.toFixed(2)}$ Contract ID: ${contractId}\nسعر الدخول: ${entrySpot.toFixed(3)}\nينتهي في: ${new Date(entryTime + TRADE_DURATION_SECONDS * 1000).toLocaleTimeString()}`);
                console.log(`[Chat ID: ${chatId}] Trade entered. Setting ${TRADE_DURATION_SECONDS}s timer.`);

                // ضبط المؤقت لتحديد نتيجة الصفقة بعد 294 ثانية
                if (config.currentTrade.timeoutId) {
                    clearTimeout(config.currentTrade.timeoutId);
                }
                config.currentTrade.timeoutId = setTimeout(() => {
                    if (config.running && config.currentTrade && config.currentTrade.contractId === contractId) {
                        determineTradeOutcome(chatId, config, ws);
                    } else {
                        console.log(`[Chat ID: ${chatId}] Trade outcome check aborted for ${contractId}. Bot stopped or trade cleared.`);
                    }
                }, TRADE_DURATION_SECONDS * 1000);
            }
        }
        else if (msg.msg_type === 'proposal_open_contract') {
            const contract = msg.proposal_open_contract;
            if (contract) {
                if (contract.is_sold) {
                    console.log(`[Chat ID: ${chatId}] Contract ${contract.contract_id} was already sold. Deriv status: ${contract.status}`);
                    bot.sendMessage(chatId, `ℹ الصفقة السابقة (ID: ${contract.contract_id}) تم إغلاقها بالفعل من Deriv.\nالنتيجة من Deriv: ${contract.status === 'won' ? 'ربح' : 'خسارة'}. الربح/الخسارة: ${parseFloat(contract.profit).toFixed(2)}`);

                    // إذا كانت الصفقة قد تم بيعها بالفعل، فإن منطق المؤقت لدينا يجب أن يكون قد عمل.
                    // إذا لم يعمل، هذا يعني أن الانقطاع كان طويلاً وفوت المؤقت.
                    // في هذه الحالة، نعتبرها منتهية ونبدأ دورة جديدة.
                    if (config.currentTrade && config.currentTrade.contractId === contract.contract_id && config.currentTrade.timeoutId) {
                        clearTimeout(config.currentTrade.timeoutId); // نوقف المؤقت المحلي إذا كان لا يزال يعمل
                        config.currentTrade.timeoutId = null;
                    }
                    config.currentTrade = null; // مسح الصفقة بعد تحديد نتيجتها
                    saveUserStates();
                    startTradingCycle(chatId, config, ws); // ابدأ دورة تداول جديدة

                } else {
                    // العقد لا يزال مفتوحًا
                    console.log(`[Chat ID: ${chatId}] Contract ${contract.contract_id} is still open.`);
                    bot.sendMessage(chatId, `ℹ الصفقة السابقة (ID: ${contract.contract_id}) لا تزال مفتوحة.\nوقت الانتهاء المقدر: ${new Date(contract.date_expiry * 1000).toLocaleTimeString()}`);

                    // تحديث currentTrade بناءً على معلومات Deriv للحفاظ على الدقة
                    config.currentTrade = {
                        entryPrice: parseFloat(contract.entry_spot),
                        tradeType: contract.contract_type === 'CALL' ? 'CALL' : 'PUT',
                        startTime: contract.date_start * 1000, // وقت البدء بالمللي ثانية
                        symbol: contract.symbol,
                        stake: parseFloat(contract.buy_price),
                        contractId: contract.contract_id,
                        timeoutId: null
                    };
                    saveUserStates();

                    // إعادة ضبط المؤقت للصفقة المفتوحة
                    const timeElapsed = (Date.now() - config.currentTrade.startTime) / 1000;
                    const timeLeft = TRADE_DURATION_SECONDS - timeElapsed;

                    if (timeLeft > 0) {
                        console.log(`[Chat ID: ${chatId}] Resuming trade timer for ${timeLeft.toFixed(1)}s`);
                        if (config.currentTrade.timeoutId) {
                            clearTimeout(config.currentTrade.timeoutId);
                        }
                        config.currentTrade.timeoutId = setTimeout(() => {
                            if (config.running && config.currentTrade && config.currentTrade.contractId === contract.contract_id) {
                                determineTradeOutcome(chatId, config, ws);
                            } else {
                                console.log(`[Chat ID: ${chatId}] Trade outcome check aborted for ${contract.contract_id}.`);
                            }
                        }, timeLeft * 1000);
                    } else {
                        console.log(`[Chat ID: ${chatId}] Previous trade ${contract.contract_id} already expired. Determining outcome now.`);
                        bot.sendMessage(chatId, "⚠ الصفقة السابقة انتهت أثناء الانقطاع. تحديد النتيجة...");
                        determineTradeOutcome(chatId, config, ws); // تحديد النتيجة فورا
                    }
                    // بعد معالجة الصفقة القديمة (سواء كانت لا تزال مفتوحة أو انتهت أثناء الانقطاع)،
                    // نبدأ دورة تداول جديدة (مراقبة شروط الدخول لصفقة جديدة).
                    startTradingCycle(chatId, config, ws);
                }
            } else if (msg.error && msg.error.code === 'InvalidContractID') {
                console.error(`[Chat ID: ${chatId}] Error getting open contract: ${msg.error.message}. Contract might be invalid or expired.`);
                bot.sendMessage(chatId, `❌ خطأ: الصفقة السابقة غير صالحة أو انتهت. ${msg.error.message}.`);
                config.currentTrade = null; // اعتبر الصفقة غير صالحة وامسحها
                saveUserStates();
                startTradingCycle(chatId, config, ws); // ابدأ دورة تداول جديدة
            } else if (msg.error) {
                console.error(`[Chat ID: ${chatId}] General error getting open contract: ${msg.error.message}`);
                bot.sendMessage(chatId, `❌ خطأ عام في استرداد الصفقة المفتوحة: ${msg.error.message}.`);
                config.currentTrade = null;
                saveUserStates();
                startTradingCycle(chatId, config, ws);
            }
        }
        else if (msg.msg_type === 'error') {
            console.error(`[Chat ID: ${chatId}] Deriv API error: ${msg.error.message}`);
            bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
            // هنا يجب إعادة ضبط دورة التداول لتجنب حلقة لا نهائية من الأخطاء
            config.tradingCycleActive = false;
            config.currentStake = config.stake;
            config.currentTradeCountInCycle = 0;
            if (config.currentTrade && config.currentTrade.timeoutId) {
                clearTimeout(config.currentTrade.timeoutId);
                config.currentTrade.timeoutId = null;
            }
            config.currentTrade = null; // مسح الصفقة النشطة عند خطأ API
            saveUserStates();
            // بعد الخطأ، نحاول بدء دورة جديدة إذا كان البوت لا يزال يعمل
            if (config.running) {
                startTradingCycle(chatId, config, ws);
            }
        }
    };

    ws.onclose = (event) => {
        console.log(`[Chat ID: ${chatId}] Deriv WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason || 'No specific reason'}`);
        if (config.running) {
            bot.sendMessage(chatId, `⚠ تم قطع الاتصال بـ Deriv. سأحاول إعادة الاتصال...`);
            reconnectDeriv(chatId, config);
        } else {
            delete userDerivConnections[chatId];
            saveUserStates();
        }
    };

    ws.on('error', (error) => {
        console.error(`[Chat ID: ${chatId}] Deriv WebSocket error: ${error.message}`);
        bot.sendMessage(chatId, `❌ خطأ في اتصال Deriv: ${error.message}.`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });
} // نهاية دالة startBotForUser


// 6. منطق التداول الأساسي (Strategy Logic)
const CANDLE_INTERVAL_MS = 5 * 60 * 1000; // 5 دقائق بالمللي ثانية

// وظيفة لمعالجة كل تك
function processTick(chatId, config, ws, tick) {
    config.lastReceivedTickPrice = parseFloat(tick.quote);

    // لا ندخل في شروط الدخول إذا كان هناك صفقة قيد التنفيذ نراقبها
    // منطق تحديد النتيجة يتم تشغيله بواسطة المؤقت
    if (config.currentTrade && config.currentTrade.contractId) {
        return;
    }

    // قم بفحص شروط الدخول عندما لا تكون هناك صفقة قيد التنفيذ
    checkEntryConditions(chatId, config, ws, tick);
}

// وظيفة للتحقق من شروط الدخول في الصفقة (تعتمد على استراتيجيتك)
function checkEntryConditions(chatId, config, ws, currentTick) {
    // 1. المتطلبات الأساسية: التأكد من أن البوت يعمل، لا توجد صفقة حالية، ولم يتم بدء صفقة لهذه الدورة بعد.
    if (!config.running || config.currentTrade || config.tradingCycleActive) {
        return;
    }

    const currentTimestamp = Date.now();
    const fiveMinCandleBoundary = Math.floor(currentTimestamp / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;

    // 2. اكتشاف بداية شمعة 5 دقائق جديدة وتحديث سعر فتحها
    if (fiveMinCandleBoundary > config.lastProcessed5MinIntervalStart) {
        // هذه هي بداية فترة شمعة 5 دقائق جديدة للتحليل
        config.candle5MinOpenPrice = currentTick.quote; // تعيين سعر الفتح للشمعة الجديدة
        config.lastProcessed5MinIntervalStart = fiveMinCandleBoundary;
        console.log(`[Chat ID: ${chatId}] بدأت شمعة 5 دقائق جديدة. سعر الفتح للتحليل: ${config.candle5MinOpenPrice}`);
        bot.sendMessage(chatId, `📊 بدأت شمعة 5 دقائق جديدة. سعر الفتح: ${config.candle5MinOpenPrice}`);
        saveUserStates();
        // هنا يمكنك إعادة تعيين أي متغيرات تحليل أخرى خاصة بالشمعة إذا لزم الأمر
    }

    // 3. تطبيق منطق استراتيجية الدخول الأساسي (مكان لوضع استراتيجيتك الحقيقية)
    // هذا الجزء يعمل على كل تيك طالما أن الشروط 1 و 2 مستوفاة
    // (أي لا توجد صفقة نشطة ولم يتم الدخول في صفقة بعد في دورة شمعة الـ 5 دقائق الحالية).
    // هنا يجب عليك تنفيذ منطق التحليل الفعلي الخاص بك والذي يمتد على مدار شمعة الـ 5 دقائق بأكملها.

    // ** استبدل منطق Placeholder هذا باستراتيجية تحليل شمعة الـ 5 دقائق الفعلية الخاصة بك **
    // مثال: إذا (تجاوز سعر التك الحالي متوسطاً متحركاً معيناً، أو تشكل نمط معين)
    // أو إذا (كان السعر الحالي أعلى بكثير من سعر فتح الشمعة (لـ CALL) أو أقل بكثير (لـ PUT))

    // هذا المنطق الافتراضي سيضع صفقة (عشوائية) بمجرد أن يصبح البوت حراً وجاهزاً في شمعة جديدة.
    const tradeDirection = (currentTick.quote * 1000 % 2 === 0) ? 'CALL' : 'PUT'; // Placeholder: CALL/PUT عشوائي

    // هذا السطر يضمن أن البوت سيحاول وضع الصفقة بمجرد أن يتم استيفاء الشروط.
    // يجب أن تحيط هذا السطر بمنطق استراتيجيتك الفعلي:
    config.nextTradeDirection = tradeDirection; // تحديد الاتجاه (Placeholder)
    config.tradingCycleActive = true; // تفعيل دورة التداول لمنع الدخول المتكرر في نفس الدورة
    saveUserStates();
    enterTrade(config, config.nextTradeDirection, chatId, ws); // استدعاء enterTrade مباشرة
    bot.sendMessage(chatId, `📊 البوت يحلل شمعة الـ 5 دقائق. تم اتخاذ قرار (مؤقت) للدخول في صفقة ${config.nextTradeDirection === 'CALL' ? 'صعود' : 'هبوط'}.`);
}


// وظيفة لتحديد نتيجة الصفقة (داخليًا)
function determineTradeOutcome(chatId, config, ws) {
    if (!config.currentTrade) {
        console.warn(`[Chat ID: ${chatId}] determineTradeOutcome called but no currentTrade found.`);
        return;
    }

    let isWin = false;
    const { entryPrice, tradeType, stake, contractId, startTime } = config.currentTrade;
    const closingPrice = config.lastReceivedTickPrice; // نستخدم آخر تيك تم استلامه

    if (closingPrice === null || isNaN(closingPrice)) {
        console.error(`[Chat ID: ${chatId}] Cannot determine outcome for ${contractId}: No closing price available. Marking as loss.`);
        bot.sendMessage(chatId, `❌ لم نتمكن من تحديد نتيجة الصفقة (ID: ${contractId}) بسبب عدم توفر سعر الإغلاق. سيتم اعتبارها خسارة.`);
        handleTradeResult(chatId, config, ws, false);
        return;
    }

    console.log(`[Chat ID: ${chatId}] Determining outcome for ${contractId}. Entry: ${entryPrice.toFixed(3)}, Close: ${closingPrice.toFixed(3)}, Type: ${tradeType}`);

    if (tradeType === 'CALL') { // Rise (صعود)
        isWin = closingPrice > entryPrice;
    } else if (tradeType === 'PUT') { // Fall (هبوط)
        isWin = closingPrice < entryPrice;
    } else {
        // حالة غير متوقعة لـ tradeType
        console.error(`[Chat ID: ${chatId}] Unknown trade type: ${tradeType}. Marking as loss.`);
        isWin = false;
    }

    let profitOrLoss = 0;
    if (isWin) {
        profitOrLoss = stake * WIN_PERCENTAGE; // الربح 88% من الاستيك
    } else {
        profitOrLoss = -stake; // الخسارة هي كامل الاستيك
    }

    config.profit += profitOrLoss; // تحديث إجمالي الربح/الخسارة

    bot.sendMessage(chatId, `📊 نتيجة الصفقة (ID: ${contractId}):\nنوع الصفقة: ${tradeType === 'CALL' ? 'صعود' : 'هبوط'}\nسعر الدخول: ${entryPrice.toFixed(3)}\nسعر الإغلاق: ${closingPrice.toFixed(3)}\nالربح/الخسارة: ${profitOrLoss.toFixed(2)} USD\n\nإجمالي الربح/الخسارة: ${config.profit.toFixed(2)} USD`);

    handleTradeResult(chatId, config, ws, isWin);
}

// وظيفة لمعالجة نتيجة الصفقة (ربح/خسارة)
function handleTradeResult(chatId, config, ws, isWin) {
    let message = '';

    // مسح المؤقت الخاص بالصفقة الحالية وتفاصيلها
    if (config.currentTrade && config.currentTrade.timeoutId) {
        clearTimeout(config.currentTrade.timeoutId);
        config.currentTrade.timeoutId = null;
    }
    config.currentTrade = null; // مسح تفاصيل الصفقة بعد معالجة نتيجتها
    config.tradingCycleActive = false; // إعادة تعيين لتمكين دخول صفقة جديدة بعد انتهاء الصفقة

    if (isWin) {
        config.win++;
        config.currentTradeCountInCycle = 0; // إعادة تعيين عداد الخسائر المتتالية عند الربح
        config.currentStake = config.stake; // العودة إلى الـ stake الأولي
        message = `✅ ربح! الصفقة كانت رابحة. استيك الصفقة الأساسي: ${config.stake.toFixed(2)}. العودة للاستيك الأولي: ${config.currentStake.toFixed(2)}.`;
        

    } else { // حالة الخسارة
        config.loss++;
        config.currentTradeCountInCycle++; // زيادة عداد المضاعفات

        console.log(`[Chat ID: ${chatId}] Trade LOST! Loss streak: ${config.currentTradeCountInCycle}`);

        if (config.currentTradeCountInCycle >= MAX_MARTINGALE_LOSSES) { // استخدام الثابت
            message = `❌ خسارة! الصفقة كانت خاسرة. عدد الخسائر المتتالية: ${config.currentTradeCountInCycle}.\n🚨 وصلت إلى الحد الأقصى للمضاعفات (${MAX_MARTINGALE_LOSSES} مرات). البوت سيتوقف نهائياً.`;
            config.running = false;
            bot.sendMessage(chatId, message);
            saveUserStates();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            console.log(`[Chat ID: ${chatId}] Bot stopped due to max loss streak.`);
            return; // توقف هنا، لا داعي لمواصلة
        } else {
            config.currentStake = parseFloat((config.currentStake * MARTINGALE_FACTOR).toFixed(2)); // مضاعفة الـ stake
            message = `❌ خسارة! الصفقة كانت خاسرة. عدد الخسائر المتتالية: ${config.currentTradeCountInCycle}.\n🔄 البوت سيحاول الدخول في صفقة جديدة باستيك مضاعف: ${config.currentStake.toFixed(2)}.`;
        }
    }

    bot.sendMessage(chatId, message);
    saveUserStates(); // حفظ الحالة بعد كل صفقة (ربح أو خسارة)

    // التحقق من Take Profit / Stop Loss بعد كل صفقة
    if (config.running) { // فقط إذا كان البوت لا يزال يعمل
        if (config.tp > 0 && config.profit >= config.tp) {
            bot.sendMessage(chatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: ${config.tp.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
            config.running = false;
            saveUserStates();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            console.log(`[Chat ID: ${chatId}] Bot stopped due to TP reached.`);
            return;
        } else if (config.sl > 0 && config.profit <= -config.sl) {
            bot.sendMessage(chatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: ${config.sl.toFixed(2)}). تم إيقاف البوت تلقائياً.`);
            config.running = false;
            saveUserStates();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            console.log(`[Chat ID: ${chatId}] Bot stopped due to SL reached.`);
            return;
        }
    }

    // إذا كان البوت لا يزال يعمل ولم يتم إيقافه بالـ TP/SL أو Max Loss Streak
    // يتم بدء دورة تداول جديدة.
    if (config.running) {
        startTradingCycle(chatId, config, ws);
    }
}


// وظيفة لبدء دورة التداول (الاشتراك في التكات)
function startTradingCycle(chatId, config, ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // تأكد أننا لا نزال مشتركين في التكات
        ws.send(JSON.stringify({ "ticks": "R_50", "subscribe": 1 }));
        bot.sendMessage(chatId, "✅ جاهز لبدء دورة تداول جديدة (مراقبة شروط الدخول).");
    } else {
        // إذا لم يكن الاتصال مفتوحًا، حاول إعادة الاتصال
        reconnectDeriv(chatId, config);
    }
}

// 8. وظيفة البدء الرئيسية
function main() {
    loadUserStates(); // حمل الحالة عند بدء تشغيل البوت

    // استئناف البوتات للمستخدمين الذين كانوا نشطين عند إعادة التشغيل
    for (const id in userStates) {
        const user = userStates[id];
        if (user.running) {
            console.log(`[Chat ID: ${id}] Resuming bot operation for user.`);
            // نبدأ عملية المصادقة والاتصال من جديد
            authenticateAndGetBalance(id).then(authSuccess => {
                if (authSuccess) {
                    startBotForUser(id, user);
                } else {
                    user.running = false;
                    saveUserStates();
                    bot.sendMessage(id, `⚠ تم إعادة تشغيل البوت للمستخدم ${id}، ولكن فشلت المصادقة التلقائية. يرجى استخدام /run لإعادة التشغيل يدوياً.`);
                }
            });
        }
    }
    console.log('Bot started and waiting for commands...');
}

// تشغيل البوت
main();
