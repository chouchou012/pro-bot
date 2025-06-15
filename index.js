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
      // خصائص جديدة لاستراتيجية الشموع الكاملة
      candle10MinOpenPrice: null, // لتخزين سعر الافتتاح لشمعة الـ 10 دقائق الحالية
      lastProcessed10MinIntervalStart: -1, // لتتبع الدقيقة X0 التي تم معالجتها (لمنع التكرار)
      tradingCycleActive: false // لتتبع ما إذا كانت هناك صفقة جارية أو دورة مارتينغال
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
    // إضافة بعض الحالات الأولية لضمان عدم وجود أخطاء عند بدء التشغيل
    state.candle10MinOpenPrice = null;
    state.lastProcessed10MinIntervalStart = -1;
    state.tradingCycleActive = false;
    state.currentTradeCountInCycle = 0; // إضافة لعداد المارتينغال
    bot.sendMessage(id, '✅ تم الإعداد! أرسل /run لتشغيل البوت، /stop لإيقافه.');

}

});



bot.onText(/\/run/, (msg) => {
    const id = msg.chat.id;
    const user = userStates[id];
    if (!user || user.running) {
        if (user && user.running) {
            bot.sendMessage(id, '🔄 البوت قيد التشغيل بالفعل.');
        } else {
            bot.sendMessage(id, '⚠ الرجاء إعداد البوت أولاً باستخدام /start.');
        }
        return;
    }

    user.running = true;
    user.currentStake = user.stake; // إعادة تعيين الستيك الأساسي عند التشغيل
    user.currentTradeCountInCycle = 0; // إعادة تعيين عداد المارتينغال
    user.tradingCycleActive = false; // التأكد من عدم وجود دورة نشطة سابقة
    user.candle10MinOpenPrice = null; // إعادة تعيين بيانات الشمعة
    user.lastProcessed10MinIntervalStart = -1; // إعادة تعيين بيانات الشمعة

    bot.sendMessage(id, '🚀 تم بدء التشغيل...');
    startBotForUser(id, user);
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

// *******************************************************************
// ******* هذا هو الجزء المعدل لتحليل شمعة الـ 10 دقائق الكاملة *******
// *******************************************************************
else if (msg.msg_type === 'tick' && msg.tick) {
    const currentTickPrice = parseFloat(msg.tick.quote);
    const tickEpoch = msg.tick.epoch;
    const tickDate = new Date(tickEpoch * 1000);
    const currentMinute = tickDate.getMinutes();
    const currentSecond = tickDate.getSeconds();

    // تحديد بداية فترة الـ 10 دقائق الحالية (0, 10, 20, 30, 40, 50)
    const current10MinIntervalStartMinute = Math.floor(currentMinute / 10) * 10;

    // هذا الجزء يتم تشغيله فقط في الثانية 00 من الدقائق 0, 10, 20, 30, 40, 50
    if (currentSecond === 0 && currentMinute === current10MinIntervalStartMinute) {
        // التحقق مما إذا كانت هذه فترة 10 دقائق جديدة لم تتم معالجتها بعد
        if (config.lastProcessed10MinIntervalStart !== current10MinIntervalStartMinute) {
            let tradeDirection = 'none'; 

            // إذا كان لدينا سعر افتتاح للشمعة السابقة (ليست أول شمعة بعد تشغيل البوت)
            if (config.candle10MinOpenPrice !== null) {
                const previousCandleOpen = config.candle10MinOpenPrice;
                const previousCandleClose = currentTickPrice; // سعر الإغلاق للشمعة السابقة هو التيك الحالي (سعر افتتاح الشمعة الجديدة)

                if (previousCandleClose < previousCandleOpen) {
                    tradeDirection = 'CALL'; // الشمعة السابقة كانت هابطة -> دخول صفقة شراء (CALL)
                    bot.sendMessage(chatId, `📉 الشمعة السابقة (10 دقائق) هابطة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                } else if (previousCandleClose > previousCandleOpen) {
                    tradeDirection = 'PUT'; // الشمعة السابقة كانت صاعدة -> دخول صفقة بيع (PUT)
                    bot.sendMessage(chatId, `📈 الشمعة السابقة (10 دقائق) صاعدة (فتح: ${previousCandleOpen.toFixed(3)}, إغلاق: ${previousCandleClose.toFixed(3)}).`);
                } else {
                    bot.sendMessage(chatId, `↔ الشمعة السابقة (10 دقائق) بدون تغيير. لا يوجد اتجاه واضح.`);
                }
            } else {
                // هذه هي أول شمعة 10 دقائق بعد تشغيل البوت، لا يوجد بيانات سابقة للتحليل.
                bot.sendMessage(chatId, `⏳ جاري جمع بيانات الشمعة الأولى (10 دقائق). الرجاء الانتظار حتى بداية الشمعة التالية لتحديد الاتجاه.`);
            }

            // تحديث سعر الافتتاح للشمعة الجديدة (التيك الحالي هو سعر الافتتاح للشمعة التي بدأت للتو)
            config.candle10MinOpenPrice = currentTickPrice;
            // تحديث آخر فترة 10 دقائق تمت معالجتها
            config.lastProcessed10MinIntervalStart = current10MinIntervalStartMinute; 

            // محاولة الدخول في صفقة إذا تم استيفاء جميع الشروط
            // (تم تحديد اتجاه، البوت يعمل، ولا توجد صفقة أو دورة مارتينغال جارية)
            if (tradeDirection !== 'none' && config.running && !config.tradingCycleActive) { 
                if (config.currentTradeCountInCycle > 0) {
                     bot.sendMessage(chatId, `🔄 جاري الدخول في صفقة مارتينغال رقم (${config.currentTradeCountInCycle}) بمبلغ <span class="math-inline">\{config\.currentStake\.toFixed\(2\)\}</span> بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                } else {
                    bot.sendMessage(chatId, `✅ جاري الدخول في صفقة أساسية بمبلغ <span class="math-inline">\{config\.currentStake\.toFixed\(2\)\}</span> بناءً على اتجاه الشمعة السابقة (${tradeDirection}).`);
                }
                await enterTrade(config, tradeDirection, chatId, ws);
                config.tradingCycleActive = true; // وضع علامة على أن دورة التداول نشطة
            } else {
                // إذا لم يتم الدخول في صفقة (لأن tradingCycleActive TRUE أو no direction)
                // ونحن في بداية شمعة جديدة وليست هناك صفقة جارية (tradingCycleActive FALSE)،
                // نقوم بإعادة ضبط الستيك وعداد المارتينغال للاستعداد للدورة التالية.
                if (!config.tradingCycleActive) { 
                    config.currentStake = config.stake; 
                    config.currentTradeCountInCycle = 0; 
                }
            }
            return; // مهم: نخرج هنا بعد معالجة بداية الشمعة لمنع معالجة نفس الحدث مرة أخرى.
        } 
    }
}
// *******************************************************************
// *********************** نهاية الجزء المعدل *************************
// *******************************************************************

// <--- نهاية كتلة معالجة التيكات الجديدة



// معالجة الاقتراح والشراء والمراقبة داخل المستمع الرئيسي للرسائل (تبقى كما هي)

else if (msg.msg_type === 'proposal') {

// هذه هي استجابة طلب الاقتراح

// هنا يمكنك إرسال طلب الشراء 'buy'

    if (msg.error) {
        bot.sendMessage(chatId, `❌ فشل اقتراح الصفقة: ${msg.error.message}`);
        // في حالة فشل الاقتراح، نعتبرها خسارة ونطبق منطق المارتينغال
        config.loss++; 
        config.currentTradeCountInCycle++; 
        config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2)); 
        bot.sendMessage(chatId, `❌ فشل الاقتراح. جاري مضاعفة المبلغ إلى <span class="math-inline">\{config\.currentStake\.toFixed\(2\)\}</span> والانتظار للشمعة الـ 10 دقائق التالية.`);
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

else if (msg.msg_type === 'buy') {

// هذه هي استجابة طلب الشراء

    if (msg.error) {
        bot.sendMessage(chatId, `❌ فشل شراء الصفقة: ${msg.error.message}`);
        // في حالة فشل الشراء، نعتبرها خسارة ونطبق منطق المارتينغال
        config.loss++; 
        config.currentTradeCountInCycle++; 
        config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2)); 
        bot.sendMessage(chatId, `❌ فشل الشراء. جاري مضاعفة المبلغ إلى <span class="math-inline">\{config\.currentStake\.toFixed\(2\)\}</span> والانتظار للشمعة الـ 10 دقائق التالية.`);
        config.tradingCycleActive = false; 
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
    const contract = msg.proposal_open_contract;
    const profit = parseFloat(contract.profit);
    const win = profit > 0;

    config.profit += profit; 

    ws.send(JSON.stringify({ "forget": contract.contract_id }));

    if (win) {
        config.win++;
        bot.sendMessage(chatId, `📊 نتيجة الصفقة: ✅ ربح! ربح: <span class="math-inline">\{profit\.toFixed\(2\)\}</span>\n💰 الرصيد الكلي: <span class="math-inline">\{config\.profit\.toFixed\(2\)\}</span>\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}\n\n✅ تم الربح. جاري انتظار شمعة 10 دقائق جديدة.`);

        config.tradingCycleActive = false; // إنهاء الدورة عند الربح
        config.currentTradeCountInCycle = 0; // إعادة تعيين عداد المارتينغال
        config.currentStake = config.stake; // إعادة الستيك الأساسي
    } else { 
        config.loss++;
        config.currentTradeCountInCycle++; 

        let messageText = `📊 نتيجة الصفقة: ❌ خسارة! خسارة: <span class="math-inline">\{Math\.abs\(profit\)\.toFixed\(2\)\}</span>\n💰 الرصيد الكلي: <span class="math-inline">\{config\.profit\.toFixed\(2\)\}</span>\n📈 ربح: ${config.win} | 📉 خسارة: ${config.loss}`;

        const maxMartingaleLosses = 5; // عدد صفقات المارتينغال المسموح بها قبل التوقف

        if (config.currentTradeCountInCycle >= maxMartingaleLosses) { 
            messageText += `\n🛑 تم الوصول إلى الحد الأقصى للخسائر في دورة المارتينغال (${maxMartingaleLosses} صفقات متتالية). تم إيقاف البوت تلقائياً.`;
            bot.sendMessage(chatId, messageText);
            config.running = false; 
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        } else {
            config.currentStake = parseFloat((config.currentStake * 2.2).toFixed(2));
            messageText += `\n🔄 جاري مضاعفة المبلغ (مارتينغال رقم ${config.currentTradeCountInCycle}) إلى <span class="math-inline">\{config\.currentStake\.toFixed\(2\)\}</span> والانتظار للشمعة الـ 10 الدقائق التالية لدخول صفقة.`;
            bot.sendMessage(chatId, messageText);
        }
    }

    if (config.tp > 0 && config.profit >= config.tp) {
        bot.sendMessage(chatId, `🎯 تهانينا! تم الوصول إلى هدف الربح (TP: <span class="math-inline">\{config\.tp\.toFixed\(2\)\}</span>). تم إيقاف البوت تلقائياً.`);
        config.running = false;
        ws.close();
    } else if (config.sl > 0 && config.profit <= -config.sl) {
        bot.sendMessage(chatId, `🛑 عذراً! تم الوصول إلى حد الخسارة (SL: <span class="math-inline">\{config\.sl\.toFixed\(2\)\}</span>). تم إيقاف البوت تلقائياً.v`);
        config.running = false;
        ws.close();
    }
}

    else if (msg.msg_type === 'error') {
        bot.sendMessage(chatId, `⚠ خطأ من Deriv API: ${msg.error.message}`);
        // في حالة الخطأ، من الأفضل إعادة ضبط الحالة لضمان عدم دخول صفقات خاطئة
        config.tradingCycleActive = false;
        config.currentStake = config.stake;
        config.currentTradeCountInCycle = 0;
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
