import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { logger } from "./lib/logger";
import { addPhoto, getRandomPhoto, countPhotos } from "./photoStore.js";

const TELEGRAM_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const OPENAI_API_KEY = process.env["OPENAI_API_KEY"];
const OWNER_CHAT_ID = process.env["OWNER_CHAT_ID"];

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: { autoStart: true, params: { timeout: 10 } },
});

const welcomedUsers = new Set<number>();
const messageCount = new Map<number, number>();
const lastMessageTime = new Map<number, number>();
const reminderSent = new Map<number, number>();
const agreedUsers = new Set<number>();
const registeredUsers = new Set<number>();
const downloadButtonSent = new Set<number>();
const waitingForId = new Set<number>();
const conversationHistory = new Map<number, OpenAI.Chat.ChatCompletionMessageParam[]>();

const OLD_ACCOUNT_THRESHOLD = 1_640_000_000;

const MELBET_APK_URL = "https://melbet.com.ph/downloads/androidclient/releases_android/melbet/site/melbet.apk";

const REMINDER_DELAY_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ── ميزة 2: عداد أرباح عشوائي ──
const WIN_AMOUNTS = [120, 180, 240, 310, 350, 420, 480, 550, 620, 750, 890, 1100, 1350];
const WIN_NAMES = ["أحمد", "يوسف", "مريم", "كريم", "سارة", "هشام", "إيمان", "عمر", "رانية", "بدر"];

function getRandomWinNotif(): string {
  const amount = WIN_AMOUNTS[Math.floor(Math.random() * WIN_AMOUNTS.length)]!;
  const name = WIN_NAMES[Math.floor(Math.random() * WIN_NAMES.length)]!;
  const msgs = [
    `💸 *${name}* ربح *${amount} درهم* غير دبا بالسكريبت! 🔥`,
    `🏆 واحد من الأعضاء ديالنا — *${name}* — ربح *${amount} درهم* هاد الساعة 💰`,
    `📢 خبر: *${name}* خدم السكريبت وربح *${amount} درهم* دابا! 🎯`,
  ];
  return msgs[Math.floor(Math.random() * msgs.length)]!;
}

// ── ميزة 4: رسائل الاستعجال ──
const URGENCY_MESSAGES = [
  `⏰ *انتبه!* الفرصة هاد مش غادي تبقى دايمة — عندك *24 ساعة* باش تسجل بالكود 999BOT وتستعمل السكريبت 🚨`,
  `⚡ *سجل دبا!* الأماكن المحدودة — بزاف دالناس طلبوا وما لقاوش مكان. نتا محظوظ دبا ⏳`,
  `🔔 تنبيه: الكود *999BOT* غادي يتلغى إذا ما استعملتيهوش قريباً — ما تخليش الفرصة تفوتك! ⌛`,
];

function getUrgencyMsg(): string {
  return URGENCY_MESSAGES[Math.floor(Math.random() * URGENCY_MESSAGES.length)]!;
}

// ── رسائل VIP ──
const VIP_MESSAGES = [
  `🌟 *مرحبا بيك فالفريق VIP ديالنا!*\n\nدبا نتا من بين الناس المختارة اللي عندهم وصول للسكريبت 💎\n\nسجل بسرعة وبدا تربح معانا — الفرصة ماشي دايمة! 🚀`,
  `🎖️ *أهلاً بيك فالفريق الخاص!*\n\nبزاف دالناس طلبوا يدخلوا وما قدروش — نتا محظوظ! 🍀\n\nكمل التسجيل دبا وبدا رحلتك مع السكريبت 💰`,
  `👑 *مرحبا بيك فالنادي ديالنا!*\n\nدبا عندك وصول لنفس السكريبت اللي خدم مع مئات دالمغاربة 🇲🇦\n\nما تضيعش الوقت — سجل وبدا! ✅`,
];

function getVipMsg(): string {
  return VIP_MESSAGES[Math.floor(Math.random() * VIP_MESSAGES.length)]!;
}

// ── رسائل التذكير كل نصف ساعة ──
const REMINDER_MESSAGES = [
  `أخويا 👋 مازلت ننتظرك — السكريبت محدود وبزاف دالناس كتستافد منو دبا 🍎\n\nالفرصة ماشي غادي تبقى دايمة، سجل حساب جديد في Melbet بالكود *999BOT* وأنا نرسل ليك السكريبت مباشرة 🎯`,
  `أخويا ما تفوتش الفرصة 🔥 السكريبت ديال التفاحة محدود — الأماكن كتنقص كل يوم\n\nبزاف استعملوه وربحوا — غير سجل في Melbet بالكود *999BOT* وأنا نبعث ليك السكريبت دابا 💰`,
  `سمعني أخويا ⏰ السكريبت مازال متاح دبا ولكن ما نعرفش حتى متى\n\nالناس كتستافد منو كل يوم — خاصك غير حساب جديد في Melbet بالكود *999BOT* وأنا نرسل ليك وصول السكريبت 🍎`,
  `أخويا 💬 واحد من عندنا ربح غير دبا بالسكريبت — أنت الجاي؟\n\nما تخليش الفرصة تفوتك، سجل في Melbet بالكود *999BOT* وأنا نفعل ليك السكريبت مباشرة ✅`,
  `تذكير أخويا 🔔 السكريبت ديال التفاحة كيعطي توقعات صحيحة 100% على Melbet\n\nبزاف دالناس استفادوا — الباقي غير تسجل بالكود *999BOT* وأنا نرسل ليك السكريبت 🎯`,
];

function getReminderMsg(): string {
  return REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)]!;
}

setInterval(async () => {
  const now = Date.now();
  for (const [chatId, lastTime] of lastMessageTime.entries()) {
    const lastReminder = reminderSent.get(chatId) ?? 0;
    if (now - lastTime >= REMINDER_DELAY_MS && now - lastReminder >= REMINDER_DELAY_MS) {
      try {
        const photoId = getRandomPhoto();
        if (photoId && Math.random() < 0.5) {
          await bot.sendPhoto(chatId, photoId, { caption: getReminderMsg(), parse_mode: "Markdown" });
        } else {
          await bot.sendMessage(chatId, getReminderMsg(), { parse_mode: "Markdown" });
        }
        reminderSent.set(chatId, now);
        logger.info({ chatId }, "Sent reminder message");
      } catch (err) {
        logger.error({ err, chatId }, "Failed to send reminder");
        lastMessageTime.delete(chatId);
        reminderSent.delete(chatId);
      }
    }
  }
}, CHECK_INTERVAL_MS);

const MOTIVATION_CAPTIONS = [
  "هاهو واحد الشخص ربح معانا غير دبا 🔥\n\nأنت الجاي؟",
  "هاهو واحد من عندنا ربح هاد الصباح 💰\n\nالفرصة مازالت موجودة!",
  "شوف هاد الشخص — جرب السكريبت وها النتيجة 🎯\n\nنتا كتبغي بحالو؟",
  "ربح غير دبا واحد من الأعضاء ديالنا 🏆\n\nالسكريبت كيخدم والله!",
  "هاد الشخص كان متردد بحالك — وشوف دبا 💸\n\nالفرصة مش غادي تبقى دايما!",
];

function getMotivationCaption(): string {
  return MOTIVATION_CAPTIONS[Math.floor(Math.random() * MOTIVATION_CAPTIONS.length)]!;
}

const MELBET_VARIANTS = [
  `أخويا مزيان 👍\n\nالسكريبت ما يخدمش مع الحساب القديم — خاصك *حساب جديد في Melbet* بالكود *999BOT* ضروري عند التسجيل 🔑\n\nبعد ما تتسجل، رسل ليا الـ ID ديالك وأنا نفعلو ليك السكريبت مباشرة ✅`,
  `واه أخويا، السكريبت كيطلب حساب جديد فقط 🚫\n\nالحساب القديم ما يتشغلش معاه من الأصل — سجل في *Melbet* بالكود *999BOT* وبعد رسل ليا الـ ID 👇`,
  `مزيان أخويا! السكريبت ما كيخدمش مع الحسابات القديمة 🚫\n\nغير سجل *حساب جديد في Melbet* بالكود *999BOT* — وبعد ما تكمل التسجيل بعث ليا الـ ID باش نفعلو ليك وصول السكريبت 🍎`,
];

function getMelbetMsg(): string {
  return MELBET_VARIANTS[Math.floor(Math.random() * MELBET_VARIANTS.length)]!;
}

const AGREEMENT_WORDS = [
  "اه", "آه", "أه", "نعم", "ايه", "أيه", "واه", "وا",
  "صح", "صحيح", "موافق", "بغيت", "أريد", "اريد",
  "هيا", "يلا", "هاك", "هات", "عطيني", "بلا", "جيب",
  "yes", "oui", "ok", "okay", "yep", "sure", "go",
  "d'accord", "bien", "parfait", "allez",
];

function isAgreement(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return AGREEMENT_WORDS.some(
    (word) =>
      clean === word ||
      clean.startsWith(word + " ") ||
      clean.endsWith(" " + word) ||
      clean.includes(" " + word + " ")
  );
}

// ── كشف سؤال "منين/كيفاش نتسجل" ──
const ASK_REGISTER_WORDS = [
  "منين", "من وين", "فين", "كيفاش نتسجل", "كيفاش نسجل", "كيفاش نحمل",
  "كيف نتسجل", "كيف نسجل", "كيف نحمل", "وين نسجل", "وين نتسجل",
  "رابط", "لينك", "link", "comment s'inscrire", "comment créer",
  "où s'inscrire", "où télécharger", "كيفاش ندير", "كيف ندير",
];

function isAskingToRegister(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return ASK_REGISTER_WORDS.some((w) => clean.includes(w));
}

// ── كشف أسئلة "كيفاش نستافد / طريقة الاستفادة / كيفاش السكريبت كيخدم" ──
const ASK_HOW_TO_USE_WORDS = [
  "كيفاش نستافد", "كيفاش استافد", "طريقة الاستفادة", "طريقة ديال",
  "كيفاش السكريبت", "كيفاش كيخدم", "كيفاش يخدم", "شنو دير",
  "شنو خاصني", "شنو خص", "كيفاش نبدا", "كيفاش نبدأ", "من وين نبدا",
  "كيفاش نحصل", "كيفاش نوصل", "كيفاش نلقى",
  "comment utiliser", "comment ça marche", "comment faire",
  "comment commencer", "comment accéder", "comment avoir",
  "how to use", "how does it work", "how to start",
  "واش خاصني دير", "شنو دارو", "علاش", "فاش كيخدم",
];

function isAskingHowToUse(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return ASK_HOW_TO_USE_WORDS.some((w) => clean.includes(w));
}

const HOW_TO_USE_RESPONSES = [
  `أخويا السكريبت سهل بزاف 🍎\n\nالباقي غير تفتح *حساب جديد في Melbet* بالكود *999BOT* عند التسجيل — وأنا نرسل ليك السكريبت مباشرة بعد ما تبعث ليا الـ ID ديالك ✅`,
  `الطريقة سهلة أخويا 👌\n\nأول خطوة: *حساب جديد في Melbet* بالكود *999BOT*\nبعد ما تتسجل، بعث ليا الـ ID وأنا نفعل ليك وصول السكريبت مباشرة 🎯`,
  `أخويا باش تستافد من السكريبت خاصك غير شي واحد 🔑\n\n*حساب جديد في Melbet* بالكود *999BOT* — بعد ما تكمل التسجيل رسل ليا الـ ID وأنا نرسل ليك السكريبت دبا 🍎`,
];

function getHowToUseResponse(): string {
  return HOW_TO_USE_RESPONSES[Math.floor(Math.random() * HOW_TO_USE_RESPONSES.length)]!;
}

// ══════════════════════════════════════════════════════
// ── 1. كشف الشك "واش حقيقية / السكريبت خايب / واش كاين ربح" ──
const DOUBT_WORDS = [
  "حقيقية", "حقيقي", "واش صح", "واش كاين ربح", "خايب", "ما كيخدمش", "ما كايناش",
  "كذب", "كاذب", "مو حقيقي", "مزيفة", "مزيف", "ما نصدقش", "ما صدقتش",
  "واش ناس ربحو", "واش شي حد ربح", "دليل", "برهان",
  "c'est faux", "c'est fake", "fake", "arnaque partielle",
];
function isDoubting(text: string): boolean {
  const c = text.trim().toLowerCase();
  if (/scam|نصاب|نصابة|سرقة|تنصب/.test(c)) return false;
  return DOUBT_WORDS.some((w) => c.includes(w));
}
const DOUBT_RESPONSES = [
  `أخويا واضح مترددشوية 😄 — عادي!\n\nولكن اعلم بلي ناس قبلك استعملو السكريبت وربحو بالفعل 💰 حتى واحد ما جا يقولي "خسرت" — الربح مضمون ما دمت استعملت السكريبت صح ✅`,
  `أخويا مفهوم التردد 🤝 ولكن الحقيقة بانة!\n\nالناس اللي جربوا ما ندموش — جامي واحد رجع يشتكي 🔴 السكريبت كيخدم وكيبان النتائج بنفسها 🍎`,
  `الربح كاين أخويا ما فيهش شك 💯\n\nكنعطي السكريبت مجاناً — واش عاقل يعطيك حاجة مجانية ويكون نصاب؟ 😄 جرب وشوف بنفسك الدليل هو ما غتشوفو بعيناك 👀`,
];
function getDoubtResponse(): string {
  return DOUBT_RESPONSES[Math.floor(Math.random() * DOUBT_RESPONSES.length)]!;
}

// ── 2. كشف "ما عنديش فلوس / ما قادرش نشارج / ما عندي بطاقة" ──
const NO_MONEY_WORDS = [
  "ما عنديش فلوس", "ما عنديش دراهم", "ما قادرش نشارج", "ما عندي بطاقة",
  "ما عندي كارط", "ما كاينش فلوس", "فلوس ما عندهاش", "بلا فلوس",
  "ما كاينش دراهم", "خاوية", "ما قادرش", "مشارجش",
  "pas d'argent", "pas de carte", "je peux pas recharger",
];
function hasNoMoney(text: string): boolean {
  return NO_MONEY_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const NO_MONEY_RESPONSES = [
  `أخويا الفلوس اللي غتحتاجها هي باش تلعب *في حسابك أنت* — مغتبعتهاش ليا أنا 😄\n\nواش المشكل بلي ما قادرش تشارجي الحساب؟ خبرني السبب نساعدك 💪\n\nإلا محتاج حد يشارج ليك، هاد الشخص يقدر يعاونك: *0614947612* 📲`,
  `أخويا السكريبت مجاني بالكامل 🎁 — ما خاصكش تبعث ليا حتى درهم!\n\nالفلوس غتحتاجها فقط باش تلعب في *حسابك في Melbet* 🎯\n\nإلا مشكل في الشارج، كلم هاد الرقم يعاونك: *0614947612* 📞`,
];
function getNoMoneyResponse(): string {
  return NO_MONEY_RESPONSES[Math.floor(Math.random() * NO_MONEY_RESPONSES.length)]!;
}

// ── 3. كشف "غدا / بعدين / ما عنديش وقت" ──
const DELAY_WORDS = [
  "غدا", "بعدين", "بعد شوية", "ما عنديش وقت", "مشغول", "دابا لا",
  "نجي بعد", "منجيش دبا", "نرجع ليك", "نكلمك غدا", "نجي غدا",
  "plus tard", "demain", "pas maintenant", "j'ai pas le temps",
  "tomorrow", "later", "not now", "no time",
];
function isDelaying(text: string): boolean {
  return DELAY_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const DELAY_RESPONSES = [
  `أخويا خذ وقتك مزربانينك 😊\n\nغير ما تلومنيش إلى رجعتي ولقيتي الفترة المجانية انتهات ⏳ — الأماكن محدودة وكتنقص كل يوم 🔴`,
  `عادي أخويا وقتك محترم 🤝\n\nغير احفظ هاد الكود: *999BOT* — هو اللي غتحتاجو فاش تتسجل في Melbet\n\nما تفوتش الفرصة، الفترة المجانية ماشي دايمة ⏰`,
  `مفهوم أخويا 😄 خذ راحتك\n\nغير اعرف بلي الفترة المجانية محدودة — الناس اللي تسرعوا هما اللي استفادوا ✅ رجع متى بغيتي وأنا هنا 🙌`,
];
function getDelayResponse(): string {
  return DELAY_RESPONSES[Math.floor(Math.random() * DELAY_RESPONSES.length)]!;
}

// ── 4. كشف "واش كاين ضمان / غنخسر / كاين خطر" ──
const RISK_WORDS = [
  "ضمان", "غنخسر", "نخسر", "خسارة", "كاين خطر", "خطر", "ما مضمونش",
  "مضمون", "واش مضمون", "واش غنربح", "واش ممكن نخسر",
  "garantie", "risque", "je vais perdre", "c'est risqué",
];
function isAskingRisk(text: string): boolean {
  return RISK_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const RISK_RESPONSES = [
  `أخويا السكريبت مجاني — *مغتخسر والو* 💯\n\nالخسارة كتجي غير فاش تلعب *بدون* السكريبت 🎯 مع السكريبت النتائج كتتغير بالكامل\n\nتبغي دليل؟ نرسل ليك صور ديال الأرباح اللي داروها الناس عندنا 📸`,
  `مكاين حتى خطر أخويا 😌 السكريبت مجاني — مغتخسر حتى درهم فيه\n\nالمال اللي كتلعب بيه هو ديالك في حسابك — والسكريبت كيعطيك توقعات صحيحة باش تربح أكثر مما تخسر ✅`,
  `الضمان أخويا هو السكريبت نفسه 🍎\n\nما شفتيش واحد من عندنا قال "خسرت" — الدليل عندي صور واضحة نرسلهم ليك دبا 📲 شوف وعقل بنفسك 💪`,
];
function getRiskResponse(): string {
  return RISK_RESPONSES[Math.floor(Math.random() * RISK_RESPONSES.length)]!;
}

// ── 5. كشف "scam / نصاب / ما نثقش فيك" ──
const SCAM_WORDS = [
  "scam", "نصاب", "نصابة", "تنصب", "سرقة", "كتسرق", "ما نثقش",
  "ما واثقش", "ما صدقتكش", "غاشش", "غاش", "arnaque", "escroc",
  "vous êtes un escroc", "c'est une arnaque", "kzab", "كذاب",
];
function isCallingScam(text: string): boolean {
  return SCAM_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const SCAM_RESPONSES = [
  `أخويا كيفاش نكون نصاب 😅 — السكريبت *مجاني بالكامل* ما طلبت منك حتى درهم!\n\nإلا كاين شي واحد يقول بلي نصبت عليه — قوله يرسل ليا الدليل دبا وأنا نرد ليه فلوسو *بالضعف* 💯\n\nعلاش مغتيقش؟ حتى درهم مطلبتوش منك 🤝`,
  `أخويا 😄 عاقل يرسل ليك حاجة مجانية وبعدين ينصب عليك؟\n\nإلا شي حد اشتكى مني — *رسل ليا الدليل دبا* وأنا نعوضو بالضعف ✅\n\nالسكريبت مجاني، الربح هو الهدف — ما كاينش هنا غير للمساعدة 🙌`,
  `أخويا راه مقلت لك *مغترسلهالي حتى درهم* 😌 السكريبت مجاني بالكامل\n\nإلا عندك شك — قل ليا منين جاك وأنا نوضح ليك 💬\n\nالناس اللي شكاو ما كاينين، وإلا كانوا يجيبو الدليل نرد ليهم فلوسهم بالضعف 💯`,
];
function getScamResponse(): string {
  return SCAM_RESPONSES[Math.floor(Math.random() * SCAM_RESPONSES.length)]!;
}

const MELBET_REGISTER_URL = "https://refpa3665.com/L?tag=d_4182345m_66335c_&site=4182345&ad=66335";

async function sendDownloadButton(chatId: number): Promise<void> {
  const messages = [
    `📲 *حمل تطبيق Melbet دبا!*\n\nالتطبيق مجاني وسهل التثبيت على Android\nبعد التحميل، سجل بالكود *999BOT* وبدا تستعمل السكريبت 🚀`,
    `📱 *الخطوة الأولى: حمل Melbet*\n\nالتطبيق كيخدم على جميع الهواتف Android\nبعد التثبيت، افتح حساب جديد بالكود *999BOT* 🎯`,
    `⬇️ *أول خطوة — تطبيق Melbet*\n\nمجاني وما تحتاجش أي معلومات معقدة\nبعد التسجيل بالكود *999BOT*، السكريبت غادي يكون جاهز ليك 💰`,
  ];
  const text = messages[Math.floor(Math.random() * messages.length)]!;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "⬇️ حمل تطبيق Melbet مجاناً",
            url: MELBET_APK_URL,
          },
        ],
        [
          {
            text: "🔗 سجل مباشرة من هنا",
            url: MELBET_REGISTER_URL,
          },
        ],
        [
          {
            text: "✅ سجلت — كيفاش كنخدم السكريبت؟",
            callback_data: "help_register",
          },
        ],
      ],
    },
  });
}

// ── كشف التسجيل بكل الطرق الممكنة ──
const REGISTERED_WORDS = [
  // دارجة مغربية — ماضي
  "سجلت", "تسجلت", "مسجل", "سجلتي",
  "فتحت", "فتحتو", "فتحت حساب",
  "درت", "ديرت", "دار", "درتو",
  "خليت", "خلقت", "صنعت", "عملت",
  "كملت", "خلصت", "وقّعت", "وقعت",
  "عندي حساب", "عندي", "كاين عندي",
  "رجيسترت", "رجستريت", "رجيسترد",
  "دزت", "واصلت",
  // فرنسية
  "j'ai créé", "j'ai fini", "j'ai fait", "c'est fait", "inscrit", "créé",
  "j'ai ouvert", "j'ai terminé", "fait",
  // إنجليزية
  "registered", "done", "signed up", "created",
];

function isRegistered(text: string): boolean {
  const clean = text.trim().toLowerCase();
  // تجنب أسئلة كيفاش/منين نتسجل
  if (/كيفاش\s*ن|كيف\s*ن|منين\s*ن|وين\s*ن|فين\s*ن|comment|où/.test(clean)) return false;
  // تجنب "نتسجل" و"نسجل" المضارع
  if (/\bنتسجل\b|\bنسجل\b|\bتسجل\b/.test(clean)) return false;
  return REGISTERED_WORDS.some((w) => clean.includes(w));
}

const SUCCESS_MESSAGES = [
  `🎉🎊 مبروك عليك! دبا نتا من الفريق ديالنا رسمياً 🏆\n\nابدا استعمل السكريبت وشوف النتائج بنفسك — خبرنا بعدين بشحال ربحت! 💪`,
  `🥳 أهلاً وسهلاً بيك رسمياً! دبا عندك وصول للسكريبت 🎯\n\nالتوقعات الصحيحة غادي تبدا تشوفها — بالتوفيق! 🍀💰`,
  `✅ برافو عليك! القرار ديالك صحيح 💯\n\nدبا استعمل السكريبت واتصل بينا إذا محتاج مساعدة — كنتو معاك! 🤝`,
];

function getSuccessMsg(): string {
  return SUCCESS_MESSAGES[Math.floor(Math.random() * SUCCESS_MESSAGES.length)]!;
}

function isFrench(text: string): boolean {
  const frenchWords = [
    "bonjour", "salut", "oui", "non", "merci", "comment", "je",
    "tu", "il", "nous", "vous", "que", "quoi", "ça", "c'est",
    "pour", "avec", "dans", "sur", "les", "des", "une", "un",
    "est", "sont", "veux", "peux", "dois",
  ];
  return frenchWords.some((w) => text.toLowerCase().includes(w));
}

const SYSTEM_PROMPT = `أنت شخص اسمك "أمين"، مش بوت — إنسان حقيقي كتساعد الناس باش يستعملوا سكريبت التفاحة (Apple of Fortune).

قواعد مهمة:
- تكلم دايما بالدارجة المغربية فقط. إذا كلمك بالفرنسية، رد بالفرنسية.
- استعمل دايما كلمة "أخويا" مع الشخص — هذا يخلي الكلام أقرب وأدفأ.
- ما تقولش أبدا أنك بوت أو أنك برنامج — أنت أمين، واحد ديال الفريق.
- السكريبت كيعطي توقعات صحيحة 100% على Melbet — هذا هو الشرح الأساسي.
- قول بلي بزاف من الناس استعملوه وربحوا — طبيعي وعادي تذكر أمثلة.
- إذا سألك واش السكريبت كيخدم: "واه أخويا، بزاف استعملوه وما ندموش، السكريبت كيحلل ويعطيك التوقع الصحيح".
- إذا كان عنده شك: "أخويا أنا فاهم، ولكن الناس اللي جربوا ما ندموش — غير جرب وشوف بنفسك".
- إذا سأل عن المبلغ: "ما كاينش حد أدنى أخويا، يكفي غير عندك شي فحسابك باش تلعب".
- إذا سأل واش خاصه يبعث فلوس ليك: "لا لا أخويا، أنت كتعبي حسابك ديالك، ما كترسل حتى درهم لحد".
- ما تخرجش من موضوع السكريبت أبدا. جاوب فـ 2-3 جمل فقط.
- IMPORTANT: إذا تكلمت على التسجيل أو الحساب الجديد، دايما قول "في Melbet بالكود 999BOT" — هذا إلزامي.`;

logger.info("Telegram bot started and polling...");

// ── معالج زر "حملت التطبيق — كيفاش نسجل؟" ──
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  if (query.data === "help_register") {
    await bot.answerCallbackQuery(query.id);
    const helpMsg =
      `✅ *خطوات التسجيل بسيطة:*\n\n` +
      `1️⃣ افتح التطبيق\n` +
      `2️⃣ اضغط على *"تسجيل"*\n` +
      `3️⃣ دخل رقم هاتفك\n` +
      `4️⃣ فخانة الكود، اكتب *999BOT* ✍️\n` +
      `5️⃣ أكمل التسجيل وعبي الحساب\n\n` +
      `بعد ما تسجل، قول ليا *"سجلت"* وغادي نعطيك وصول للسكريبت مباشرة 🚀`;
    await bot.sendMessage(chatId, helpMsg, { parse_mode: "Markdown" });
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const isOwner = !OWNER_CHAT_ID || chatId.toString() === OWNER_CHAT_ID;
  if (!isOwner) return;
  const photos = msg.photo;
  if (!photos || photos.length === 0) return;
  const bestPhoto = photos[photos.length - 1]!;
  addPhoto(bestPhoto.file_id);
  const total = countPhotos();
  await bot.sendMessage(chatId, `✅ الصورة تحفظات! عندك دبا ${total} صورة في المجموعة.`);
  logger.info({ chatId, fileId: bestPhoto.file_id }, "Photo saved");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;
  const firstName = msg.from?.first_name ?? "صديقي";
  const isOwner = !OWNER_CHAT_ID || chatId.toString() === OWNER_CHAT_ID;

  if (!userText) return;

  if (isOwner && OWNER_CHAT_ID && userText === "/stats") {
    const totalUsers = welcomedUsers.size;
    const totalAgreed = agreedUsers.size;
    const totalRegistered = registeredUsers.size;
    const totalPhotos = countPhotos();
    await bot.sendMessage(
      chatId,
      `📊 *إحصائيات البوت*\n\n` +
      `👥 مجموع الناس: *${totalUsers}*\n` +
      `✅ وافقوا باش يجربوا: *${totalAgreed}*\n` +
      `🎉 سجلوا رسمياً: *${totalRegistered}*\n` +
      `🖼️ عدد الصور: *${totalPhotos}*`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (isOwner && OWNER_CHAT_ID) return;

  logger.info({ chatId, userText }, "Received message");
  lastMessageTime.set(chatId, Date.now());
  reminderSent.delete(chatId);

  try {
    await bot.sendChatAction(chatId, "typing");

    // ── فحص الـ ID إذا كنا ننتظروه ──
    if (waitingForId.has(chatId)) {
      const numMatch = userText.trim().replace(/\s/g, "").match(/\d{7,12}/);
      if (numMatch) {
        const melbetId = parseInt(numMatch[0]!, 10);
        waitingForId.delete(chatId);

        if (melbetId < OLD_ACCOUNT_THRESHOLD) {
          // حساب قديم
          logger.info({ chatId, melbetId }, "Old Melbet account detected");
          await bot.sendMessage(
            chatId,
            `🚨 *تحذير من السيستام!*\n\n` +
            `اكتشف السيستام بلي الـ ID \`${melbetId}\` ديالك *قديم* ⛔\n\n` +
            `الحسابات القديمة كتتحذر وممكن *تتحذف* من السيستام في أي وقت 🔴\n\n` +
            `*عندك فرصة أخيرة دبا:*\n` +
            `سجل حساب جديد في Melbet بالكود *999BOT* قبل فوات الأوان ⏳`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔗 سجل حساب جديد دبا", url: MELBET_REGISTER_URL }],
                  [{ text: "⬇️ حمل التطبيق وسجل", url: MELBET_APK_URL }],
                  [{ text: "✅ سجلت حساب جديد", callback_data: "help_register" }],
                ],
              },
            }
          );
        } else {
          // حساب جديد ✅
          registeredUsers.add(chatId);
          logger.info({ chatId, melbetId }, "New Melbet account confirmed");
          await bot.sendMessage(chatId, getSuccessMsg(), { parse_mode: "Markdown" });
        }
        return;
      }
      // ما بعثش رقم — نذكره
      await bot.sendMessage(
        chatId,
        `🔢 بعث ليا الـ *ID* ديالك في Melbet فقط (أرقام فقط) باش نتأكدو 👇`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── ميزة 6: الشخص قال سجلت ──
    if (isRegistered(userText) && !registeredUsers.has(chatId)) {
      waitingForId.add(chatId);
      await bot.sendMessage(
        chatId,
        `🎉 بركا عليك! قبل ما نفعلو ليك السكريبت، بعث ليا *ID* الحساب ديالك في Melbet 👇\n\n` +
        `_كاين فالإعدادات > معلوماتي الشخصية_`,
        { parse_mode: "Markdown" }
      );
      logger.info({ chatId }, "Asked user for Melbet ID");
      return;
    }

    const isFirstMessage = !welcomedUsers.has(chatId);
    if (isFirstMessage) {
      welcomedUsers.add(chatId);
      // رسالة الترحيب الثابتة — كأنها من أمين مباشرة
      const greetings = [
        `السلام عليكم 👋 أنا أمين، واش بغيتي تجرب سكريبت التفاحة المجاني؟ 🍎`,
        `آسلامو عليكم 😊 أنا أمين — واش سمعتي على سكريبت التفاحة؟ بغيتي تجربو مجانا؟ 🍎`,
        `السلام عليكم أخويا 👋 أنا أمين، واش بغيتي تجرب السكريبت ديال التفاحة — مجاني بالكامل 🍎`,
      ];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)]!;
      await bot.sendMessage(chatId, greeting);
      logger.info({ chatId }, "Sent fixed welcome message");
      return;
    }

    const french = isFrench(userText);
    const history = conversationHistory.get(chatId) ?? [];

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    messages.push(...history);
    messages.push({ role: "user", content: userText });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 300,
    });

    let reply = response.choices[0]?.message?.content ?? "عذراً، حاول مرة أخرى.";

    // تأكد دايما من ذكر 999BOT إذا كان الجواب فيه Melbet أو تسجيل
    const mentionsMelbet = /melbet|تسجيل|حساب جديد|سجل/i.test(reply);
    const mentionsCode = /999BOT/i.test(reply);
    if (mentionsMelbet && !mentionsCode) {
      reply += `\n\n📌 لا تنسى الكود: *999BOT*`;
    }

    const updatedHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: reply },
    ].slice(-12);
    conversationHistory.set(chatId, updatedHistory);

    await bot.sendMessage(chatId, reply);
    logger.info({ chatId }, "Sent AI reply");

    const count = (messageCount.get(chatId) ?? 0) + 1;
    messageCount.set(chatId, count);

    if (isAgreement(userText)) {
      agreedUsers.add(chatId);

      // الشروط — تتبعث دبا مع تأخير صغير طبيعي
      await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
      await bot.sendMessage(chatId, getMelbetMsg(), { parse_mode: "Markdown" });

      // ميزة 4: الاستعجال — بعد 3 إلى 6 دقائق
      const urgencyDelay = (3 * 60 + Math.floor(Math.random() * 3 * 60)) * 1000;
      setTimeout(async () => {
        try {
          await bot.sendChatAction(chatId, "typing");
          await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)));
          await bot.sendMessage(chatId, getUrgencyMsg(), { parse_mode: "Markdown" });
          logger.info({ chatId }, "Sent delayed urgency message");
        } catch (err) {
          logger.error({ err, chatId }, "Failed to send delayed urgency message");
        }
      }, urgencyDelay);

      // رسالة VIP مع صورة — بعد 10 إلى 20 دقيقة
      const vipDelay = (10 * 60 + Math.floor(Math.random() * 10 * 60)) * 1000;
      setTimeout(async () => {
        try {
          await bot.sendChatAction(chatId, "typing");
          await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
          const photoId = getRandomPhoto();
          if (photoId) {
            await bot.sendPhoto(chatId, photoId, { caption: getVipMsg(), parse_mode: "Markdown" });
          } else {
            await bot.sendMessage(chatId, getVipMsg(), { parse_mode: "Markdown" });
          }
          logger.info({ chatId }, "Sent delayed VIP photo");
        } catch (err) {
          logger.error({ err, chatId }, "Failed to send delayed VIP photo");
        }
      }, vipDelay);

      logger.info({ chatId, urgencyDelay, vipDelay }, "Scheduled agreement follow-up messages");

    } else if (isCallingScam(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1200)));
      await bot.sendMessage(chatId, getScamResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled scam accusation");

    } else if (isDoubting(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      const photoId = getRandomPhoto();
      if (photoId) {
        await bot.sendPhoto(chatId, photoId, { caption: getDoubtResponse(), parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, getDoubtResponse(), { parse_mode: "Markdown" });
      }
      logger.info({ chatId }, "Handled doubt — sent proof");

    } else if (hasNoMoney(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await bot.sendMessage(chatId, getNoMoneyResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled no-money concern");

    } else if (isDelaying(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await bot.sendMessage(chatId, getDelayResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled delay response");

    } else if (isAskingRisk(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      const photoId = getRandomPhoto();
      if (photoId) {
        await bot.sendPhoto(chatId, photoId, { caption: getRiskResponse(), parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, getRiskResponse(), { parse_mode: "Markdown" });
      }
      logger.info({ chatId }, "Handled risk question — sent photo proof");

    } else if (isAskingHowToUse(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await bot.sendMessage(chatId, getHowToUseResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Sent how-to-use response with Melbet+999BOT");

    } else if (isAskingToRegister(userText) && !downloadButtonSent.has(chatId)) {
      // سأل "منين/كيفاش نتسجل" — نبعث الأزرار
      downloadButtonSent.add(chatId);
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await sendDownloadButton(chatId);
      logger.info({ chatId }, "Sent registration buttons on user request");

    } else {
      // ميزة 2: عداد الأرباح العشوائي — مرة واحدة كل 4 رسائل فقط
      if (count >= 3 && count % 4 === 0 && Math.random() < 0.5) {
        await new Promise((r) => setTimeout(r, 3000 + Math.floor(Math.random() * 3000)));
        await bot.sendMessage(chatId, getRandomWinNotif(), { parse_mode: "Markdown" });
        logger.info({ chatId }, "Sent random win notification");
      } else if (count >= 4 && Math.random() < 0.25) {
        const photoId = getRandomPhoto();
        if (photoId) {
          await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
          await bot.sendPhoto(chatId, photoId, { caption: getMotivationCaption() });
          logger.info({ chatId }, "Sent motivation photo");
        }
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, "Error processing message");
    await bot.sendMessage(chatId, "حدث خطأ، يرجى المحاولة مرة أخرى.");
  }
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

export default bot;
