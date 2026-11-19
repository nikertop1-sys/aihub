// Сборщик AI HUB. Платных API не использует: только RSS, Google News RSS, YouTube Data API v3 (бесплатная квота)
// и учебная программа из curriculum.json. Если источник недоступен, он пропускается и пишется в лог.
import admin from "firebase-admin";
import Parser from "rss-parser";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const mode = process.argv[2] || "news";
const YKEY = process.env.YOUTUBE_API_KEY;
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("Не задан секрет FIREBASE_SERVICE_ACCOUNT");
let sa;
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { throw new Error("FIREBASE_SERVICE_ACCOUNT: это не корректный JSON"); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const parser = new Parser({ timeout: 20000, headers: { "User-Agent": "AIHubCollector/1.0" }, customFields: { item: [["media:content", "media"], ["media:thumbnail", "thumb"]] } });

const hid = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);
const strip = h => (h || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const now = () => new Date().toISOString();
const cut = (t, n) => { if (t.length <= n) return t; const s = t.slice(0, n), i = s.lastIndexOf(". "); return i > n * 0.5 ? s.slice(0, i + 1) : s.trimEnd() + "…"; };

/* ---------- источники ---------- */
const GN = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const AI = [
  ["OpenAI", "https://openai.com/news/rss.xml"],
  ["Google DeepMind", "https://deepmind.google/blog/rss.xml"],
  ["Microsoft AI", "https://blogs.microsoft.com/ai/feed/"],
  ["NVIDIA", "https://blogs.nvidia.com/blog/category/generative-ai/feed/"],
  ["Hugging Face", "https://huggingface.co/blog/feed.xml"],
  ["MIT Technology Review", "https://www.technologyreview.com/topic/artificial-intelligence/feed"],
  ["TechCrunch", "https://techcrunch.com/category/artificial-intelligence/feed/"],
  ["The Verge", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"],
  ["VentureBeat", "https://venturebeat.com/category/ai/feed/"],
  ["AI News", "https://www.artificialintelligence-news.com/feed/"],
  ["Google News: AI", GN("artificial intelligence")],
];
const CLAUDE = [
  ["Anthropic (RSS-зеркало)", "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml"],
  ["Google News: Anthropic", GN("Anthropic Claude")],
  ["Google News: Claude Code", GN('"Claude Code"')],
];
const DESIGN = [
  ["Smashing Magazine", "https://www.smashingmagazine.com/feed/"],
  ["Codrops", "https://tympanus.net/codrops/feed/"],
  ["UX Collective", "https://uxdesign.cc/feed"],
  ["Creative Bloq", "https://www.creativebloq.com/feeds/all"],
];
const HEUR = {
  ai: [["Законы", /\blaw|regulat|policy|court|lawsuit|\beu\b/i], ["Исследования", /research|paper|study|benchmark/i], ["Модели", /model|gpt|gemini|llama|release/i], ["Инструменты", /tool|app|agent|api|feature|sdk/i]],
  claude: [["Claude Code", /claude code/i], ["API", /\bapi\b|sdk/i], ["Тарифы", /pric|plan|subscription|tier/i]],
  design: [["Typography", /typograph|font/i], ["Motion", /motion|animation/i], ["3D", /\b3d\b|three\.js|webgl/i], ["Mobile", /mobile|\bios\b|android/i], ["Branding", /brand|logo/i], ["Dashboard", /dashboard/i], ["UI/UX", /\bux\b|\bui\b|interface/i]],
};
const DEF = { ai: "Компании", claude: "Модели", design: "Web" };
const category = (k, t) => (HEUR[k].find(([, re]) => re.test(t)) || [])[0] || DEF[k];
const imgOf = i => {
  const enc = i.enclosure && (!i.enclosure.type || i.enclosure.type.startsWith("image")) ? i.enclosure.url : "";
  return enc || (i.media && i.media.$ && i.media.$.url) || (i.thumb && i.thumb.$ && i.thumb.$.url) ||
    ((i["content:encoded"] || i.content || "").match(/<img[^>]+src=["'](https?:[^"']+)/) || [])[1] || "";
};

async function feeds(list, coll, k, perSrc, report) {
  let made = 0;
  for (const [src, url] of list) {
    let n = 0;
    try {
      const f = await parser.parseURL(url);
      for (const it of f.items.slice(0, 30)) {
        if (n >= perSrc) break;
        let title = strip(it.title), source = src;
        if (!title || !it.link) continue;
        if (src.startsWith("Google News")) { const m = title.match(/^(.*) - ([^-]+)$/); if (m) { title = m[1]; source = m[2].trim(); } }
        const text = strip(it.contentSnippet || it["content:encoded"] || it.content || it.summary || "");
        const d = new Date(it.isoDate || it.pubDate || Date.now()), date = isNaN(d) ? new Date() : d;
        if (Date.now() - date > 45 * 864e5) continue;
        let kind = k;
        if (k === "claude" && !/claude|anthropic/i.test(title + " " + text)) continue;
        if (k === "ai" && /claude|anthropic/i.test(title)) kind = "claude";
        const ref = db.collection(coll).doc(hid(it.link));
        if ((await ref.get()).exists) continue;
        const tkey = hid(title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
        if (!(await db.collection(coll).where("tkey", "==", tkey).limit(1).get()).empty) continue;
        const body = text === title ? "" : cut(text, 320);
        await ref.set({ title, summary: body, url: it.link, source, image: imgOf(it), category: category(kind === "claude" ? "claude" : k, title + " " + text),
          date: date.toISOString(), added: now(), tkey, lang: "en", ...(coll === "news" ? { kind } : {}) });
        n++; made++;
      }
      report[src] = { ok: true, new: n, at: now() };
    } catch (e) {
      console.error("RSS недоступен:", src, "-", e.message);
      report[src] = { ok: false, error: String(e.message).slice(0, 200), at: now() };
    }
  }
  return made;
}

/* ---------- YouTube ---------- */
const QUERIES = [["Claude AI tutorial", "en"], ["Claude Code tutorial", "en"], ["Anthropic Claude prompt engineering", "en"], ["Claude API automation agents", "en"], ["Claude AI обучение", "ru"], ["Claude Code на русском", "ru"]];
async function yt(path, params) {
  const u = new URL("https://www.googleapis.com/youtube/v3/" + path);
  Object.entries({ ...params, key: YKEY }).forEach(([a, b]) => u.searchParams.set(a, b));
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("YouTube " + r.status + " " + (await r.text()).slice(0, 160));
  return r.json();
}
async function stats(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push(...(await yt("videos", { part: "snippet,statistics", id: ids.slice(i, i + 50).join(",") })).items);
  return out;
}
const vLevel = t => /beginner|начина|basics|intro|для чайников/i.test(t) ? "Beginner" : /advanced|продвинут|deep dive/i.test(t) ? "Advanced" : "Intermediate";
const vTopic = t => /claude code/i.test(t) ? "Claude Code" : /prompt|промпт/i.test(t) ? "Prompt Engineering" : /\bapi\b|automation|agent|n8n|автоматиз/i.test(t) ? "API & Automation" : "";
async function videos() {
  if (!YKEY) { console.log("YOUTUBE_API_KEY не задан, шаг пропущен"); return false; }
  const V = db.collection("videos"), P = db.collection("videos_pending");
  const ex = (await V.get()).docs.map(d => d.id);
  const alive = new Map((await stats(ex)).map(v => [v.id, v]));
  for (const id of ex) alive.has(id) ? await V.doc(id).update({ views: Number(alive.get(id).statistics.viewCount || 0) }) : await V.doc(id).delete();
  const found = new Set((await P.get()).docs.map(d => d.id));
  const [q, lang] = QUERIES[new Date().getUTCHours() % QUERIES.length];
  for (const order of ["viewCount", "date"]) {
    const j = await yt("search", { part: "snippet", q, type: "video", order, maxResults: 50, relevanceLanguage: lang });
    j.items.forEach(i => i.id && i.id.videoId && found.add(i.id.videoId));
  }
  ex.forEach(id => found.delete(id));
  const got = new Map((await stats([...found])).map(v => [v.id, v]));
  let added = 0;
  for (const id of found) {
    const v = got.get(id);
    if (!v) { await P.doc(id).delete(); continue; }
    const s = v.snippet, text = s.title + " " + s.description;
    if (!/claude|anthropic/i.test(text)) { await P.doc(id).delete(); continue; }
    const views = Number(v.statistics.viewCount || 0);
    if (views >= 10000) {
      await V.doc(id).set({ title: s.title, channel: s.channelTitle, views, url: "https://www.youtube.com/watch?v=" + id,
        thumb: (s.thumbnails.high || s.thumbnails.medium || {}).url || "", level: vLevel(text), topic: vTopic(text),
        date: s.publishedAt, desc: strip(s.description).slice(0, 500) });
      await P.doc(id).delete(); added++;
    } else if (Date.now() - Date.parse(s.publishedAt) > 60 * 864e5) await P.doc(id).delete();
    else await P.doc(id).set({ title: s.title, views, checked: now() });
  }
  console.log("видео добавлено:", added);
  return true;
}

/* ---------- уроки: публикация по учебной программе ---------- */
const CURR = JSON.parse(readFileSync(new URL("./curriculum.json", import.meta.url), "utf8")).sort((a, b) => a.order - b.order);
const lessonBody = L => ({ title: L.title, category: L.category, level: L.level, goal: L.goal, theory: L.theory, examples: L.examples, steps: L.steps,
  task: L.task, questions: L.questions, sources: L.sources || [], outdated: false, origin: "curriculum", author: "Редакция AI HUB", order: L.order });
async function lessons() {
  const col = db.collection("lessons");
  let published = 0;
  for (const L of CURR) {
    const ref = col.doc("cur-" + L.order), s = await ref.get();
    if (!s.exists) continue;
    published++;
    if ((s.data().rev || 0) < (L.rev || 1)) await ref.set({ ...lessonBody(L), rev: L.rev || 1 }, { merge: true });
  }
  const per = published === 0 ? 3 : Number(process.env.LESSONS_PER_RUN || 1);
  let made = 0;
  for (const L of CURR) {
    if (made >= per) break;
    const ref = col.doc("cur-" + L.order);
    if ((await ref.get()).exists) continue;
    await ref.set({ ...lessonBody(L), rev: L.rev || 1, date: now(), added: now() });
    made++;
  }
  console.log(`уроков опубликовано сейчас: ${made}; всего по программе: ${CURR.length}; уже было: ${published}`);
  return true;
}

/* ---------- запуск ---------- */
try {
  let ok = true;
  if (mode === "news") {
    const rep = {};
    const b = await feeds(CLAUDE, "news", "claude", 5, rep);   // Claude первым, чтобы дубли попадали в Claude News
    const a = await feeds(AI, "news", "ai", 3, rep);
    const c = await feeds(DESIGN, "design", "design", 3, rep);
    console.log({ claude: b, ai: a, design: c });
    await db.doc("meta/sources").set({ news: rep, at: now() }, { merge: true });
  } else if (mode === "videos") {
    try { ok = await videos(); } catch (e) { console.error("YouTube:", e.message); ok = false; }
  } else if (mode === "lessons") ok = await lessons();
  else throw new Error("Неизвестный режим: " + mode);
  if (ok) await db.doc("meta/status").set({ updated: now(), [mode]: now() }, { merge: true });
  process.exit(0);
} catch (e) { console.error("ОШИБКА:", e); process.exit(1); }
