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

const isProduction = process.env["NODE_ENV"] !== "development";
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: isProduction ? { autoStart: true, params: { timeout: 10 } } : false,
});

const welcomedUsers = new Set<number>();
const messageCount = new Map<number, number>();
const lastMessageTime = new Map<number, number>();
const reminderTimers = new Map<number, ReturnType<typeof setTimeout>>();
const agreedUsers = new Set<number>();
const registeredUsers = new Set<number>();
const downloadButtonSent = new Set<number>();
const waitingForId = new Set<number>();
const pendingPitch = new Set<number>(); // ينتظر رد الشخص قبل الشرح

// ── سجل آخر رسائل المستخدمين (للأونر) ──
const recentMessages: { chatId: number; name: string; text: string; at: number }[] = [];

// ── شهادات الأرباح ──
export const testimonials: { chatId: number; name: string; text: string; at: number }[] = [];

// ── صور الإثبات (منفصلة عن صور التسويق) ──
export const proofPhotos = new Set<string>();

// ── تتبع المواضيع ──
const topicCounts = new Map<string, number>([
  ["تسجيل", 0],
  ["حساب قديم", 0],
  ["سحب / شحن", 0],
  ["ربح / خسارة", 0],
  ["السكريبت", 0],
  ["ضمان / نصب", 0],
  ["شحال نربح", 0],
  ["تحميل التطبيق", 0],
  ["ردود قصيرة", 0],
  ["أخرى", 0],
]);

function detectTopic(text: string): string {
  const t = text.toLowerCase();
  // تسجيل
  if (/سجل|تسجيل|نسجل|تسجلت|سجلت|حساب جديد|داخل|دخلت|انضم|اشتركت|compte|register|tsajl|ntsajl|sajlt|gdit compte|gdit hsb|drto|drt compte|inscription/.test(t)) return "تسجيل";
  // حساب قديم
  if (/قديم|حساب قديم|عندي حساب|الحساب ديالي|compte ancien|7sab qdim|hsb qdim|3ndi compte/.test(t)) return "حساب قديم";
  // سحب / شحن
  if (/سحب|شحن|شحنت|سحبت|دفع|تحويل|فلوس|ودعت|طلعت|كريدي|درهم|دراهم|recharge|depot|retrait|virement|argent|flous|s7b|s-7b/.test(t)) return "سحب / شحن";
  // ربح / خسارة
  if (/ربح|ربحت|خسر|خسرت|ربحتي|ربحنا|كسبت|كسبتي|rb7|rb7t|ksr|ksrt|gagné|perdu|profit|gain|rbht|rbh/.test(t)) return "ربح / خسارة";
  // السكريبت
  if (/سكريبت|تفاحة|كيخدم|خدام|كيعطي|توقع|script|apple|prediction|signal|استعمل|نستعمل|skript|lscript|tapaha/.test(t)) return "السكريبت";
  // ضمان / نصب
  if (/آمن|نصب|خايف|خوف|ضمان|موثوق|مزور|صادق|حقيقي|واقعي|confiance|fiable|arnaque|sécur|nsb|khayf|mzwr|wach sah|wach s7i7/.test(t)) return "ضمان / نصب";
  // شحال نربح
  if (/شحال|كمية|مبلغ|قيمة|باش نربح|يمكن نربح|نكسب|combien|montant|ch7al|sh7al|bch nrb7|bsh nrb7/.test(t)) return "شحال نربح";
  // تحميل التطبيق
  if (/حمل|تحميل|تطبيق|نزل|telecharge|download|apk|application|app|installer|7ml|nzl/.test(t)) return "تحميل التطبيق";
  // ردود قصيرة
  if (t.trim().length < 15) return "ردود قصيرة";
  return "أخرى";
}
const knownUsers = new Map<number, { name: string; username?: string; joinedAt: number }>();

// ── محاكاة الكتابة البشرية ──
async function typeAndSend(
  chatId: number,
  text: string,
  opts: Parameters<typeof bot.sendMessage>[2] = {}
): Promise<void> {
  const chars   = text.replace(/[*_~`[\]]/g, "").length;
  const delayMs = Math.min(Math.max(chars * 38, 1200), 4800);
  await bot.sendChatAction(chatId, "typing");
  await new Promise((r) => setTimeout(r, delayMs));
  await bot.sendMessage(chatId, text, opts);
}

// ── إشعار الأونر ──
async function notifyOwner(text: string): Promise<void> {
  if (!OWNER_CHAT_ID) return;
  try {
    await bot.sendMessage(Number(OWNER_CHAT_ID), text, { parse_mode: "Markdown" });
  } catch { /* ignore */ }
}
const conversationHistory = new Map<number, OpenAI.Chat.ChatCompletionMessageParam[]>();

const OLD_ACCOUNT_THRESHOLD  = 1_640_000_000;
const INVALID_ID_MAX         = 1_700_000_000;

const MELBET_APK_URL = "https://melbet.com.ph/downloads/androidclient/releases_android/melbet/site/melbet.apk";

const REMINDER_DELAY_MS = 30 * 60 * 1000;

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

// ── ميزة 2: رسائل بحسب الوقت ──
type TimePeriod = "morning" | "afternoon" | "evening" | "night";
function getTimePeriod(): TimePeriod {
  const h = new Date().getHours(); // UTC — Railway قريب من UTC+1
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

function getTimeGreeting(): string {
  const period = getTimePeriod();
  const map: Record<TimePeriod, string[]> = {
    morning: [
      `صباح الخير أخي ☀️ — الصبح هو أحسن وقت تبدا فيه مع السكريبت!`,
      `صبح خير 🌅 — ناس دبا كيربحو من الصباح الباكر 💰`,
      `صباح النور 😄 — بكري كتبدا، أكثر ربحت اليوم 🍎`,
    ],
    afternoon: [
      `مرحبا أخي 👋 — نص النهار وأنت مازلت ما بدتيش تستافد؟ 😄`,
      `هيا أخي ☕ — نص النهار مزيان للسكريبت 🎯`,
      `سلام 😊 — الفرصة مازالت موجودة، أنت فين؟`,
    ],
    evening: [
      `مساء الخير أخي 🌇 — الليلة هي ليلتك! سجل وبدا مع السكريبت 🔥`,
      `مسا النور 🌆 — بزاف من الناس كيربحو في المساء مع السكريبت`,
      `مساء النور أخي 😊 — أكثر وقت حيوي في اليوم هو دبا 💰`,
    ],
    night: [
      `الليل هو وقت الفرص الكبيرة أخي 🌙 — السكريبت كيخدم حتى هاد الوقت 🔥`,
      `هههه مازلت صاحي؟ 😏 — والله الليل هو أحسن وقت للربح مع السكريبت 🍎`,
      `الليل طويل والربح أحسن أخي 🌃 — ما تضيعش الوقت، سجل بالكود *999BOT*`,
    ],
  };
  const msgs = map[period];
  return msgs[Math.floor(Math.random() * msgs.length)]!;
}

// ── ميزة 3: كشف المنافسين ──
const COMPETITOR_KEYWORDS = [
  "1xbet", "1x bet", "sportaza", "betway", "bwin", "bet365", "1win",
  "mostbet", "parimatch", "leon", "betwinner", "22bet", "melbet concurrent",
  "site concurrent", "autre app", "autre site", "moyen autre",
  "avantage autre", "mieux que melbet",
];

function detectCompetitor(text: string): boolean {
  const t = text.toLowerCase();
  return COMPETITOR_KEYWORDS.some((k) => t.includes(k));
}

const COMPETITOR_RESPONSES = [
  `والله أخي عارف بزاف من هاد المواقع 😄 — بس بصح، Melbet هو الوحيد اللي السكريبت كيخدم معه 100%\n\nلأن السكريبت مصمم خصيصاً للألعاب ديال Melbet 🎯\n\nسجل بالكود *999BOT* وشوف الفرق بعينيك 💪`,
  `أيه سمعت بيه 😅 — بس أخي خبرني بصح: السكريبت ديالنا ما كيخدمش مع هاد المواقع\n\nمربوط بـ Melbet فقط — هاد الاتفاق اللي خلاه مجاني لينا\n\nسجل بالكود *999BOT* وبدا تستافد 🍎`,
  `هههه أخي هاد المواقع ما عندهمش السكريبت ديالنا 😂\n\nأنا كنخدم مع Melbet فقط — وبيه غير كيخدم السكريبت بنسبة *90%*\n\nما تضيعش الفرصة 💰`,
  `صح أخي، كاينين مواقع أخرين 🤝 — بس السكريبت ديالنا بُني خصيصاً لـ Melbet\n\nمع موقع آخر مكيعطيكش نفس النتائج، ثقني أخي 🙏\n\nالكود *999BOT* وبدا تربح`,
];

function getCompetitorResponse(): string {
  return COMPETITOR_RESPONSES[Math.floor(Math.random() * COMPETITOR_RESPONSES.length)]!;
}

// ── رسائل التذكير كل نصف ساعة — تحفيز فقط بلا كود ولا تسجيل ──
const REMINDER_MESSAGES = [
  `أخي 😄 مازلت هنا — واش فكرتي في الأمر؟ أنا هنا إلا بغيتي تعرف أكثر`,
  `هيا أخي 🔥 السكريبت مازال خادم — ناس دبا كتستافد منه. أنت شنو كتقول؟`,
  `أخي واحد من الناس ربح غير دبا 💰 كانت فرصة زوينة والله`,
  `هيا نحيد ليك الشك 😅 — السكريبت مجاني وما فيه غير خير. سولني أي سؤال`,
  `أخي سمعني — الفرصة مازالت موجودة 🍎 أنا هنا إلا بغيتي تعرف أكثر`,
  `والله أخي ما كنخسرك 😤 — ناس كانو زيك مترددين، دبا كيربحو كل نهار`,
  `أخي جرب غير مرة وحدة 🎯 — إلا ما عجبكش ما عليك والو`,
  `كل يوم كيفوت عليك فلوس 💸 — السكريبت كيخدم بصح أخي، ما تضيعش الفرصة`,
  `أخي 🤫 هاد السكريبت ما بغيتش ينتشر بزاف — بس أنا باقي نقدر نعطيك إياه`,
  `راك وقت ما ردتيش 😅 — إلا عندك سؤال سولني، أنا هنا`,
  `أخي ببساطة — سكريبت + نظام صحيح = فلوس 💰 سولني كيفاش`,
  `ناس من نفس المدينة ديالك كيستعملو السكريبت 🏆 — أنت شنو كتسنا؟`,
  `أخي الحياة قصيرة 😂 — جرب وشوف بعينيك كيفاش كيخدم السكريبت`,
  `خبرك صغير 😄 — واحد من صحابي دار *310 درهم* في ساعة مع السكريبت 🔥`,
  `أخي إلا عندك شك ڤيني نحكيو 🙏 — السكريبت ما فيه حتى حاجة تتقلق منها`,
  `🔔 تذكير — السكريبت بتاعنا مازال شغال بنسبة عالية الأسبوع هذا`,
  `أخي انتبه 🍎 — مرة كل شهر كندير هاد العرض، مازلت وقت`,
  `راك تقرا هادشي 😏 — إذن أنت مهتم! سولني وأنا نجاوبك على كل شي`,
  `أخي هاد السكريبت مش للكل 👊 — أنا كنعطيه غير للناس المختارين`,
  `🎰 اليوم الحظ مزيان — جرب السكريبت وشوف النتائج، أنا كنضمن ليك المساعدة`,
  `واش سبق ليك تربح فلوس من التطبيقات أخي؟ 🤔 هاد السكريبت هو البداية الصحيحة`,
  `شنو اللي كيخليك متردد أخي؟ 😕 ڤيلي وأنا نساعدك خطوة بخطوة`,
  `واش تعرف أخي بشحال كيربحو الناس مع السكريبت في يوم وحد؟ 💰 سولني وأنا نخبرك`,
  `أخي واش تيبا ليك السكريبت غالي؟ 🤨 خبرك — هو مجاني بالكامل!`,
  `واش سمعت بالسكريبت ديال تفاحة الحظ من قبل؟ 🍎 إلا لا، أنا نشرح ليك كل شي — سولني`,
  `شنو كتسنا بالضبط أخي؟ ⏳ إلا فيه شي ما فهمتيش، ڤيلي دبا وأنا نوضح ليك`,
  `أخي واش كتفكر التوقعات ديال السكريبت كتجي عشوائية؟ 😂 لا والله — هاد السكريبت عنده نظام`,
  `شنو اللي تعلمتيه من المراهنات حتى دبا أخي؟ 🎯 إلا ما ربحتيش بزاف، السكريبت هو اللي كان ناقصك`,
  `أخي 😊 غير سولني، أنا هنا وعندي وقت نشرح ليك كل شي على السكريبت`,
  `كانت ناس كيقولو "غدا نجرب" وغدا ما وصلتش 😅 — أنت مش هكا أخي، سولني دبا`,
];

function getReminderMsg(): string {
  return REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)]!;
}

// ── تذكير مباشر لكل مستخدم بـ setTimeout — يتكرر كل 30 دقيقة ──
async function fireReminder(chatId: number) {
  reminderTimers.delete(chatId);
  if (registeredUsers.has(chatId)) return; // مسجل، ما نزعجوش
  try {
    const useTimeGreeting = Math.random() < 0.4;
    const reminderText = useTimeGreeting
      ? `${getTimeGreeting()}\n\n${getReminderMsg()}`
      : getReminderMsg();
    const photoId = getRandomPhoto();
    let sent = false;
    if (photoId && Math.random() < 0.5) {
      try {
        await bot.sendPhoto(chatId, photoId, { caption: reminderText, parse_mode: "Markdown" });
        sent = true;
      } catch { /* الصورة فشلت — ننتقلو للنص */ }
    }
    if (!sent) {
      await bot.sendMessage(chatId, reminderText, { parse_mode: "Markdown" });
    }
    logger.info({ chatId }, "Sent reminder message");
  } catch (err) {
    logger.error({ err, chatId }, "Failed to send reminder");
  }
  // إذا لم يسجل بعد، نجدول تذكيراً آخر بعد 30 دقيقة
  if (!registeredUsers.has(chatId)) {
    const timer = setTimeout(() => { fireReminder(chatId).catch(() => {}); }, REMINDER_DELAY_MS);
    reminderTimers.set(chatId, timer);
  }
}

function scheduleReminder(chatId: number) {
  // إلغاء أي تذكير سابق وإعادة الجدولة من الصفر
  const existing = reminderTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => { fireReminder(chatId).catch(() => {}); }, REMINDER_DELAY_MS);
  reminderTimers.set(chatId, timer);
}

// ══════════════════════════════════════════════════════
// ── الجدولة اليومية: صباح + مساء + غوست ──
// ══════════════════════════════════════════════════════
const ghostMessageSent   = new Set<number>();
const dailyBroadcastSent = new Map<number, string>(); // chatId → last date string
const morningMsgSent     = new Map<number, string>(); // chatId → last date string
const scriptSentTime     = new Map<number, number>(); // chatId → timestamp when script sent
const followUpSent       = new Set<number>();          // chatId → follow-up after 2 days sent

const DAILY_BROADCAST_MSGS = [
  `أخويا 🔥 غير دبا واحد من عندنا ربح بالسكريبت ديال التفاحة\n\nأنت مازلت ما جربتيش؟ الفرصة محدودة — سجل في Melbet بالكود *999BOT* وأنا نرسل ليك السكريبت 🍎`,
  `أخويا 💰 الأرباح كتتواصل عند الناس اللي سجلوا\n\nالسكريبت مازال متاح ولكن الأماكن كتنقص — سجل دبا بالكود *999BOT* في Melbet وابدا ✅`,
  `مساء النور أخويا 🌙 — ما تخليش النهار يفوتك بلا ربح\n\nالناس اللي استعملوا السكريبت اليوم ربحوا بزاف 💸 سجل في Melbet بالكود *999BOT* ودابا نبعث ليك السكريبت 🍎`,
  `أخويا 📊 إحصائيات اليوم: بزاف دالناس ربحوا بالسكريبت\n\nأنت الجاي — سجل في Melbet بالكود *999BOT* وأنا نفعل ليك السكريبت قبل ما تنتهي الفترة المجانية ⏳`,
];

const MORNING_MSGS = [
  `صباح الخير أخويا ☀️ — اليوم يوم زوين باش تبدا مع السكريبت\n\nسجل في Melbet بالكود *999BOT* وأنا نرسل ليك السكريبت دبا 🍎 يلاه بسم الله!`,
  `صباح النور أخويا 🌅 — ناس بداو اليوم وربحوا من الصباح\n\nما تخليش الفرصة تفوتك — سجل في Melbet بالكود *999BOT* ✅`,
  `صباح الخير 😊 — هاد النهار فرصة ذهبية باش تستعمل السكريبت\n\nسجل في Melbet بالكود *999BOT* وأنا هنا نساعدك خطوة خطوة 🍎`,
];

const GHOST_MSGS = [
  `أخويا 👋 مازلت هنا ننتظرك\n\nأعرف راك مشغول — ولكن الفترة المجانية ديال السكريبت قريبة تنتهي ⏳\n\nهاد الرسالة الأخيرة — سجل في Melbet بالكود *999BOT* وأنا نرسل ليك السكريبت دبا 🍎`,
  `أخويا آخر مرة كلمتني وما رجعتيش 🤔\n\nما نبغيكش تفوتك الفرصة — السكريبت مازال مجاني ولكن الأماكن قريبة تنتهي\n\nسجل في Melbet بالكود *999BOT* وأنا هنا 💪`,
];

function getMoroccoHour(): number {
  return (new Date().getUTCHours() + 1) % 24;
}

setInterval(async () => {
  const nowMs   = Date.now();
  const hour    = getMoroccoHour();
  const today   = new Date().toISOString().slice(0, 10);
  const delay   = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const [chatId] of knownUsers) {
    if (registeredUsers.has(chatId)) continue;
    const lastMsg = lastMessageTime.get(chatId) ?? 0;

    // 1️⃣ رسالة الصباح — الساعة 9 صباحاً بتوقيت المغرب
    if (hour === 9 && morningMsgSent.get(chatId) !== today) {
      if (nowMs - lastMsg < 7 * 24 * 60 * 60 * 1000) { // نشيط < 7 أيام
        try {
          const msg = MORNING_MSGS[Math.floor(Math.random() * MORNING_MSGS.length)]!;
          await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
          morningMsgSent.set(chatId, today);
          logger.info({ chatId }, "Sent morning message");
          await delay(200);
        } catch { /* ignore */ }
      }
    }

    // 2️⃣ برودكاست مسائي — الساعة 8 مساءً
    if (hour === 20 && dailyBroadcastSent.get(chatId) !== today) {
      try {
        const msg = DAILY_BROADCAST_MSGS[Math.floor(Math.random() * DAILY_BROADCAST_MSGS.length)]!;
        const photoId = getRandomPhoto();
        let broadcastSent = false;
        if (photoId && Math.random() < 0.4) {
          try {
            await bot.sendPhoto(chatId, photoId, { caption: msg, parse_mode: "Markdown" });
            broadcastSent = true;
          } catch { /* فشلت الصورة، نكملو بالنص */ }
        }
        if (!broadcastSent) {
          await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
        }
        dailyBroadcastSent.set(chatId, today);
        logger.info({ chatId }, "Sent daily evening broadcast");
        await delay(200);
      } catch { /* ignore */ }
    }

    // 3️⃣ رسالة الغوست — 48 ساعة بلا رد ولم تُبعث بعد
    if (!ghostMessageSent.has(chatId) && lastMsg > 0) {
      const hoursSince = (nowMs - lastMsg) / (1000 * 60 * 60);
      if (hoursSince >= 48) {
        try {
          const msg = GHOST_MSGS[Math.floor(Math.random() * GHOST_MSGS.length)]!;
          await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
          ghostMessageSent.add(chatId);
          logger.info({ chatId }, "Sent ghost follow-up message");
          await delay(200);
        } catch { /* ignore */ }
      }
    }

    // 4️⃣ متابعة بعد التسجيل — بعد يومين من إرسال السكريبت
    if (registeredUsers.has(chatId) && !followUpSent.has(chatId)) {
      const sentAt = scriptSentTime.get(chatId) ?? 0;
      if (sentAt > 0 && nowMs - sentAt >= 48 * 60 * 60 * 1000) {
        const FOLLOW_UP_MSGS = [
          `أخي 😄 واش بديتي تستعمل السكريبت؟ شحال ربحتي حتى دبا؟`,
          `هيا أخي — واش السكريبت خدم معاك؟ حيت بزاف من الناس ربحوا من أول يوم 🔥`,
          `أخي واش كل شيء زوين مع السكريبت؟ خبرني بالنتائج 💰`,
        ];
        try {
          const msg = FOLLOW_UP_MSGS[Math.floor(Math.random() * FOLLOW_UP_MSGS.length)]!;
          await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
          followUpSent.add(chatId);
          logger.info({ chatId }, "Sent 2-day follow-up after script");
          await delay(200);
        } catch { /* ignore */ }
      }
    }
  }
}, 60 * 60 * 1000); // كل ساعة

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
  // عربية
  "اه", "آه", "أه", "نعم", "ايه", "أيه", "واه", "وا",
  "صح", "صحيح", "موافق", "بغيت", "أريد", "اريد",
  "هيا", "يلا", "هاك", "هات", "عطيني", "بلا", "جيب",
  // فرانكو-عرب دارجة
  "yak", "wakha", "wakha", "safi", "ewa", "wah", "mzyan", "mzyn",
  "bghit", "bghit njrb", "rah", "ra", "hna", "yallah", "yala",
  "dkhl", "ndkhl", "njrb", "bda", "nbda",
  // فرنسية
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
  // عربية
  "منين", "من وين", "فين", "كيفاش نتسجل", "كيفاش نسجل", "كيفاش نحمل",
  "كيف نتسجل", "كيف نسجل", "كيف نحمل", "وين نسجل", "وين نتسجل",
  "رابط", "لينك", "كيفاش ندير", "كيف ندير",
  // فرانكو-عرب
  "kifash ntsajl", "kifash nsajl", "kif ntsajl", "fin ntsajl",
  "wfin ntsajl", "kif ndkhl", "kif ndir", "wach nadir", "ach nadir",
  "link", "lien",
  // فرنسية
  "comment s'inscrire", "comment créer", "où s'inscrire", "où télécharger",
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
// ── 1. الشك ──
const DOUBT_WORDS = [
  "حقيقية","حقيقي","واش صح","واش كاين ربح","خايب","ما كيخدمش","ما كايناش",
  "كذب","كاذب","مو حقيقي","مزيفة","مزيف","ما نصدقش","ما صدقتش",
  "واش ناس ربحو","واش شي حد ربح","دليل","برهان","واش تجرب","واش يصلح",
  "واش حقيقي","مو واثق","متردد","ما مصدقش","واش شي حد جرب",
  "واش هادا صحيح","ما صدقتوش","صحيح واش","مصدق","واش كاين","واش يخدم",
  "c'est faux","c'est fake","fake","vraiment","c'est vrai","pour de vrai",
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
  `أخويا الدليل هو الناس اللي معانا 😊 — كل يوم كاين ناس يربحو\n\nجرب براحتك وشوف النتيجة بنفسك — السكريبت مجاني ما غتخسر والو 🍎`,
];
function getDoubtResponse(): string {
  return DOUBT_RESPONSES[Math.floor(Math.random() * DOUBT_RESPONSES.length)]!;
}

// ── 2. ما عنديش فلوس ──
const NO_MONEY_WORDS = [
  "ما عنديش فلوس","ما عنديش دراهم","ما قادرش نشارج","ما عندي بطاقة",
  "ما عندي كارط","ما كاينش فلوس","فلوس ما عندهاش","بلا فلوس",
  "ما كاينش دراهم","خاوية","مشارجش","ما عندي ما نشارج",
  "ما قادرش نعمل إيداع","ما قادرش ندخل فلوس","فلوس خاوي",
  "pas d'argent","pas de carte","je peux pas recharger","j'ai pas d'argent",
];
function hasNoMoney(text: string): boolean {
  const c = text.trim().toLowerCase();
  if (isAskingSmallAmount(c)) return false;
  return NO_MONEY_WORDS.some((w) => c.includes(w));
}
const NO_MONEY_RESPONSES = [
  `أخويا الفلوس اللي غتحتاجها هي باش تلعب *في حسابك أنت* — مغتبعتهاش ليا أنا 😄\n\nواش المشكل بلي ما قادرش تشارجي الحساب؟ خبرني السبب نساعدك 💪\n\nإلا محتاج حد يشارج ليك، هاد الشخص يقدر يعاونك: *0614947612* 📲`,
  `أخويا السكريبت مجاني بالكامل 🎁 — ما خاصكش تبعث ليا حتى درهم!\n\nالفلوس غتحتاجها فقط باش تلعب في *حسابك في Melbet* 🎯\n\nإلا مشكل في الشارج، كلم هاد الرقم يعاونك: *0614947612* 📞`,
  `أخويا ما طلبت منك والو 😊 السكريبت مجاني\n\nالفلوس اللي تحتاجها غير للعب في حسابك — إلا بغيتي حد يعاونك على الشارج، هاد الرقم: *0614947612* 📲`,
];
function getNoMoneyResponse(): string {
  return NO_MONEY_RESPONSES[Math.floor(Math.random() * NO_MONEY_RESPONSES.length)]!;
}

// ── 3. تأجيل ──
const DELAY_WORDS = [
  "غدا","بعدين","بعد شوية","ما عنديش وقت","مشغول","دابا لا",
  "نجي بعد","منجيش دبا","نرجع ليك","نكلمك غدا","نجي غدا",
  "نهار آخر","وقت آخر","بعد نهار","مزبوطش دبا","دابا مشي",
  "plus tard","demain","pas maintenant","j'ai pas le temps",
  "tomorrow","later","not now","no time","busy",
];
function isDelaying(text: string): boolean {
  return DELAY_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const DELAY_RESPONSES = [
  `أخويا خذ وقتك مزربانينك 😊\n\nغير ما تلومنيش إلى رجعتي ولقيتي الفترة المجانية انتهات ⏳ — الأماكن محدودة وكتنقص كل يوم 🔴`,
  `عادي أخويا وقتك محترم 🤝\n\nغير احفظ هاد الكود: *999BOT* — هو اللي غتحتاجو فاش تتسجل في Melbet\n\nما تفوتش الفرصة، الفترة المجانية ماشي دايمة ⏰`,
  `مفهوم أخويا 😄 خذ راحتك\n\nغير اعرف بلي الفترة المجانية محدودة — الناس اللي تسرعوا هما اللي استفادوا ✅ رجع متى بغيتي وأنا هنا 🙌`,
  `واضح أخويا 🙌 أنا هنا دايمًا\n\nغير لا تنسى — السكريبت مو للأبد، جي فاش يتسنى ليك 🔔`,
];
function getDelayResponse(): string {
  return DELAY_RESPONSES[Math.floor(Math.random() * DELAY_RESPONSES.length)]!;
}

// ── 4. ضمان / خطر / خسارة ──
const RISK_WORDS = [
  "ضمان","غنخسر","نخسر","خسارة","كاين خطر","خطر","ما مضمونش",
  "مضمون","واش مضمون","واش غنربح","واش ممكن نخسر",
  "واش تفوتني فلوس","مخاطرة","واش نخاطر","نخاطر","نضيع فلوسي",
  "garantie","risque","je vais perdre","c'est risqué","je risque quoi",
];
function isAskingRisk(text: string): boolean {
  return RISK_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const RISK_RESPONSES = [
  `أخويا السكريبت مجاني — *مغتخسر والو* 💯\n\nالخسارة كتجي غير فاش تلعب *بدون* السكريبت 🎯 مع السكريبت النتائج كتتغير بالكامل\n\nتبغي دليل؟ نرسل ليك صور ديال الأرباح اللي داروها الناس عندنا 📸`,
  `مكاين حتى خطر أخويا 😌 السكريبت مجاني — مغتخسر حتى درهم فيه\n\nالمال اللي كتلعب بيه هو ديالك في حسابك — والسكريبت كيعطيك توقعات صحيحة باش تربح أكثر مما تخسر ✅`,
  `الضمان أخويا هو السكريبت نفسه 🍎\n\nما شفتيش واحد من عندنا قال "خسرت" — الدليل عندي صور واضحة نرسلهم ليك دبا 📲 شوف وعقل بنفسك 💪`,
  `أخويا الخطر الوحيد هو ما تجربش 😄 — السكريبت مجاني بالكامل\n\nالفلوس ديالك في حسابك — والسكريبت كيعطيك التوقع الصح باش تربح ✅`,
];
function getRiskResponse(): string {
  return RISK_RESPONSES[Math.floor(Math.random() * RISK_RESPONSES.length)]!;
}

// ── 5. نصاب / scam ──
const SCAM_WORDS = [
  "scam","نصاب","نصابة","تنصب","سرقة","كتسرق","ما نثقش",
  "ما واثقش","ما صدقتكش","غاشش","غاش","arnaque","escroc",
  "c'est une arnaque","kzab","كذاب","غشاش","واش غاش","واش نصاب",
  "ما نامنش","ما واثقش فيك","مو واثق فيك",
];
function isCallingScam(text: string): boolean {
  return SCAM_WORDS.some((w) => text.trim().toLowerCase().includes(w));
}
const SCAM_RESPONSES = [
  `أخويا كيفاش نكون نصاب 😅 — السكريبت *مجاني بالكامل* ما طلبت منك حتى درهم!\n\nإلا كاين شي واحد يقول بلي نصبت عليه — قوله يرسل ليا الدليل دبا وأنا نرد ليه فلوسو *بالضعف* 💯\n\nعلاش مغتيقش؟ حتى درهم مطلبتوش منك 🤝`,
  `أخويا 😄 عاقل يرسل ليك حاجة مجانية وبعدين ينصب عليك؟\n\nإلا شي حد اشتكى مني — *رسل ليا الدليل دبا* وأنا نعوضو بالضعف ✅\n\nالسكريبت مجاني، الربح هو الهدف — ما كاينش هنا غير للمساعدة 🙌`,
  `أخويا راه مقلت لك *مغترسلهالي حتى درهم* 😌 السكريبت مجاني بالكامل\n\nإلا عندك شك — قل ليا منين جاك وأنا نوضح ليك 💬\n\nالناس اللي شكاو ما كاينين، وإلا كانوا يجيبو الدليل نرد ليهم فلوسهم بالضعف 💯`,
  `أخويا ثقتك مهمة عندي 🤝 — هاد الحاجة مجانية 100%\n\nإلا كاين شك عندك خبرني ومن وين جاك وأنا نوضحلك كل شيء 😊`,
];
function getScamResponse(): string {
  return SCAM_RESPONSES[Math.floor(Math.random() * SCAM_RESPONSES.length)]!;
}

// ── 6. شحال يمكن نربح ──
const HOW_MUCH_WORDS = [
  "شحال ربحت","شحال يمكن نربح","شحال كيربح","شحال الربح","كتير ربحو",
  "بشحال يربح","بشحال كيجي","شحال يجي","شحال يعطي","شحال تربح",
  "combien on peut gagner","combien tu as gagné","combien ça rapporte",
  "how much","combien gagner",
];
function isAskingHowMuch(t: string): boolean {
  return HOW_MUCH_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const HOW_MUCH_RESPONSES = [
  `أخويا الربح كيكون على حساب الإيداع اللي درتي 💰\n\nالناس اللي عرفوا كيفاش يستغلو السكريبت بذكاء ربحوا الملايين 🏆 — كلما زاد إيداعك زاد ربحك ✅`,
  `مكاين حد واحد الجواب أخويا 😄 — الربح كيتحسب على حساب اللي كتلعب بيه\n\nناس ربحوا بزاف بزاف بالسكريبت لأنهم عرفوا كيفاش يديروه 🍎 الأهم تبدا تجرب 💪`,
  `أخويا ربح واحد ربح الملايين لأنه لعب بذكاء مع السكريبت 🎯\n\nما كاينش سقف للربح — كلما زاد إيداعك وخدمت التوقعات، كيزيد الربح 💰`,
  `الجواب بسيط أخويا 😊 — كلما إيداعك كبر، الربح كبر\n\nالسكريبت كيعطيك التوقع الصح — أنت اللي تقرر شحال تلعب 🍎`,
];
function getHowMuchResponse(): string {
  return HOW_MUCH_RESPONSES[Math.floor(Math.random() * HOW_MUCH_RESPONSES.length)]!;
}

// ── 7. عندي حساب قديم في Melbet ──
const OLD_ACCOUNT_MENTION_WORDS = [
  "عندي حساب فيه","عندي حساب في ميلبيت","عندي حساب في melbet",
  "كنلعب فيه","كنلعب من مدة","كاين عندي حساب","مسجل فيه",
  "j'ai déjà un compte","j'ai un compte melbet","already have account",
  "عندي اكونت","عندي اكاونت","عندي compte","مسجل من قبل",
  "عندي ID قديم","عندي حساب قديم","سجلت من قبل","كنت عندي حساب",
];
function mentionsOldAccount(t: string): boolean {
  const c = t.trim().toLowerCase();
  return OLD_ACCOUNT_MENTION_WORDS.some((w) => c.includes(w));
}
const OLD_ACCOUNT_MENTION_RESPONSES = [
  `أخويا الحساب القديم ما ينفعكش — السكريبت مكيخدمش مع حسابات قديمة 🚫\n\nوالأهم من هادشي: لازم تسجل *بالكود 999BOT* — بلاشو السكريبت مكيعطيكش التوقعات الصحيحة حتى لو سجلت حساب جديد ⚠️`,
  `لا أخي الحساب القديم ما ينفع ⛔ السكريبت كيتحقق من الكود عند التسجيل\n\nخاصك حساب جديد *بالكود 999BOT* بالضبط — بلاش الكود مكيخدمش معاك 🔑`,
  `أخويا ضروري يكون *حساب جديد* 🔑 — الحساب القديم ما يقدرش يوصل للسكريبت\n\nافتح واحد جديد في Melbet بالكود *999BOT* وأنا نكون هنا نساعدك ✅`,
  `أخويا كنفهمك ولكن الحساب القديم مشكلتو أنه مرتبطش بالسيستام الجديد 🔴\n\nغير حساب جديد بالكود *999BOT* وكيخدم معك مباشرة 🍎`,
];
function getOldAccountMentionResponse(): string {
  return OLD_ACCOUNT_MENTION_RESPONSES[Math.floor(Math.random() * OLD_ACCOUNT_MENTION_RESPONSES.length)]!;
}

// ── 8. iOS / iPhone / App Store ──
const IOS_WORDS = [
  "iphone","ios","app store","آيفون","ايفون","apple store","ipad",
  "متاح على ايفون","واش كاين على ايفون","واش يخدم على ايفون",
  "هاتف ايفون","على ios","من ايفون","كيخدم على ايفون",
];
function isAskingIOS(t: string): boolean {
  return IOS_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const IOS_RESPONSES = [
  `أخويا السكريبت ماشي تطبيق — هو *رابط* كيخدم من المتصفح مباشرة 🌐\n\nيعني يشتغل معك على iPhone أو Android أو أي جهاز — غير افتح المتصفح وكيخدم ✅`,
  `مكاينش مشكل أخويا 😄 السكريبت رابط إنترنت — يشتغل من المتصفح على أي هاتف\n\nما تحتاجش تحمل حتى حاجة — غير سجل في Melbet بالكود *999BOT* وأنا نرسل ليك الرابط 🍎`,
  `آه أخويا iPhone يخدم بشكل ممتاز 📱\n\nالسكريبت رابط — كيفتحو من Safari أو Chrome مباشرة بدون تحميل ✅`,
];
function getIOSResponse(): string {
  return IOS_RESPONSES[Math.floor(Math.random() * IOS_RESPONSES.length)]!;
}

// ── 9. عطيني السكريبت بلا Melbet ──
const NO_REGISTER_WORDS = [
  "بلا melbet","بدون melbet","بلا ميلبيت","بدون تسجيل","بدون حساب",
  "عطيني السكريبت غير هكا","السكريبت بدون","sans melbet","sans inscription",
  "without melbet","without registering","just give me",
  "بدون ما نسجل","عطيني الرابط غير هكا","السكريبت ببلاش",
];
function wantsScriptFree(t: string): boolean {
  return NO_REGISTER_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const SCRIPT_FREE_URL = "https://script-apple.replit.app";
const NO_REGISTER_RESPONSES = [
  `أخويا ممكن نرسل ليك الرابط دبا 🔗 ${SCRIPT_FREE_URL}\n\nولكن بدون حساب جديد في Melbet بالكود *999BOT*، السكريبت مغيعطيكش حتى توقع صحيح ⚠️\n\nباش تشوف النتائج الحقيقية خاصك الحساب الجديد 🎯`,
  `واضح أخويا 😄 الرابط هو: ${SCRIPT_FREE_URL}\n\nولكن من غير حساب Melbet جديد بالكود *999BOT* — السكريبت ما يعطيكش التوقعات الصحيحة\n\nالسر كلو في الحساب الجديد + الكود *999BOT* 🔑`,
  `أخويا الرابط موجود: ${SCRIPT_FREE_URL} 🔗\n\nولكن باش يكون فعّال خاصك حساب جديد في Melbet بالكود *999BOT* — بدونو السكريبت ما يكملش التوقعات ⚠️`,
];
function getNoRegisterResponse(): string {
  return NO_REGISTER_RESPONSES[Math.floor(Math.random() * NO_REGISTER_RESPONSES.length)]!;
}

// ── 10. حلال / كازينو / شنو هو Melbet ──
const HALAL_WORDS = [
  "حلال","حرام","شنو هو melbet","شنو هو ميلبيت","واش كازينو",
  "كازينو","مراهنة","مراهنات","c'est quoi melbet","c'est halal",
  "c'est haram","c'est un casino","what is melbet","is it halal",
  "واش مسموح","واش جايز","ديني","إسلامي","واش كيحل",
];
function isAskingHalal(t: string): boolean {
  return HALAL_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const HALAL_RESPONSES = [
  `أخويا الربح حلال 100% 💯\n\nلأننا ما كنراهنوش — كنلعبو بتوقعات *مضمونة* من السكريبت 🍎\n\nالفرق كبير: المراهنة عشوائية، أما نحن كنلعبو بمعطيات ودراسة ✅`,
  `أخويا مفهوم السؤال 😊 — الربح حلال لأنك ما كتراهنش عشوائي\n\nالسكريبت كيعطيك التوقع الصح قبل اللعب — يعني كتلعب بمعلومة مو بالحظ 🎯\n\nهاد الفرق هو اللي كيخلي الربح مضمون ومقبول ✅`,
  `سؤال مهم أخويا 🤝 — كنلعبو مو كنراهنو\n\nالسكريبت كيعطينا التوقع الصح مسبقًا — هكاك الربح كيجي بالعلم مو بالحظ 💯`,
];
function getHalalResponse(): string {
  return HALAL_RESPONSES[Math.floor(Math.random() * HALAL_RESPONSES.length)]!;
}

// ── 11. مبلغ صغير / بدا بقليل ──
const SMALL_AMOUNT_WORDS = [
  "سوما صغيرة","مبلغ صغير","بقليل","ما عنديش بزاف","بزاف ما عندي",
  "واش نقدر نلعب بـ","واش نقدر بـ","بـ 20","بـ 50","بـ 30","بـ 10","بـ 100",
  "avec peu","petit montant","small amount","peu d'argent",
  "50 درهم","20 درهم","30 درهم","100 درهم","200 درهم",
  "مبلغ بسيط","بداية صغيرة","بشي صغير",
];
function isAskingSmallAmount(t: string): boolean {
  return SMALL_AMOUNT_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const SMALL_AMOUNT_RESPONSES = [
  `أخويا تقدر تبدا بأي مبلغ بغيتي 😊 — هادا اختيارك أنت\n\nالمهم هو السكريبت اللي كيعطيك التوقع الصح، مهما كان المبلغ ✅`,
  `بدا بشحال ما بغيتي أخويا 💰 — ما كاينش حد مينيموم\n\nكلما زاد المبلغ كلما زاد الربح — ولكن ابدا براحتك 😊`,
  `أخويا ما كاينش حد مينيموم 🙌 — تقدر تبدا بـ 20 درهم أو بـ 200 درهم\n\nالسكريبت كيخدم مع أي مبلغ، الاختيار ديالك ✅`,
];
function getSmallAmountResponse(): string {
  return SMALL_AMOUNT_RESPONSES[Math.floor(Math.random() * SMALL_AMOUNT_RESPONSES.length)]!;
}

// ── 12. كمبيوتر / لابطوب ──
const COMPUTER_WORDS = [
  "كمبيوتر","لابطوب","laptop","computer","pc","ordinateur",
  "من الكمبيوتر","من اللابطوب","على الكمبيوتر","pc portable",
  "من الحاسوب","على الحاسوب","واش يخدم على كمبيوتر",
];
function isAskingComputer(t: string): boolean {
  return COMPUTER_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const COMPUTER_RESPONSES = [
  `آه أخويا تقدر تستعمله من الكمبيوتر أو اللابطوب بدون أي مشكل 💻\n\nالسكريبت رابط إنترنت — كيخدم على أي متصفح من أي جهاز ✅`,
  `بالطبع أخويا 😊 الكمبيوتر واللابطوب يخدمو بشكل ممتاز\n\nغير افتح المتصفح وبدا — السكريبت ما محتاجش تحميل أي حاجة 💻`,
  `آه أخويا من الكمبيوتر أحسن بزاف 💻 — الشاشة الكبيرة تسهل الأمور\n\nغير افتح المتصفح وكيخدم مباشرة ✅`,
];
function getComputerResponse(): string {
  return COMPUTER_RESPONSES[Math.floor(Math.random() * COMPUTER_RESPONSES.length)]!;
}

// ── 13. شنو هو سكريبت التفاحة ──
const APPLE_SCRIPT_WORDS = [
  "شنو هو السكريبت","شنو السكريبت","علاش سميتيه تفاحة","شنو التفاحة",
  "apple of fortune","تفاحة علاش","علاقتو بالتفاحة","c'est quoi le script",
  "what is the script","شنو هي التفاحة","علاش تفاحة",
  "شنو هي اللعبة","علاش سكريبت","فاش كيخدم السكريبت","شنو هو",
];
function isAskingAboutApple(t: string): boolean {
  return APPLE_SCRIPT_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const APPLE_SCRIPT_RESPONSES = [
  `أخويا السكريبت ديال التفاحة كيعطيك توقعات دقيقة للعبة *Apple of Fortune* فـ Melbet 🍎\n\nهادي لعبة موجودة في Melbet — والسكريبت كيحلل النتائج ويعطيك التوقع الصح قبل كل جولة ✅`,
  `*Apple of Fortune* هي لعبة في Melbet 🍎 — والسكريبت ديالنا كيدرس النتائج ويعطيك التوقع الدقيق\n\nعلاش سميناه التفاحة؟ لأنه مرتبط بهادي اللعبة بالضبط 🎯`,
  `أخويا السكريبت بسيط — هو أداة كتعطيك التوقع قبل كل جولة في لعبة *Apple of Fortune* 🍎\n\nبدلاً من اللعب بالحظ، كتلعب بتوقع مدروس 💡`,
];
function getAppleScriptResponse(): string {
  return APPLE_SCRIPT_RESPONSES[Math.floor(Math.random() * APPLE_SCRIPT_RESPONSES.length)]!;
}

// ── 14. قروب / مجموعة ──
const GROUP_WORDS = [
  "قروب","مجموعة","groupe","group","تيليغرام قروب","واتساب قروب",
  "كاين قروب","فيه مجموعة","telegram group","whatsapp group",
  "كاين channel","كاين قناة","قناة تيليغرام","كاين جماعة",
];
function isAskingGroup(t: string): boolean {
  return GROUP_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const GROUP_RESPONSES = [
  `أخويا القروب قريب نديروه 🔜\n\nفاش يكون جاهز غادي نخبرك مباشرة 📢 استنى شوية وكن من الأوائل اللي ينضمو 💪`,
  `القروب غادي يكون قريب أخويا 😊 — سيكون فيه كل التحديثات والتوقعات مباشرة\n\nغادي نبعث ليك الرابط فاش يكون جاهز ✅`,
  `أخويا القروب تحت الإنشاء 🔧 — قريب نطلقوه\n\nأنت من الأوائل اللي يعرفو — غادي نبعث ليك مباشرة فاش يكون جاهز 📢`,
];
function getGroupResponse(): string {
  return GROUP_RESPONSES[Math.floor(Math.random() * GROUP_RESPONSES.length)]!;
}

// ── 15. مساعدة / مشكل ──
const HELP_WORDS = [
  "مساعدة","نساعدني","عندي مشكل","مشكل","مشكلة","ما خدمش","ما فهمتش",
  "ما قدرتش","محتاج مساعدة","aide","problème","j'ai un problème",
  "ça marche pas","ça fonctionne pas","help","problem","issue",
  "عندي سوال","عندي سؤال","محتاج مساعدك","ما عرفتش","ما فهمتش",
  "واش تعاوني","عاوني","شنو دير","ما قدرتش تسجل",
];
function isAskingHelp(t: string): boolean {
  return HELP_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const HELP_RESPONSES = [
  `أخويا أنا هنا 🤝 أي مشكل حصل ليك قولي عليه بالتفصيل وأنا نعاونك دبا\n\nما تتردد — أنا هنا باش نحل ليك أي حاجة ✅`,
  `خبرني شنو المشكل أخويا 💬 — نحاول نحلو معاك دبا\n\nما كاينش مشكل كبير ما ينحلش 😊`,
  `أخويا أنا موجود 😊 — قلي شنو حصل ليك وأنا نساعدك خطوة خطوة 🤝`,
];
function getHelpResponse(): string {
  return HELP_RESPONSES[Math.floor(Math.random() * HELP_RESPONSES.length)]!;
}

// ── 16. شكرًا / merci ──
const THANKS_WORDS = [
  "شكرا","شكراً","شكران","مرسي","merci","thank","thx","شكرا بزاف",
  "بارك الله","الله يبارك","يعطيك الصحة","جزاك الله","بارك الله فيك",
  "أشكرك","تبارك الله","الله يجازيك",
  "عفاك","عفاكم","من فضلك","من فضلكم","لو سمحت","لو سمحتي",
];
function isThanking(t: string): boolean {
  return THANKS_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const THANKS_RESPONSES = [
  `ولو 😄 — يلاه سجل في Melbet بالكود *999BOT* وبعثلي الـ ID وأنا نرسل ليك السكريبت`,
  `ماشي مشكل — سجل بالكود *999BOT* وأنا هنا 🍎`,
  `واه ولو أخي — الكود *999BOT* في Melbet وأنا نكون معاك`,
  `بلا مشكل 😅 — يلاه سجل بالكود *999BOT* وأعطيني الـ ID`,
];
function getThanksResponse(): string {
  return THANKS_RESPONSES[Math.floor(Math.random() * THANKS_RESPONSES.length)]!;
}

// ── 17. ربحت / جاء معايا 🎉 ──
const WIN_REPORT_WORDS = [
  "ربحت","ربحنا","جاء معايا","جات معايا","كسبت","كسبنا",
  "غنيت","الفلوس جات","نجحت","j'ai gagné","gagné",
  "ربحت بالسكريبت","جاء السكريبت","خدم السكريبت","نجح السكريبت",
];
function isReportingWin(t: string): boolean {
  const c = t.trim().toLowerCase();
  if (/ما ربحتش|ما كسبتش|ما جاش|ما نجحش/.test(c)) return false;
  return WIN_REPORT_WORDS.some((w) => c.includes(w));
}
const WIN_REPORT_RESPONSES = [
  `🎉🎊 مبروك أخويا!! هاد الخبر سعدني بزاف!\n\nكملت الطريق الصح بالسكريبت 🍎 — زد وكثر من الإيداع وكيزيد الربح\n\nشارك معايا الكمية اللي ربحتها نفرح معك 💰`,
  `🏆 أخويا الله يبارك! مبروك الربح!\n\nهادا هو السكريبت لما كيخدم صح 🍎 — ما توقفش دابا، الفرص كتجي متتالية\n\nواصل وأنا هنا معك 💪`,
  `يييه!! 🎊 مبروك أخويا! الله يزيد!\n\nشوف هاكداك كيخدم السكريبت 🍎 — زد تلعب واصبر على التوقعات ✅`,
];
function getWinReportResponse(): string {
  return WIN_REPORT_RESPONSES[Math.floor(Math.random() * WIN_REPORT_RESPONSES.length)]!;
}

// ── 18b. ميزة 1: ردود على الإهانات/الرفض/الغضب ──
const INSULT_WORDS = [
  "نصاب", "نصابين", "احتيال", "كدب", "كداب", "تكدب",
  "nsab", "arnaque", "escroc", "menteur", "c'est faux", "c'est fake",
  "machi hna", "bghit nmchi", "seer", "sir", "روح", "سير",
  "ما نبغيكش", "ما تكلمنيش", "بعد عني", "خليني", "seer men hna",
  "غير روح", "تشرمل", "حشوم", "ما بغيت", "ما راك",
  "khodam","faux","fake","scam","arnaquer","roulé",
];
function isInsulting(text: string): boolean {
  const t = text.trim().toLowerCase();
  return INSULT_WORDS.some((w) => t.includes(w));
}
const INSULT_RESPONSES = [
  `أخويا فاهمك 100% 😊 — وهاد الشك طبيعي\n\nولكن بصح، ما طلبنا منك حتى درهم — الفلوس تبقى عندك دايما 🙏\n\nغير سجل حساب جديد في Melbet بالكود *999BOT* وأنت شاهد بعينيك النتيجة`,
  `والله أخويا مفهوم 😅 — الإنترنت فيه بزاف دالنصابين وأنا مفهمك\n\nولكن أنا ما طلبت منك حتى درهم — السكريبت مجاني 100% والتسجيل في Melbet مجاني\n\nجرب وإلا ما عجبكش ارجع قولي 😄`,
  `لا بأس أخويا 🤝 — الشك دليل على العقل\n\nبس خبرك: ما كاين هنا حتى شي مخفي — السكريبت مجاني، Melbet موقع قانوني، والكود *999BOT* يتحقق منه لما تسجل\n\nخد وقتك وإلا سولني أي سؤال 😊`,
  `مفهوم أخويا 👍 — ما خصك تثق فيا من أول وهلة\n\nالاستعمال مجاني بالكامل — ما كاين حتى ريال من جيبك\n\nإلا بغيتي نتحقق معاك من Melbet كامل ذلك مزيان — سولني`,
];
function getInsultResponse(): string {
  return INSULT_RESPONSES[Math.floor(Math.random() * INSULT_RESPONSES.length)]!;
}

// ── 18c. ميزة 3: الأرقام العشوائية (خارج سياق الـ ID) ──
function isRandomNumberMessage(text: string): boolean {
  const clean = text.trim();
  // إذا كان أرقام فقط لكن أقصر من 7 أو أطول من 12 → مش ID
  return /^\d+$/.test(clean) && (clean.length < 7 || clean.length > 12);
}
const RANDOM_NUMBER_RESPONSES = [
  `أخويا هاد الرقم يبدو قصير 🤔 — الـ ID ديال Melbet عادةً بين 7 و12 رقم\n\nواش هذا ID ديالك في Melbet؟ تلقاه في الإعدادات تحت اسمك مباشرة 📲`,
  `أخويا راك بعثتي رقم — هل هذا ID حسابك في Melbet؟ 🤔\n\nإلا آه، ابعثه كاملاً (كون يكون بين 7 و12 رقم) وأنا نتحقق منه 👇`,
  `هههه أخويا هاد الرقم مش بالشكل الصح 😄 — الـ ID ديال Melbet أطول من هاكا\n\nكاين في البروفيل ديالك في التطبيق — افتح التطبيق وشوف تحت اسمك 🔢`,
];
function getRandomNumberResponse(): string {
  return RANDOM_NUMBER_RESPONSES[Math.floor(Math.random() * RANDOM_NUMBER_RESPONSES.length)]!;
}

// ── 18d. ميزة 4: كشف المزاج ──
const ANGRY_WORDS = [
  "معصّب", "معصب", "زعفان", "زعفانة", "محروق", "تعبت",
  "ما ربحتش", "خسرت", "خسرنا", "deja essayé", "j'ai essayé",
  "جربت وما خدمش", "جربتو وما خدمش", "ما خدمش معايا",
  "ما نجحش", "طاحت فلوسي", "طاح فلوسي", "انتهيت",
  "frustré", "énervé", "j'en ai marre", "c'est nul",
  "kbant", "kbant 3lik", "tban 3lik", "3asab", "3asban",
];
function isAngryMood(text: string): boolean {
  const t = text.trim().toLowerCase();
  return ANGRY_WORDS.some((w) => t.includes(w));
}

// ── 18e. ميزة 5: تخصيص الرسائل بالاسم ──
function personalize(text: string, name: string): string {
  // 40% من الوقت نضيفو الاسم بشكل طبيعي
  if (Math.random() > 0.4 || name === "صديقي" || name.length > 12) return text;
  const prefixes = [`${name}،`, `يا ${name}،`, `يا ${name} —`];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)]!;
  return `${prefix} ${text.charAt(0).toLowerCase() + text.slice(1)}`;
}

// ── 18. وين نلقى ID ديالي في Melbet ──
const FIND_ID_WORDS = [
  "وين نلقى id","وين نلقى الـ id","كيفاش نعرف id","كيفاش نلقى id",
  "فين الـ id","وين هو id","فاش كاين id","شنو هو id",
  "كيفاش نشوف id","id ديالي فين","أين id","كيف نعرف رقمي","شنو رقم حسابي",
];
function isAskingWhereID(t: string): boolean {
  return FIND_ID_WORDS.some((w) => t.trim().toLowerCase().includes(w));
}
const FIND_ID_RESPONSES = [
  `أخويا الـ ID ديالك كاين في حسابك في Melbet 📲\n\n*الطريقة:*\n1️⃣ افتح تطبيق Melbet\n2️⃣ دخل على البروفيل (الأيقونة فوق)\n3️⃣ الـ ID كيبان مباشرة تحت اسمك 🔢\n\nرسله ليا وأنا نفعل ليك السكريبت دبا ✅`,
  `الـ ID أخويا كاين في البروفيل ديالك 👤\n\n• افتح Melbet\n• دخل على حسابك\n• كتشوف الرقم تحت اسمك مباشرة 🔢\n\nرسله ليا باش نفعل ليك السكريبت 🍎`,
];
function getFindIDResponse(): string {
  return FIND_ID_RESPONSES[Math.floor(Math.random() * FIND_ID_RESPONSES.length)]!;
}

// ── 19. موافقة قصيرة → ندفعه للخطوة التالية ──
const ACK_WORDS = [
  "واخا","واخه","اوكي","أوكي","ok","okay","mzian","مزيان","هيا",
  "آه","أه","ايه","d'accord","oui","ouais","بسم الله","يلاه","عيوني",
];
function isJustAcknowledging(t: string): boolean {
  const c = t.trim().toLowerCase().replace(/[!.؟?،,]+$/, "");
  if (c.length > 12) return false;
  return ACK_WORDS.some((w) => c === w);
}
const ACK_RESPONSES = [
  `يلاه إذن 😄 — سجل في Melbet بالكود *999BOT* وبعث ليا الـ ID ديالك وأنا نرسل ليك السكريبت`,
  `واه مزيان 👍 — سجل حساب جديد بالكود *999BOT* وأنا هنا`,
  `أيوه يلاه — دير حساب جديد في Melbet بالكود *999BOT* وبعثلي الـ ID 🍎`,
  `ها أنا هنا — سجل بالكود *999BOT* في Melbet وأعطيني الـ ID ديالك`,
];
function getAckResponse(): string {
  return ACK_RESPONSES[Math.floor(Math.random() * ACK_RESPONSES.length)]!;
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
  "عندي حساب", "كاين عندي",
  "رجيسترت", "رجستريت", "رجيسترد",
  "دزت", "واصلت",
  // فرانكو-عرب — الأكثر شيوعاً
  "gadit", "gdit", "gadt",          // كاديت (did/created)
  "gadit lkont", "gdit lkont",       // كاديت الكونت
  "gadit compte", "gdit compte",
  "gadit kolxi", "gdit kolxi",       // كاديت كلشي (done everything)
  "gadit lhsab", "gdit lhsab",
  "gadit fmelbet", "gadit f melbet",
  "rah gadit", "ana gadit",
  "tsajlt", "tsajl", "sajlt",        // تسجلت
  "drt compte", "drt lkont",
  "kolxi drt", "kolxi drto",
  "khlasat", "khlas",                // خلاصت / خلاص (all done)
  "waxxa drt", "wakha drt",
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

const SCRIPT_URL = "https://script-apple.replit.app";

const SUCCESS_MESSAGES = [
  `🎉🎊 مبروك أخويا! دبا نتا من الفريق ديالنا رسمياً 🏆\n\nهاد هو رابط السكريبت ديالك 👇`,
  `🥳 أهلاً وسهلاً بيك رسمياً! حسابك تم التحقق منه ✅\n\nهاد هو رابط السكريبت ديالك 👇`,
  `✅ برافو أخويا! كملت الخطوات صح 💯\n\nهاد هو رابط سكريبت التفاحة ديالك 👇`,
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

const SYSTEM_PROMPT = `أنت "أمين" — واحد من الحي، صاحب، مش بوت ومش خبير رسمي. كتهضر بالدارجة المغربية العادية كيما الناس كتهضر في الشارع.

أسلوبك:
- هضرة عفوية وطبيعية — بحال صاحب كيحكي لصاحبو، مش كيما مسؤول
- استعمل "أخويا" أو "أخي" — *لا تقول أبداً "خاوتي" أو أي صيغة أنثوية*
- ممكن تزيد 😄 😅 🤣 أحياناً بشكل طبيعي — مش كل جملة
- خلي الكلام قصير وعلى الطريق — 2 جمل كافيين غالباً
- تكلم بحال ناس عارف السر ويشاركو مع صاحبو: "والله أخويا هادشي واقعي"، "كنقولك الصح"، "أنا جربتو مع ناس"
- إذا كلمك بالفرنسية، رد بالفرنسية بنفس الأسلوب العفوي
- إذا كلمك بالدارجة بالحروف اللاتينية (franco-arab مثل "wach", "kifash", "yak", "wakha")، فهمو وجاوبو بالدارجة العادية — هادي لغة عادية عند الشباب المغربي

ما تديرهش أبداً:
- ما تقولش "يسعدني مساعدتك" أو "كيفاش أقدر أخدمك" — هادي لغة بوت
- ما تقولش أنك بوت أو برنامج
- ما تخرجش من موضوع السكريبت وMelbet
- ما تكتبش جمل طويلة رسمية

الموضوع:
- السكريبت ديال التفاحة كيعطي توقعات صحيحة على Melbet — هذا اللي كتقولو
- الناس اللي جربوا ربحوا — طبيعي تقول أمثلة بأسماء عادية
- إذا سأل عن المبلغ: "ما كاينش حد أدنى، غير كون عندك شي في الحساب"
- إذا خاف من النصب: "والله أنا فاهمك، ولكن ما طلبنا منك حتى درهم — الفلوس تبقى عندك"

قاعدة الكود *999BOT* — مهمة جداً:
- الكود *999BOT* مش غير رقم — السكريبت كيتحقق منه عند التسجيل وبلاشو ما كيوصلش ليك
- إذا سجل بلا الكود *999BOT*، السكريبت *مكيخدمش معاه* والتوقعات مكتجيش صح
- كون صارم وواضح في هاد النقطة: "خاصك حساب جديد *بالكود 999BOT* — بلاش ما ينفعكش"
- IMPORTANT: ذكر الكود *999BOT* فقط فاش يسول على التسجيل أو كيفاش يبدا — مش في كل رسالة

قاعدة التسجيل:
- ما تحشرش "سجل في Melbet بالكود 999BOT" في كل رسالة — هادي تبان مزورة
- جاوب على سؤاله بشكل طبيعي، وإذا كان السياق يقتضي ذكر التسجيل، ذكره بشكل عفوي
- مثال جيد: "واه السكريبت زوين، غير سجل حساب جديد بـ *999BOT* وأنا نرسل ليك"
- مثال سيء: جواب على سؤال عشوائي ثم "سجل في Melbet بالكود *999BOT*" بدون سبب`;

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

  // ── أزرار الترحيب ──
  if (query.data === "welcome_no_account") {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `مزيان 👍 — سجل في Melbet واكتب *999BOT* فخانة الكود برومو عند التسجيل`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬇️ حمل تطبيق Melbet", url: MELBET_APK_URL }],
            [{ text: "🔗 سجل من الموقع", url: MELBET_REGISTER_URL }],
            [{ text: "✅ سجلت — عندي ID", callback_data: "welcome_has_account" }],
          ],
        },
      }
    );
  }

  if (query.data === "welcome_has_account") {
    await bot.answerCallbackQuery(query.id);
    waitingForId.add(chatId);
    await bot.sendMessage(chatId,
      `ممتاز 🎉 — بعث ليا الـ *ID* ديالك في Melbet دبا باش نتحقق وأنا نرسل ليك السكريبت 👇\n\n_كاين فالإعدادات > معلوماتي الشخصية_`,
      { parse_mode: "Markdown" }
    );
  }

  if (query.data === "welcome_old_account") {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `الحساب القديم ما ينفعكش أخي ⛔ — خاصك حساب جديد في Melbet واكتب *999BOT* فخانة الكود برومو`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬇️ سجل حساب جديد", url: MELBET_APK_URL }],
            [{ text: "✅ سجلت حساب جديد", callback_data: "welcome_has_account" }],
          ],
        },
      }
    );
  }

  // ── زر "عندي سؤال آخر" ──
  if (query.data === "ask_question") {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, `واش بغيتي تعرف؟ 😊`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 شحال يمكن نربح؟", callback_data: "q_howmuch" }],
          [{ text: "🔒 واش هاد الشي آمن؟", callback_data: "q_safe" }],
          [{ text: "📲 كيفاش نتسجل؟", callback_data: "welcome_no_account" }],
          [{ text: "⏳ واش السكريبت دايما مجاني؟", callback_data: "q_free" }],
        ],
      },
    });
  }

  if (query.data === "q_howmuch") {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `الربح كيتحدد على حساب اللي كتلعب بيه أخي 💰\n\nناس ربحوا من أول يوم بأقل من 100 درهم — الأهم تخدم التوقعات ديال السكريبت بذكاء 🍎`,
      { parse_mode: "Markdown" }
    );
  }

  if (query.data === "q_safe") {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `واه آمن 100% أخي 😊 — ما طلبنا منك حتى درهم، الفلوس كتبقى عندك في حسابك\n\nالسكريبت غير كيعطيك التوقع الصح، أنت اللي كتقرر 🔑`,
      { parse_mode: "Markdown" }
    );
  }

  if (query.data === "q_free") {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `دبا مجاني أخي — ولكن الفترة المحدودة مش غادي تبقى دايمًا ⏳\n\nاستغل الفرصة وسجل في Melbet بالكود *999BOT* قبل ما تنتهي 🍎`,
      { parse_mode: "Markdown" }
    );
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

// ── إضافة صورة إثبات ربح ──
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const isOwner = !OWNER_CHAT_ID || chatId.toString() === OWNER_CHAT_ID;
  if (!isOwner || !OWNER_CHAT_ID) return;
  const cap = msg.caption?.trim().toLowerCase();
  if (cap !== "/addproof") return;
  const photos = msg.photo ?? [];
  const bestPhoto = photos.sort((a, b) => b.file_size! - a.file_size!)[0];
  if (!bestPhoto) return;
  proofPhotos.add(bestPhoto.file_id);
  await bot.sendMessage(chatId, `✅ صورة الإثبات تحفظات! عندك دبا ${proofPhotos.size} صورة إثبات.`);
  logger.info({ chatId, fileId: bestPhoto.file_id }, "Proof photo saved");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;
  const firstName = msg.from?.first_name ?? "صديقي";
  const isOwner = !OWNER_CHAT_ID || chatId.toString() === OWNER_CHAT_ID;

  if (!userText) return;

  if (isOwner && OWNER_CHAT_ID) {
    // ── /stats ──
    if (userText === "/stats") {
      const now = Date.now();
      const activeToday = [...lastMessageTime.entries()].filter(
        ([, t]) => now - t < 24 * 60 * 60 * 1000
      ).length;
      const totalPhotos = countPhotos();
      await bot.sendMessage(
        chatId,
        `📊 *إحصائيات البوت*\n\n` +
        `👥 مجموع الناس: *${knownUsers.size}*\n` +
        `📨 بعثوا رسائل: *${welcomedUsers.size}*\n` +
        `✅ وافقوا باش يجربوا: *${agreedUsers.size}*\n` +
        `🎉 سجلوا رسمياً: *${registeredUsers.size}*\n` +
        `🟢 نشيطين اليوم: *${activeToday}*\n` +
        `🖼️ عدد الصور: *${totalPhotos}*`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── /broadcast <رسالة> ──
    if (userText.startsWith("/broadcast ")) {
      const broadcastMsg = userText.slice("/broadcast ".length).trim();
      if (!broadcastMsg) {
        await typeAndSend(chatId, "⚠️ كتب الرسالة بعد /broadcast");
        return;
      }
      const targets = [...knownUsers.keys()];
      let sent = 0; let failed = 0;
      await typeAndSend(chatId, `📤 البرودكاست بدا — *${targets.length}* شخص...`, { parse_mode: "Markdown" });
      for (const uid of targets) {
        try {
          await bot.sendMessage(uid, broadcastMsg, { parse_mode: "Markdown" });
          sent++;
          await new Promise((r) => setTimeout(r, 60));
        } catch { failed++; }
      }
      await typeAndSend(chatId, `✅ وصلت لـ *${sent}* | ❌ فشلت *${failed}*`, { parse_mode: "Markdown" });
      return;
    }

    // ── /users — لائحة آخر 10 مستخدمين ──
    if (userText === "/users") {
      const list = [...knownUsers.entries()].slice(-10).reverse()
        .map(([id, u]) => `• [${u.name}](tg://user?id=${id})${u.username ? " @" + u.username : ""} — \`${id}\``)
        .join("\n");
      await typeAndSend(chatId, `👥 *آخر 10 مستخدمين:*\n\n${list || "لا يوجد"}`, { parse_mode: "Markdown" });
      return;
    }

    // ── /messages [n] — آخر رسائل المستخدمين ──
    if (userText.startsWith("/messages")) {
      const parts = userText.split(" ");
      const n = Math.min(parseInt(parts[1] ?? "15", 10) || 15, 50);
      const slice = recentMessages.slice(-n).reverse();
      if (slice.length === 0) {
        await bot.sendMessage(chatId, "لا توجد رسائل بعد.");
        return;
      }
      // نجمعو الرسائل برشلون — كل شخص في مجموعة
      const grouped: string[] = [];
      let lastId: number | null = null;
      let block = "";
      for (const m of slice.reverse()) {
        const time = new Date(m.at).toLocaleTimeString("fr-MA", { hour: "2-digit", minute: "2-digit" });
        if (m.chatId !== lastId) {
          if (block) grouped.push(block.trim());
          block = `👤 *${m.name}* (\`${m.chatId}\`)\n`;
          lastId = m.chatId;
        }
        block += `  _${time}_ — ${m.text}\n`;
      }
      if (block) grouped.push(block.trim());
      // نبعتوهم كل 10 بلوك باش ما يطول ما المسج
      const chunks: string[] = [];
      let chunk = "";
      for (const g of grouped) {
        if ((chunk + g).length > 3500) { chunks.push(chunk); chunk = ""; }
        chunk += g + "\n\n";
      }
      if (chunk) chunks.push(chunk);
      for (const c of chunks) {
        await bot.sendMessage(chatId, c.trim(), { parse_mode: "Markdown" });
        await new Promise((r) => setTimeout(r, 300));
      }
      return;
    }

    // ── /topics — إحصائيات المواضيع ──
    if (userText === "/topics") {
      const total = [...topicCounts.values()].reduce((a, b) => a + b, 0);
      const sorted = [...topicCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([, count]) => count > 0);
      const bars = sorted.map(([topic, count]) => {
        const pct = total ? Math.round((count / total) * 100) : 0;
        const bar = "█".repeat(Math.round(pct / 5)) || "░";
        return `${bar} *${topic}* — ${count} (${pct}%)`;
      }).join("\n");
      await bot.sendMessage(
        chatId,
        `📊 *أكثر الأسئلة اللي كيسولو عليها الناس:*\n\n${bars || "لا يوجد بيانات بعد"}\n\n_مجموع الرسائل المصنفة: ${total}_`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── /testimonials — شهادات الأرباح ──
    if (userText === "/testimonials") {
      if (testimonials.length === 0) {
        await bot.sendMessage(chatId, "لا توجد شهادات بعد.");
        return;
      }
      const list = testimonials.slice(-15).reverse()
        .map((t) => {
          const time = new Date(t.at).toLocaleString("fr-MA");
          return `👤 *${t.name}* — \`${t.chatId}\`\n🕐 ${time}\n💬 ${t.text}`;
        })
        .join("\n\n---\n\n");
      await bot.sendMessage(chatId, `🏆 *شهادات الأرباح (آخر 15):*\n\n${list}`, { parse_mode: "Markdown" });
      return;
    }

    // ── /proofs — عدد صور الإثبات ──
    if (userText === "/proofs") {
      await bot.sendMessage(
        chatId,
        `📸 *صور الإثبات:* ${proofPhotos.size} صورة\n\nباش تضيف صورة إثبات، ابعث الصورة مع الكابشن \`/addproof\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    return;
  }

  // ── /start — إعادة تشغيل المحادثة ──
  if (userText === "/start") {
    welcomedUsers.delete(chatId);
    pendingPitch.delete(chatId);
    waitingForId.delete(chatId);
    conversationHistory.delete(chatId);
  }

  // ── تتبع المستخدم ──
  if (!knownUsers.has(chatId)) {
    knownUsers.set(chatId, {
      name: firstName,
      username: msg.from?.username,
      joinedAt: Date.now(),
    });
    // إشعار الأونر بمستخدم جديد
    const uname = msg.from?.username ? `@${msg.from.username}` : `\`${chatId}\``;
    notifyOwner(`🆕 *مستخدم جديد!*\n\n👤 ${firstName} (${uname})\n🕐 أول رسالة: ${new Date().toLocaleTimeString("fr-MA")}`).catch(() => {});
  }

  logger.info({ chatId, userText }, "Received message");
  lastMessageTime.set(chatId, Date.now());
  // كل رسالة من المستخدم تعيد جدولة التذكير من الصفر — 30 دقيقة من الرسالة الأخيرة
  if (!registeredUsers.has(chatId)) scheduleReminder(chatId);

  // ── تتبع الموضوع ──
  const topic = detectTopic(userText);
  topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);

  // ── حفظ الرسالة في السجل ──
  recentMessages.push({ chatId, name: firstName, text: userText, at: Date.now() });
  if (recentMessages.length > 50) recentMessages.shift(); // نبقاو غير في آخر 50

  try {
    await bot.sendChatAction(chatId, "typing");

    // ── فحص الـ ID إذا كنا ننتظروه ──
    if (waitingForId.has(chatId)) {
      const numMatch = userText.trim().replace(/\s/g, "").match(/\d{7,12}/);
      if (numMatch) {
        const melbetId = parseInt(numMatch[0]!, 10);
        waitingForId.delete(chatId);

        // ── ID عشوائي أو مزيف (فوق الحد الأقصى) ──
        if (melbetId > INVALID_ID_MAX) {
          const INVALID_MSGS = [
            `❌ *هاد الـ ID مزيف أو غير صالح!*\n\nالـ ID \`${melbetId}\` ما كيوجدش في نظام Melbet 🚫\n\nما تحاولش تديني أرقام عشوائية أخويا 😅\n\nسجل حساب حقيقي في Melbet بالكود *999BOT* وأعطيني الـ ID الصحيح 📲`,
            `⛔ *هاد الرقم ما صحيحش!*\n\nالـ ID \`${melbetId}\` ما كاينش في سيستام Melbet\n\nأعطيني ID حقيقي — تلقاه في التطبيق بعد التسجيل 👇\n\nسجل دبا بالكود *999BOT* وأنا نساعدك 🍎`,
            `🚫 *ID غير صالح!*\n\nالرقم \`${melbetId}\` ما هوش ID Melbet حقيقي\n\nسجل في Melbet بالكود *999BOT* وأعطيني الـ ID اللي كيبان ليك في التطبيق ✅`,
          ];
          const msg = INVALID_MSGS[Math.floor(Math.random() * INVALID_MSGS.length)]!;
          await typeAndSend(chatId, msg, { parse_mode: "Markdown" });
          waitingForId.add(chatId); // نبقاو منتظرين ID صحيح
          return;
        }

        if (melbetId < OLD_ACCOUNT_THRESHOLD) {
          // حساب قديم
          logger.info({ chatId, melbetId }, "Old Melbet account detected");
          // إشعار الأونر بحساب قديم
          const uOld = knownUsers.get(chatId);
          const unameOld = uOld?.username ? `@${uOld.username}` : `\`${chatId}\``;
          notifyOwner(
            `⚠️ *حساب قديم كُشف!*\n\n` +
            `👤 ${uOld?.name ?? "—"} (${unameOld})\n` +
            `🆔 ID: \`${melbetId}\` ← قديم`
          ).catch(() => {});
          await bot.sendMessage(
            chatId,
            `⚠️ أخي هاد الـ ID \`${melbetId}\` *قديم* — السكريبت مكيخدمش مع الحسابات القديمة ⛔\n\n` +
            `وهاد الشي مهم بزاف: لازم تسجل الحساب الجديد *بالكود 999BOT* بالضبط\n` +
            `بلاش الكود، حتى لو فتحتي حساب جديد، *السكريبت مكيعطيكش التوقعات الصحيحة* 🔑`,
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
          // نألغي أي تذكير مجدول — المستخدم سجل ما نزعجوش
          const t = reminderTimers.get(chatId);
          if (t) { clearTimeout(t); reminderTimers.delete(chatId); }
          logger.info({ chatId, melbetId }, "New Melbet account confirmed");
          await typeAndSend(chatId, getSuccessMsg(), { parse_mode: "Markdown" });
          // إرسال رابط السكريبت مباشرة بعد المبروك
          scriptSentTime.set(chatId, Date.now());
          await typeAndSend(chatId, `🍎 *سكريبت التفاحة — رابطك الخاص:*\n\n${SCRIPT_URL}\n\n_ابدا فيه دبا وخبرني بشحال ربحت 💰_`, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🍎 فتح السكريبت", url: SCRIPT_URL }],
                [{ text: "❓ عندي سؤال آخر", callback_data: "ask_question" }],
              ],
            },
          });
          // إشعار الأونر بتسجيل ناجح
          const u = knownUsers.get(chatId);
          const uname = u?.username ? `@${u.username}` : `\`${chatId}\``;
          notifyOwner(
            `✅ *مستخدم سجل حساب جديد!*\n\n` +
            `👤 ${u?.name ?? "—"} (${uname})\n` +
            `🆔 Melbet ID: \`${melbetId}\``
          ).catch(() => {});
        }
        return;
      }
      // ما بعثش رقم — نشوفو شنو كيقول
      const lowerText = userText.trim().toLowerCase();
      const isDoubt = /la|non|mabght|mabghit|ma bght|khasrni|tsrq|sr9|nssb|nsb|khayf|khayef|wach ghat|wavh ghat|mzwr|scam|arnaque|خايف|نصب|مزور|لا مبغيتش|ما بغيتش|مكنبغيش/.test(lowerText);
      const isRefusal = /ma bghit|mabghitich|la mabghit|la mansift|la mansi|ما بغيت|مكبغيتش/.test(lowerText);

      if (isDoubt || isRefusal) {
        // الشخص عنده مخاوف — نجاوبو بشكل طبيعي عبر GPT
        waitingForId.delete(chatId); // نخرجو من وضع الانتظار مؤقتاً
        const history = conversationHistory.get(chatId) ?? [];
        const contextMsg = `المستخدم في مرحلة إرسال ID الخاص به في Melbet لكنه أبدى تحفظاً أو خوفاً. رسالته: "${userText}". طمّنه بشكل طبيعي وعفوي، وأخبره أنك لا تطلب أمواله ولا معلومات حساسة — فقط رقم ID للتحقق. ثم اطلب منه ID بشكل لطيف.`;
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...history,
            { role: "user", content: contextMsg },
          ],
          max_tokens: 200,
        });
        const reply = response.choices[0]?.message?.content ?? "والله أخي ما كنطلبش منك حتى شي خطير — الـ ID غير رقم عام كاين فالإعدادات 😊";
        await typeAndSend(chatId, reply);
        waitingForId.add(chatId); // نرجعو لوضع الانتظار
      } else {
        // تذكير بسيط
        await bot.sendMessage(
          chatId,
          `🔢 بعث ليا الـ *ID* ديالك في Melbet فقط (أرقام فقط) باش نتأكدو 👇`,
          { parse_mode: "Markdown" }
        );
      }
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

    // ── المرحلة الثانية: بعد ما يجاوب الشخص — شرح السكريبت + أزرار ──
    if (pendingPitch.has(chatId)) {
      pendingPitch.delete(chatId);
      const pitches = [
        `🍎 *سكريبت التفاحة* — برنامج مجاني لمدة محدودة كيحلل اللعب في Melbet ويعطيك توقعات صحيحة *90%*\n\nبزاف من الناس خدموا بيه وربحوا مزيان — وأنا هنا باش نساعدك توصلو 🎯`,
        `🍎 *واش سمعتي على سكريبت التفاحة؟*\n\nبرنامج مجاني كيديك توقعات صحيحة *90%* على Melbet — الناس اللي جربوه ربحوا بزاف\n\nوالله مجاني، غير لوقت محدود ⏳`,
        `🍎 *سكريبت التفاحة* — كيعطيك توقعات صحيحة *90%* على Melbet، مجاني بالكامل لكن لوقت محدود\n\nوأنا نساعدك توصلو دبا 💰`,
      ];
      const pitch = pitches[Math.floor(Math.random() * pitches.length)]!;
      await typeAndSend(chatId, pitch, { parse_mode: "Markdown" });
      await new Promise((r) => setTimeout(r, 700));
      await bot.sendMessage(chatId, `واش عندك حساب في Melbet؟ 👇`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🆕 ما عندي حساب", callback_data: "welcome_no_account" }],
            [{ text: "✅ عندي حساب جديد", callback_data: "welcome_has_account" }],
            [{ text: "📱 عندي حساب قديم", callback_data: "welcome_old_account" }],
          ],
        },
      });
      logger.info({ chatId }, "Sent pitch + account buttons after first reply");
      return;
    }

    // ── ميزة 1: كشف الإهانات/الرفض ──
    if (isInsulting(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await typeAndSend(chatId, personalize(getInsultResponse(), firstName), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled insult/rejection");
      return;
    }

    // ── ميزة 3: كشف المنافسين ──
    if (detectCompetitor(userText)) {
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 900)));
      await typeAndSend(chatId, getCompetitorResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled competitor mention");
      return;
    }

    // ── ميزة 3b: أرقام عشوائية خارج سياق الـ ID ──
    if (!waitingForId.has(chatId) && isRandomNumberMessage(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getRandomNumberResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled random number message");
      return;
    }

    const isFirstMessage = !welcomedUsers.has(chatId);
    if (isFirstMessage) {
      welcomedUsers.add(chatId);
      // رسالة الترحيب — مع الاسم أحياناً (ميزة 5)
      const useName = firstName !== "صديقي" && firstName.length <= 12 && Math.random() < 0.6;
      const greetings = useName ? [
        `اسلام يا ${firstName} 😊 أنا أمين — واش بغيتي سكريبت التفاحة مجانا؟ 🍎`,
        `سلام ${firstName} 😄 أنا أمين — واش بغيتي سكريبت التفاحة مجانا؟ 🍎`,
        `آسلامو عليكم يا ${firstName} 😊 أنا أمين — واش بغيتي سكريبت التفاحة؟ 🍎`,
      ] : [
        `اسلام أنا أمين 😊 واش بغيتي سكريبت التفاحة مجانا؟ 🍎`,
        `سلام أنا أمين 😄 واش بغيتي سكريبت التفاحة مجانا؟ 🍎`,
        `آسلامو عليكم أنا أمين 😊 واش بغيتي سكريبت التفاحة مجانا؟ 🍎`,
      ];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)]!;
      await typeAndSend(chatId, greeting);
      pendingPitch.add(chatId); // ننتظر رده قبل الشرح
      logger.info({ chatId }, "Sent greeting — waiting for first reply");
      return;
    }

    const french = isFrench(userText);
    const history = conversationHistory.get(chatId) ?? [];

    // ── ميزة 4: تعديل البرومبت بحسب المزاج ──
    const angryExtra = isAngryMood(userText)
      ? `\n\n⚠️ المستخدم يبدو محبط أو زعفان الآن — كن أكثر تفهماً وهدوءاً في ردك. لا تذكر التسجيل في هاد الرسالة مباشرة. ابدأ بالتعاطف: "فاهمك أخويا..." أو "طبيعي..." ثم اشرح بهدوء.`
      : "";

    // ميزة 5: نخبر GPT باسم المستخدم باش يستعملو أحياناً بشكل طبيعي
    const nameHint = firstName !== "صديقي" && firstName.length <= 12
      ? `\n\nاسم المستخدم الحقيقي هو: ${firstName}. يمكنك استعمال اسمه بشكل طبيعي أحياناً (مش في كل رسالة) — مثل "يلاه يا ${firstName}" أو "${firstName} سمعني".`
      : "";

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT + angryExtra + nameHint },
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

    await typeAndSend(chatId, reply);
    logger.info({ chatId }, "Sent AI reply");

    const count = (messageCount.get(chatId) ?? 0) + 1;
    messageCount.set(chatId, count);

    if (isAgreement(userText)) {
      agreedUsers.add(chatId);

      // الشروط — تتبعث دبا مع تأخير صغير طبيعي
      await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
      await typeAndSend(chatId, getMelbetMsg(), { parse_mode: "Markdown" });

      // ميزة 4: الاستعجال — بعد 3 إلى 6 دقائق
      const urgencyDelay = (3 * 60 + Math.floor(Math.random() * 3 * 60)) * 1000;
      setTimeout(async () => {
        try {
          await bot.sendChatAction(chatId, "typing");
          await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)));
          await typeAndSend(chatId, getUrgencyMsg(), { parse_mode: "Markdown" });
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
            await typeAndSend(chatId, getVipMsg(), { parse_mode: "Markdown" });
          }
          logger.info({ chatId }, "Sent delayed VIP photo");
        } catch (err) {
          logger.error({ err, chatId }, "Failed to send delayed VIP photo");
        }
      }, vipDelay);

      logger.info({ chatId, urgencyDelay, vipDelay }, "Scheduled agreement follow-up messages");

    } else if (isReportingWin(userText)) {
      // ── ميزة 4: حفظ الشهادة وإشعار الأونر ──
      testimonials.push({ chatId, name: firstName, text: userText, at: Date.now() });
      const uWin = knownUsers.get(chatId);
      const unameWin = uWin?.username ? `@${uWin.username}` : `\`${chatId}\``;
      notifyOwner(
        `🏆 *شهادة ربح جديدة!*\n\n` +
        `👤 ${firstName} (${unameWin})\n` +
        `💬 "${userText}"\n` +
        `🕐 ${new Date().toLocaleString("fr-MA")}`
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getWinReportResponse(), { parse_mode: "Markdown" });
      // نطلب صورة الشاشة بعد ثانيتين
      await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 1000)));
      await typeAndSend(chatId,
        `📸 أخي واش تقدر تبعث لي صورة شاشة للربح؟\n\nكنحتاجها باش نبيّن للناس الآخرين إن السكريبت كيخدم بصح 🙏`
      );
      logger.info({ chatId }, "Handled win report — congrats sent + testimony saved");

    } else if (isThanking(userText)) {
      await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 700)));
      await typeAndSend(chatId, getThanksResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled thanks");

    } else if (isAskingWhereID(userText)) {
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 900)));
      await typeAndSend(chatId, getFindIDResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled where-is-ID question");

    } else if (isCallingScam(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1200)));
      await typeAndSend(chatId, getScamResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled scam accusation");

    } else if (isDoubting(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      // ── ميزة 5: صور الإثبات الخاصة أولاً ──
      const proofArr = [...proofPhotos];
      const proofId = proofArr.length ? proofArr[Math.floor(Math.random() * proofArr.length)] : null;
      const fallbackId = getRandomPhoto();
      const sendId = proofId ?? fallbackId;
      if (sendId) {
        await bot.sendPhoto(chatId, sendId, { caption: getDoubtResponse(), parse_mode: "Markdown" });
      } else {
        await typeAndSend(chatId, getDoubtResponse(), { parse_mode: "Markdown" });
      }
      logger.info({ chatId }, "Handled doubt — sent proof");

    } else if (hasNoMoney(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await typeAndSend(chatId, getNoMoneyResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled no-money concern");

    } else if (isDelaying(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getDelayResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled delay response");

    } else if (isAskingRisk(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      const photoId = getRandomPhoto();
      if (photoId) {
        await bot.sendPhoto(chatId, photoId, { caption: getRiskResponse(), parse_mode: "Markdown" });
      } else {
        await typeAndSend(chatId, getRiskResponse(), { parse_mode: "Markdown" });
      }
      logger.info({ chatId }, "Handled risk question — sent photo proof");

    } else if (isAskingHowMuch(userText)) {
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 900)));
      await typeAndSend(chatId, getHowMuchResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled how-much-can-I-earn question");

    } else if (mentionsOldAccount(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await typeAndSend(chatId, getOldAccountMentionResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled old-account mention before ID");

    } else if (isAskingIOS(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getIOSResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled iOS/iPhone question");

    } else if (wantsScriptFree(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await typeAndSend(chatId, getNoRegisterResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled wants-script-without-Melbet");

    } else if (isAskingHalal(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getHalalResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled halal/haram question");

    } else if (isAskingSmallAmount(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getSmallAmountResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled small-amount question");

    } else if (isAskingComputer(userText)) {
      await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 700)));
      await typeAndSend(chatId, getComputerResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled computer/laptop question");

    } else if (isAskingAboutApple(userText)) {
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 900)));
      await typeAndSend(chatId, getAppleScriptResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled apple-script explanation");

    } else if (isAskingGroup(userText)) {
      await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 700)));
      await typeAndSend(chatId, getGroupResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled group question");

    } else if (isAskingHelp(userText)) {
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      await typeAndSend(chatId, getHelpResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled help/problem request");

    } else if (isAskingHowToUse(userText)) {
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
      await typeAndSend(chatId, getHowToUseResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Sent how-to-use response with Melbet+999BOT");

    } else if (isJustAcknowledging(userText)) {
      await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 600)));
      await typeAndSend(chatId, getAckResponse(), { parse_mode: "Markdown" });
      logger.info({ chatId }, "Handled short acknowledgment — pushed to register");

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
        await typeAndSend(chatId, getRandomWinNotif(), { parse_mode: "Markdown" });
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
    await typeAndSend(chatId, "حدث خطأ، يرجى المحاولة مرة أخرى.");
  }
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

// ── ميزة 8: تصدير البيانات للداشبورد ──
export { knownUsers, registeredUsers, agreedUsers, welcomedUsers, topicCounts, recentMessages };
export default bot;
