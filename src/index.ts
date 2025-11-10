export interface Env {
  // Secrets
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;  // 본채널
  ADMIN_CHAT_ID: string;     // 관리자 리포트 채널/개인

  // Vars (wrangler.toml [vars]) — 폴백용
  APP_NAME?: string;
  SEARCH_KEYWORDS?: string;     // "FC안양,안양FC,K리그2"
  INCLUDE_KEYWORDS?: string;    // "승격,감독,영입,부상"
  EXCLUDE_KEYWORDS?: string;    // "야구"
  DISPLAY_PER_CALL?: string;    // "30"
  MAX_LOOPS?: string;           // "3"
  MIN_SEND_THRESHOLD?: string;  // "3"
  FORCE_HOURS?: string;         // "0,8,10,12,14,16,18,20,22"

  // KV
  FCANEWS_KV: KVNamespace;
}

/* ───────────────────────────── helpers ───────────────────────────── */
const KST_MS = 9 * 3600 * 1000;
const toKST = (d: Date) => new Date(d.getTime() + KST_MS);
const pad = (n: number) => String(n).padStart(2, "0");
const fmtUTC = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

const KV_LAST_SENT = "last_sent_target_iso";      // 짝수시 정각(UTC) ISO
const KV_LAST_CHECKED = "last_checked_time_iso";  // 마지막 본 기사 시각(UTC) ISO
const KV_CFG = "cfg:APP";                         // 설정 JSON 저장 키

// 줄바꿈/쉼표/세미콜론 구분 + 주석(#...) 무시 + 양끝 따옴표 제거
function parseListText(raw?: string): string[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.replace(/#.*/g, "").trim())
    .filter(Boolean)
    .join(",");
  return cleaned
    .split(/[;,，、]+|,/g)
    .flatMap(s => s.split(/\s*,\s*/g))
    .map(s => s.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function splitCSV(v?: string): string[] {
  if (!v) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

// 텍스트 정규화: NFKC + 소문자 + 연속 공백 축소
function norm(s: string): string {
  try {
    return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  } catch {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 추적 파라미터 제거 + https 고정 → 링크 중복 방지
function normalizeUrl(u: string) {
  try {
    const url = new URL(u);
    url.protocol = "https:";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","fbclid","gclid"]
      .forEach(k => url.searchParams.delete(k));
    return url.toString();
  } catch {
    return u.trim();
  }
}

// NAVER pubDate("+0900" 포함) → UTC Instant (추가 보정 금지)
function parsePubUTC(pub: string): Date | null {
  try {
    const dt = new Date(pub);
    if (String(dt) === "Invalid Date") return null;
    return dt;
  } catch {
    return null;
  }
}

// 이번 타임(짝수시 정각, KST 기준) 목표 시각 계산 → UTC로 변환
function computeTargetKST(fromUTC: Date) {
  const k = toKST(fromUTC);
  const t = new Date(k.getTime());
  t.setUTCMinutes(0, 0, 0);
  if (t.getUTCHours() % 2 !== 0) t.setUTCHours(t.getUTCHours() + 1);
  const targetUTC = new Date(t.getTime() - KST_MS);
  return { targetKST: t, targetUTC };
}

async function sendTelegram(text: string, chatId: string, env: Env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("Telegram send failed", res.status, t);
  }
}

/* ───────────────────────────── config loader ───────────────────────────── */
type AppConfig = {
  search_keywords: string[];
  include_keywords: string[];
  exclude_keywords: string[];
  display_per_call: number;
  max_loops: number;
  min_send_threshold: number;
  force_hours: number[];
};

function parseNumber(n: any, def: number, min?: number, max?: number): number {
  let v = Number(n);
  if (!Number.isFinite(v)) v = def;
  if (typeof min === "number") v = Math.max(min, v);
  if (typeof max === "number") v = Math.min(max, v);
  return v;
}

async function loadConfig(env: Env): Promise<AppConfig> {
  // 개별 텍스트 키(따옴표 없는 간단 입력) 우선 확보
  const kvSearch = await env.FCANEWS_KV.get("SEARCH_KEYWORDS");
  const kvInclude = await env.FCANEWS_KV.get("INCLUDE_KEYWORDS");
  const kvExclude = await env.FCANEWS_KV.get("EXCLUDE_KEYWORDS");
  const kvDisplay = await env.FCANEWS_KV.get("DISPLAY_PER_CALL");
  const kvMaxLoops = await env.FCANEWS_KV.get("MAX_LOOPS");
  const kvMinSend = await env.FCANEWS_KV.get("MIN_SEND_THRESHOLD");
  const kvForce = await env.FCANEWS_KV.get("FORCE_HOURS");

  // 1) cfg:APP(JSON) 우선
  try {
    const raw = await env.FCANEWS_KV.get(KV_CFG);
    if (raw) {
      const cfg = JSON.parse(raw);
      return {
        search_keywords: Array.isArray(cfg.search_keywords) ? cfg.search_keywords : (parseListText(kvSearch) || splitCSV(env.SEARCH_KEYWORDS)),
        include_keywords: Array.isArray(cfg.include_keywords) ? cfg.include_keywords : (parseListText(kvInclude) || splitCSV(env.INCLUDE_KEYWORDS)),
        exclude_keywords: Array.isArray(cfg.exclude_keywords) ? cfg.exclude_keywords : (parseListText(kvExclude) || splitCSV(env.EXCLUDE_KEYWORDS)),
        display_per_call: parseNumber(cfg.display_per_call ?? kvDisplay ?? env.DISPLAY_PER_CALL ?? "30", 30, 1, 100),
        max_loops: parseNumber(cfg.max_loops ?? kvMaxLoops ?? env.MAX_LOOPS ?? "3", 3, 1, 10),
        min_send_threshold: parseNumber(cfg.min_send_threshold ?? kvMinSend ?? env.MIN_SEND_THRESHOLD ?? "3", 3, 0, 100),
        force_hours: Array.isArray(cfg.force_hours)
          ? cfg.force_hours
          : (parseListText(kvForce).map(Number).filter(Number.isFinite)
              || splitCSV(env.FORCE_HOURS ?? "0,8,10,12,14,16,18,20,22").map(Number).filter(Number.isFinite)),
      };
    }
  } catch (e) {
    console.error("loadConfig KV cfg:APP parse error", e);
  }

  // 2) 개별 텍스트 키 → 없으면 vars 폴백
  return {
    search_keywords: parseListText(kvSearch) || splitCSV(env.SEARCH_KEYWORDS),
    include_keywords: parseListText(kvInclude) || splitCSV(env.INCLUDE_KEYWORDS),
    exclude_keywords: parseListText(kvExclude) || splitCSV(env.EXCLUDE_KEYWORDS),
    display_per_call: parseNumber(kvDisplay ?? env.DISPLAY_PER_CALL ?? "30", 30, 1, 100),
    max_loops: parseNumber(kvMaxLoops ?? env.MAX_LOOPS ?? "3", 3, 1, 10),
    min_send_threshold: parseNumber(kvMinSend ?? env.MIN_SEND_THRESHOLD ?? "3", 3, 0, 100),
    force_hours: (parseListText(kvForce).map(Number).filter(Number.isFinite)
      || splitCSV(env.FORCE_HOURS ?? "0,8,10,12,14,16,18,20,22").map(Number).filter(Number.isFinite)),
  };
}

/* ───────────────────────── NAVER fetch + filter ───────────────────────── */
async function searchRecentNews(env: Env) {
  const cfg = await loadConfig(env);

  const CLIENT_ID = env.NAVER_CLIENT_ID;
  const CLIENT_SECRET = env.NAVER_CLIENT_SECRET;
  const DISPLAY = cfg.display_per_call;
  const MAX_LOOPS = cfg.max_loops;

  const base = "https://openapi.naver.com/v1/search/news.json";
  const query = encodeURIComponent(cfg.search_keywords.join(" ").trim());
  const headers: Record<string, string> = {
    "X-Naver-Client-Id": CLIENT_ID,
    "X-Naver-Client-Secret": CLIENT_SECRET,
    "User-Agent": "Mozilla/5.0 (compatible; fcanews/1.0)",
  };

  const lastCheckedUTC = await env.FCANEWS_KV.get(KV_LAST_CHECKED);
  const lastChecked = lastCheckedUTC ? new Date(lastCheckedUTC) : null;

  const seen = new Set<string>();
  const collected: Array<{ title: string; link: string; pubUTC: Date }> = [];
  const loopReports: Array<{
    call_no: number; fetched: number; time_filtered: number;
    title_include_fail: number; title_exclude_hit: number; title_include_pass: number;
  }> = [];
  const pubTimesUTC: Date[] = [];

  let stopDueToOld = false;

  for (let page = 1; page <= MAX_LOOPS; page++) {
    const start = (page - 1) * DISPLAY + 1;
    const url = `${base}?query=${query}&display=${DISPLAY}&start=${start}&sort=date`;

    const r = await fetch(url, { method: "GET", headers, cf: { cacheTtl: 0 } });
    if (!r.ok) {
      console.error("NAVER error", r.status, await r.text());
      break;
    }
    const data = await r.json();
    const items: any[] = data?.items || [];
    if (!items.length) break;

    let fetched = items.length, time_filtered = 0, title_include_fail = 0, title_exclude_hit = 0;

    for (const it of items) {
      const rawTitle = String(it?.title || "");
      const title = rawTitle.replace(/<b>/g, "").replace(/<\/b>/g, "");
      const link = normalizeUrl(String(it?.link || "").trim());
      const pubUTC = parsePubUTC(String(it?.pubDate || ""));
      if (!pubUTC) continue;

      // 시간 필터: UTC 비교 (<= lastChecked 제외)
      if (lastChecked && pubUTC.getTime() <= lastChecked.getTime()) {
        stopDueToOld = true;
        continue;
      }
      time_filtered++;
      pubTimesUTC.push(pubUTC);

      // 정규화된 제목
      const tNorm = norm(title);

      // 포함 필터
      let includeOk = true;
      if (cfg.include_keywords.length) {
        includeOk = cfg.include_keywords.some(k => tNorm.includes(norm(k)));
      }
      if (!includeOk) { title_include_fail++; continue; }

      // 제외 필터
      if (cfg.exclude_keywords.length) {
        if (cfg.exclude_keywords.some(k => tNorm.includes(norm(k)))) {
          title_exclude_hit++; continue;
        }
      }

      // 링크 중복 제거
      if (seen.has(link)) continue;
      seen.add(link);

      collected.push({ title, link, pubUTC });
    }

    loopReports.push({
      call_no: page,
      fetched,
      time_filtered,
      title_include_fail,
      title_exclude_hit,
      title_include_pass: Math.max(0, time_filtered - title_include_fail),
    });

    if (stopDueToOld) break;
    if (items.length < DISPLAY) break;
  }

  const latestUTC = pubTimesUTC.length ? pubTimesUTC.reduce((a, b) => a > b ? a : b) : null;
  const earliestUTC = pubTimesUTC.length ? pubTimesUTC.reduce((a, b) => a < b ? a : b) : null;

  function fmtKSTLabel(dUTC: Date | null) {
    if (!dUTC) return "N/A";
    const k = toKST(dUTC);
    return `${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}(${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())})`;
  }

  const latestStr = fmtKSTLabel(latestUTC);
  const earliestStr = fmtKSTLabel(earliestUTC);

  return { cfg, collected, loopReports, latestStr, earliestStr, latestUTC };
}

/* ───────────────────────── policy helpers ───────────────────────── */
function computeShouldSend(nowKST: Date, candidateCount: number, minSend: number, forceHours: number[]) {
  const FORCED = new Set(forceHours);
  return FORCED.has(nowKST.getUTCHours())
    ? (candidateCount >= 1)
    : (candidateCount >= minSend);
}

/* ───────────────────────── HTTP handlers ───────────────────────── */
async function handleTestPreview(env: Env) {
  const { cfg, collected, loopReports, latestStr, earliestStr } = await searchRecentNews(env);
  const nowUTC = new Date();
  const nowKST = toKST(nowUTC);
  const shouldSend = computeShouldSend(nowKST, collected.length, cfg.min_send_threshold, cfg.force_hours);

  const totalLatest = loopReports.reduce((s, r) => s + (r.time_filtered || 0), 0);
  const totalExcl = loopReports.reduce((s, r) => s + (r.title_exclude_hit || 0), 0);
  const totalPass = loopReports.reduce((s, r) => s + (r.title_include_pass || 0), 0);

  const head = `🧪 TEST PREVIEW [${collected.length}건] (${fmtUTC(nowKST)} KST)\n• 정책결과: ${shouldSend ? "보낼 예정(조건 충족)" : "보류 예정(조건 미충족)"}\n• 임계값(MIN_SEND_THRESHOLD): ${cfg.min_send_threshold}`;
  const loops = [
    `(집계) (제외${totalExcl}) 제목통과 ${totalPass} / 최신${totalLatest}`,
    ...loopReports.map(r => `(${r.call_no}차) 최신${r.time_filtered} / 호출${r.fetched}`),
    `(최신) ${latestStr} ~ ${earliestStr}`
  ].join("\n");
  const body = collected.map((it, i) => `${i + 1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`).join("\n");

  await sendTelegram([head, loops, body || "— 후보 없음 —"].join("\n"), env.ADMIN_CHAT_ID, env);

  return new Response(JSON.stringify({
    shouldSend,
    minSend: cfg.min_send_threshold,
    count: collected.length,
    items: collected.map(it => ({ title: it.title, link: it.link })),
    loopReports,
    latestStr, earliestStr,
    cfg
  }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

/* ───────────────────────── Worker ───────────────────────── */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/test") {
      return await handleTestPreview(env); // 공개 미리보기
    }

    const now = new Date();
    const { targetKST, targetUTC } = computeTargetKST(now);
    return new Response(
      `${env.APP_NAME ?? "fca-news"} OK\nNOW UTC: ${fmtUTC(now)}\nNEXT KST: ${fmtUTC(targetKST)}\nNEXT UTC: ${fmtUTC(targetUTC)}\n`,
      { status: 200 }
    );
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const { cfg, collected, loopReports, latestStr, earliestStr, latestUTC } = await searchRecentNews(env);

      const nowUTC = new Date(event.scheduledTime);
      const nowKST = toKST(nowUTC);

      const { targetUTC } = computeTargetKST(nowUTC);
      const targetIso = targetUTC.toISOString();
      const lastSent = await env.FCANEWS_KV.get(KV_LAST_SENT);
      if (lastSent === targetIso) {
        console.log("SKIP: already sent", targetIso);
        return;
      }

      const shouldSend = computeShouldSend(nowKST, collected.length, cfg.min_send_threshold, cfg.force_hours);

      if (shouldSend && collected.length > 0) {
        const body = collected.map((it, i) =>
          `${i + 1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`
        ).join("\n");
        await sendTelegram(body, env.TELEGRAM_CHAT_ID, env);

        await env.FCANEWS_KV.put(KV_LAST_SENT, targetIso);
        if (latestUTC) await env.FCANEWS_KV.put(KV_LAST_CHECKED, latestUTC.toISOString());
      }

      const totalLatest = loopReports.reduce((s, r) => s + (r.time_filtered || 0), 0);
      const totalExcl = loopReports.reduce((s, r) => s + (r.title_exclude_hit || 0), 0);
      const totalPass = loopReports.reduce((s, r) => s + (r.title_include_pass || 0), 0);
      const icon = (shouldSend && collected.length > 0) ? "✅" : "⏸️";
      const status = (shouldSend && collected.length > 0) ? "발송" : "보류";

      const lines: string[] = [];
      lines.push(`${icon} ${status} [${collected.length}건] (${fmtUTC(nowKST)} KST 기준)`);
      lines.push(`(제외${totalExcl}) 제목통과 ${totalPass} / 최신${totalLatest}`);
      for (const r of loopReports) lines.push(`(${r.call_no}차) 최신${r.time_filtered} / 호출${r.fetched}`);
      lines.push(`(최신) ${latestStr} ~ ${earliestStr}`);
      await sendTelegram(lines.join("\n"), env.ADMIN_CHAT_ID, env);
    } catch (e: any) {
      await sendTelegram(`❗️ fca-news error\n${String(e?.message || e)}`, env.ADMIN_CHAT_ID, env);
      console.error(e);
    }
  },
} satisfies ExportedHandler<Env>;
