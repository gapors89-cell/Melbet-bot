import { Router } from "express";
import {
  knownUsers,
  registeredUsers,
  agreedUsers,
  welcomedUsers,
  topicCounts,
  recentMessages,
  testimonials,
  proofPhotos,
} from "../bot.js";

const router = Router();

router.get("/dashboard", (_req, res) => {
  const now = Date.now();
  const activeToday = [...knownUsers.entries()].filter(
    ([id]) => {
      const msgs = recentMessages.filter((m) => m.chatId === id);
      return msgs.some((m) => now - m.at < 24 * 60 * 60 * 1000);
    }
  ).length;

  const topicRows = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v > 0)
    .map(([topic, count]) => {
      const total = [...topicCounts.values()].reduce((a, b) => a + b, 0) || 1;
      const pct = Math.round((count / total) * 100);
      return `<tr>
        <td>${topic}</td>
        <td>
          <div style="background:#22c55e;height:18px;width:${pct}%;border-radius:4px;min-width:4px;display:inline-block"></div>
          &nbsp;<strong>${count}</strong> <span style="color:#888">(${pct}%)</span>
        </td>
      </tr>`;
    })
    .join("");

  const msgRows = [...recentMessages]
    .reverse()
    .slice(0, 30)
    .map((m) => {
      const time = new Date(m.at).toLocaleString("fr-MA");
      const safe = m.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<tr><td>${m.name}</td><td style="color:#888;font-size:12px">${time}</td><td>${safe}</td></tr>`;
    })
    .join("");

  const testRows = [...testimonials]
    .reverse()
    .slice(0, 10)
    .map((t) => {
      const time = new Date(t.at).toLocaleString("fr-MA");
      const safe = t.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<tr><td>🏆 ${t.name}</td><td style="color:#888;font-size:12px">${time}</td><td style="color:#22c55e">${safe}</td></tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>لوحة تحكم البوت — أمين</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;direction:rtl}
    h1{color:#22c55e;font-size:24px;margin-bottom:4px}
    .sub{color:#64748b;font-size:13px;margin-bottom:24px}
    .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-bottom:32px}
    .card{background:#1e293b;border-radius:12px;padding:20px;text-align:center}
    .card .num{font-size:36px;font-weight:bold;color:#22c55e}
    .card .lbl{font-size:13px;color:#94a3b8;margin-top:4px}
    section{background:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px}
    section h2{font-size:16px;color:#94a3b8;margin-bottom:14px;border-bottom:1px solid #334155;padding-bottom:8px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    td{padding:8px 10px;border-bottom:1px solid #1e293b;vertical-align:top;word-break:break-word}
    tr:hover td{background:#0f172a}
    .refresh{background:#22c55e;color:#0f172a;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:bold;margin-bottom:20px}
  </style>
</head>
<body>
  <h1>🤖 لوحة تحكم أمين</h1>
  <p class="sub">آخر تحديث: ${new Date().toLocaleString("fr-MA")} &nbsp;|&nbsp; <a href="/api/dashboard" style="color:#22c55e">تحديث</a></p>

  <div class="cards">
    <div class="card"><div class="num">${knownUsers.size}</div><div class="lbl">مجموع المستخدمين</div></div>
    <div class="card"><div class="num">${welcomedUsers.size}</div><div class="lbl">تواصلوا مع البوت</div></div>
    <div class="card"><div class="num">${agreedUsers.size}</div><div class="lbl">وافقوا</div></div>
    <div class="card"><div class="num">${registeredUsers.size}</div><div class="lbl">سجلوا رسمياً</div></div>
    <div class="card"><div class="num">${activeToday}</div><div class="lbl">نشيطين اليوم</div></div>
    <div class="card"><div class="num">${testimonials.length}</div><div class="lbl">شهادات ربح</div></div>
    <div class="card"><div class="num">${proofPhotos.size}</div><div class="lbl">صور إثبات</div></div>
    <div class="card"><div class="num">${recentMessages.length}</div><div class="lbl">رسائل محفوظة</div></div>
  </div>

  <section>
    <h2>📊 المواضيع الأكثر تداولاً</h2>
    <table>${topicRows || "<tr><td colspan='2' style='color:#64748b'>لا يوجد بيانات بعد</td></tr>"}</table>
  </section>

  ${testimonials.length > 0 ? `
  <section>
    <h2>🏆 شهادات الأرباح الأخيرة</h2>
    <table>
      <tr style="color:#64748b;font-size:12px"><td>الاسم</td><td>التاريخ</td><td>الشهادة</td></tr>
      ${testRows}
    </table>
  </section>` : ""}

  <section>
    <h2>💬 آخر رسائل المستخدمين</h2>
    <table>
      <tr style="color:#64748b;font-size:12px"><td>الاسم</td><td>الوقت</td><td>الرسالة</td></tr>
      ${msgRows || "<tr><td colspan='3' style='color:#64748b'>لا يوجد رسائل بعد</td></tr>"}
    </table>
  </section>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
