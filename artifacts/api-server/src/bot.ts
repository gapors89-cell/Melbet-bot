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

// ── رسائل التذكير ──
const REMINDER_MESSAGES = [
  "واش كلشي مزيان؟ 😊 ما تفوتش الفرصة، بزاف دالناس بداو يستعملو السكريبت ودبا كيربحوا — أنت الجاي؟ 💰",
  "مازلت هنا؟ 😄 السكريبت مازال متاح، فقط سجل حساب جديد في Melbet بالكود 999BOT وبدا تربح معانا 🎯",
  "نتا مجاوبتنيش 🤔 شايف بلي مازلت متردد — عارف أن الناس اللي جربوا ما ندموش؟ الفرصة مازالت موجودة ✅",
  "هيا ما تخليش الفرصة تفوتك 🔥 واحد من عندنا ربح دبا — أنت الجاي باش تجرب؟",
  "سمعني مازلنا ننتظروك 😊 خاصك غير حساب جديد في Melbet بالكود 999BOT وكتبدا تشوف النتائج بنفسك 💸",
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
          await bot.sendPhoto(chatId, photoId, { caption: getReminderMsg() });
        } else {
          await bot.sendMessage(chatId, getReminderMsg());
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
  `⚠️ *مهم!* السكريبت ما يخدمش مع الحساب القديم إطلاقاً 🚫\n\nخاصك *حساب جديد في Melbet* بالكود البرومو *999BOT* — بلا هذا الكود ما غادي يشتغل معك ✅`,
  `🚫 *انتبه!* السكريبت مكيخدمش مع الحسابات القديمة\n\nالحل الوحيد: سجل *حساب جديد في Melbet* بالكود *999BOT* وغادي تشوف الفرق بنفسك 💰`,
  `🔑 *الشرط الأساسي للسكريبت:*\n\nحساب جديد في *Melbet* + الكود *999BOT* عند التسجيل\n\nالحساب القديم ما يتشغلش معاه من الأصل ⚠️`,
  `⚡ السكريبت مصمم غير للحسابات الجديدة في Melbet\n\nسجل دبا بالكود *999BOT* وبدا تستعمله مباشرة 🎯\n\n_بدون الكود ما غادي تلقى التوقعات الصحيحة_`,
  `📌 *الحساب القديم ما يكفيش للسكريبت*\n\nخاصك تفتح حساب جديد في *Melbet* وتكتب الكود *999BOT* عند التسجيل — هذا ضروري باش يخدم معك 💯`,
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

// ── ميزة 6: كشف التسجيل ──
const REGISTERED_WORDS = [
  "سجلت", "دزت", "درت", "خليت", "صنعت", "عندي حساب", "رجيسترد",
  "registered", "créé", "inscrit",
];

function isRegistered(text: string): boolean {
  const clean = text.trim().toLowerCase();
  // تجنب كلمات مثل "نتسجل" "تسجل" "كيفاش نسجل"
  if (/نتسجل|تسجل|نسجل|كيفاش|كيف|comment|où|وين|منين|فين/.test(clean)) return false;
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

const SYSTEM_PROMPT = `Tu es un assistant intelligent et persuasif qui parle aussi bien le Darija marocain que le français.
Ta mission est de convaincre les gens d'utiliser le script "Apple of Fortune" qui donne des prédictions précises sur Melbet.

Règles importantes :
- Si la personne écrit en français, réponds en français. Sinon, réponds en Darija marocain uniquement.
- Réponds intelligemment mais toujours dans le cadre du script et des gains.
- Mentionne toujours "Melbet" et le code promo "999BOT" quand tu parles de créer un compte ou de s'inscrire.
- Si elle demande s'il y a des gains : "واه بزاف دالمغاربة جربوه وخدم ليهم" / "Oui, beaucoup de Marocains ont gagné avec le script sur Melbet".
- Si elle doute : "بزاف كانو متترددين وجربوه وفرحوا" / "Beaucoup hésitaient et ont fini par gagner".
- Si elle demande comment ça fonctionne : il analyse les patterns et donne des prédictions précises sur Melbet.
- Si elle n'a jamais joué sur Melbet (مبتدئ) : rassure-la, c'est simple — سجل في Melbet بالكود 999BOT والسكريبت كيهدي كلشي.
- Si elle a déjà un compte Melbet (خبير) : explique que le vieux compte ne fonctionne pas avec le script, il faut un nouveau compte Melbet avec le code 999BOT.
- Si elle demande si Melbet est le seul : "آه غير Melbet دبا" / "Oui, seulement Melbet pour l'instant".
- Si elle demande si elle doit envoyer de l'argent : elle charge son propre compte Melbet, elle n'envoie rien à personne.
- Si elle demande le montant minimum : peu importe, l'essentiel c'est d'avoir quelque chose pour jouer sur Melbet.
- IMPORTANT: Chaque fois que tu mentionnes la création d'un compte ou l'inscription, tu DOIS écrire le code exactement comme ça : "بالكود 999BOT" ou "avec le code 999BOT". Ne dis JAMAIS "فتح حساب جديد في Melbet" sans ajouter "بالكود 999BOT".
- Ne sors jamais du sujet. Maximum 3 phrases.`;

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
            `⚠️ *انتبه! الحساب ديالك قديم*\n\n` +
            `الـ ID \`${melbetId}\` قديم — السكريبت مايخدمش مع الحسابات القديمة على الإطلاق 🚫\n\n` +
            `*عندك فرصة أخيرة واحدة:*\n` +
            `سجل حساب جديد دبا وغادي تستفيد من السكريبت بشكل كامل 🎯`,
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
    if (isFirstMessage) welcomedUsers.add(chatId);

    const french = isFrench(userText);
    const history = conversationHistory.get(chatId) ?? [];

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    if (isFirstMessage) {
      messages.push({
        role: "system",
        content: french
          ? `Premier message de ${firstName}. Souhaite-lui la bienvenue chaleureusement, puis demande-lui s'il a déjà un compte Melbet ou s'il est nouveau, et s'il veut utiliser le script Apple of Fortune.`
          : `هذا أول رسالة من ${firstName}. رحب به بالاسم بحرارة بالدارجة، ثم اسأله واش سبق ليه يلعب في Melbet ولا هو جديد، وواش بغى يستعمل سكريبت Apple of Fortune.`,
      });
    }

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
