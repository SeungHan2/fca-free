// src/index.ts

export interface Env {
  // Secrets
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;  // 본채널
  ADMIN_CHAT_ID: string;     // 관리자 리포트 채널/개인

  // Vars (wrangler.toml [vars]) — 폴백용
  APP_NAME?: string;
  SEARCH_KEYWORDS?: string;     // 멀티라인/쉼표 입력 지원
  INCLUDE_KEYWORDS?: string;
  EXCLUDE_KEYWORDS?: string;
  DISPLAY_PER_CALL?: string;    // "30"
  MAX_LOOPS?: string;           // "3"
  MIN_SEND_THRESHOLD?: string;  // "1"
  FORCE_HOURS?: string;         // "0,2,4,6,8,10,12,14,16,18,20,22"

  // KV
  FCANEWS_KV: KVNamespace;
}

/* ───────────────────────────── helpers ───────────────────────────── */
const KST_MS = 9 * 3600 * 1000;
const toKST = (d: Date) => new Date(d.getTime() + KST_MS);
const pad = (n: number) => String(n).padStart(2, "0");
const fmtUTC = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

// HH:MM:SS (KST 기준)만 뽑는 헬퍼 추가
function fmtKSTClockLabel(dUTC: Date) {
  const k = toKST(dUTC);
  return `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())}`;
}

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

// ✅ 비어있지 않은 리스트를 우선 선택 (KV → TOML vars → 기본값)
function pickList(...cands: Array<string | undefined | null>): string[] {
  for (const c of cands) {
    const arr = parseListText(c || undefined);
    if (arr.length) return arr;
  }
  return [];
}

// ✅ 숫자 리스트 버전
function pickNumList(...cands: Array<string | undefined | null>): number[] {
  return pickList(...cands).map(Number).filter(Number.isFinite);
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

// 텔레그램 HTML 모드용 이스케이프: 큰따옴표(")는 그대로 둔다
function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 간단한 HTML 엔터티 디코더 (&quot;, &#39; 등 처리)
function decodeHtml(s: string) {
  if (!s) return s;
  // 숫자 엔터티 (10진수)
  s = s.replace(/&#(\d+);/g, (_m, n) => {
    try { return String.fromCharCode(parseInt(n, 10)); } catch { return _m; }
  });
  // 숫자 엔터티 (16진수)
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => {
    try { return String.fromCharCode(parseInt(n, 16)); } catch { return _m; }
  });
  // 명명 엔터티
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // 마지막에 &amp;
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
  force_hours: number[]; // KST 기준 시간대(정수)
};

function parseNumber(n: any, def: number, min?: number, max?: number): number {
  let v = Number(n);
  if (!Number.isFinite(v)) v = def;
  if (typeof min === "number") v = Math.max(min, v);
  if (typeof max === "number") v = Math.min(max, v);
  return v;
}

async function loadConfig(env: Env): Promise<AppConfig> {
  // KV에 단일 텍스트로 저장된 키들 (운영자가 대시보드에서 수정 가능)
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
        search_keywords: Array.isArray(cfg.search_keywords)
          ? cfg.search_keywords
          : pickList(kvSearch, env.SEARCH_KEYWORDS),
        include_keywords: Array.isArray(cfg.include_keywords)
          ? cfg.include_keywords
          : pickList(kvInclude, env.INCLUDE_KEYWORDS),
        exclude_keywords: Array.isArray(cfg.exclude_keywords)
          ? cfg.exclude_keywords
          : pickList(kvExclude, env.EXCLUDE_KEYWORDS),
        display_per_call: parseNumber(
          cfg.display_per_call ?? kvDisplay ?? env.DISPLAY_PER_CALL ?? "30",
          30, 1, 100
        ),
        max_loops: parseNumber(
          cfg.max_loops ?? kvMaxLoops ?? env.MAX_LOOPS ?? "3",
          3, 1, 10
        ),
        min_send_threshold: parseNumber(
          cfg.min_send_threshold ?? kvMinSend ?? env.MIN_SEND_THRESHOLD ?? "1",
          1, 0, 100
        ),
        force_hours: Array.isArray(cfg.force_hours)
          ? cfg.force_hours
          : pickNumList(kvForce, env.FORCE_HOURS, "0,2,4,6,8,10,12,14,16,18,20,22"),
      };
    }
  } catch (e) {
    console.error("loadConfig KV cfg:APP parse error", e);
  }

  // 2) 개별 텍스트 키 → 없으면 vars 폴백
  return {
    search_keywords: pickList(kvSearch, env.SEARCH_KEYWORDS),
    include_keywords: pickList(kvInclude, env.INCLUDE_KEYWORDS),
    exclude_keywords: pickList(kvExclude, env.EXCLUDE_KEYWORDS),
    display_per_call: parseNumber(kvDisplay ?? env.DISPLAY_PER_CALL ?? "30", 30, 1, 100),
    max_loops: parseNumber(kvMaxLoops ?? env.MAX_LOOPS ?? "3", 3, 1, 10),
    min_send_threshold: parseNumber(kvMinSend ?? env.MIN_SEND_THRESHOLD ?? "1", 1, 0, 100),
    force_hours: pickNumList(kvForce, env.FORCE_HOURS, "0,2,4,6,8,10,12,14,16,18,20,22"),
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
      const title = decodeHtml(
        rawTitle.replace(/<\/?b>/g, "")
      );
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
  // toKST로 보정된 Date에서 getUTCHours()는 'KST 시각'이 됨
  return FORCED.has(nowKST.getUTCHours())
    ? (candidateCount >= 1)
    : (candidateCount >= minSend);
}

/* ───────────────────────── HTTP: test/preview & env ───────────────────────── */
// 디버그용 마스킹
const mask = (s?: string) => (s ? s.slice(0, 4) + "***" + s.slice(-4) : "");

// /env 스냅샷
function buildEnvSnapshot(env: Env) {
  return {
    app: {
      APP_NAME: env.APP_NAME ?? null,
    },
    raw_vars: {
      SEARCH_KEYWORDS: env.SEARCH_KEYWORDS ?? null,
      INCLUDE_KEYWORDS: env.INCLUDE_KEYWORDS ?? null,
      EXCLUDE_KEYWORDS: env.EXCLUDE_KEYWORDS ?? null,
      DISPLAY_PER_CALL: env.DISPLAY_PER_CALL ?? null,
      MAX_LOOPS: env.MAX_LOOPS ?? null,
      MIN_SEND_THRESHOLD: env.MIN_SEND_THRESHOLD ?? null,
      FORCE_HOURS: env.FORCE_HOURS ?? null,
    },
    secrets_masked: {
      NAVER_CLIENT_ID: mask(env.NAVER_CLIENT_ID),
      NAVER_CLIENT_SECRET: mask(env.NAVER_CLIENT_SECRET),
      TELEGRAM_BOT_TOKEN: mask(env.TELEGRAM_BOT_TOKEN),
      TELEGRAM_CHAT_ID: mask(env.TELEGRAM_CHAT_ID),
      ADMIN_CHAT_ID: mask(env.ADMIN_CHAT_ID),
    },
  };
}

async function handleTestPreview(env: Env) {
  const { cfg, collected, loopReports, latestStr, earliestStr } = await searchRecentNews(env);
  const nowUTC = new Date();
  const nowKST = toKST(nowUTC);
  const shouldSend = computeShouldSend(nowKST, collected.length, cfg.min_send_threshold, cfg.force_hours);

  const totalLatest = loopReports.reduce((s, r) => s + (r.time_filtered || 0), 0);
  const totalExcl = loopReports.reduce((s, r) => s + (r.title_exclude_hit || 0), 0);
  const totalPass = loopReports.reduce((s, r) => s + (r.title_include_pass || 0), 0);

  // 헤더 라인 포맷 통일: (HH:MM:SS 기준) 
  const timeLabel = fmtKSTClockLabel(nowUTC);
  const head =
    `🧪 TEST PREVIEW [${collected.length}건] (${timeLabel} 기준)\n` +
    `• ${shouldSend ? "보낼 예정(조건 충족)" : "보류 예정(조건 미충족)"}`;

  // 집계/루프 포맷: (-제외) 제목통과 ← 최신 | (제외)제목통과/최신, (n차) 최신 ← 호출 | 최신/호출
  const exclLabel = totalExcl > 0 ? `(-${totalExcl})` : `(0)`;
  const loopsLines = [
    `${exclLabel} ${totalPass} ← ${totalLatest} | (제외)제목통과/최신`,
    ...loopReports.map(
      r => `(${r.call_no}차) ${r.time_filtered} ← ${r.fetched} | 최신/호출`
    ),
    `(최신) ${latestStr} ~ ${earliestStr}`,
  ];
  const loops = loopsLines.join("\n");

  const body = collected
    .map((it, i) => `${i + 1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`)
    .join("\n");

  await sendTelegram(
    [head, loops, body || "— 후보 없음 —"].join("\n"),
    env.ADMIN_CHAT_ID,
    env
  );

  return new Response(
    JSON.stringify(
      {
        shouldSend,
        minSend: cfg.min_send_threshold,
        count: collected.length,
        items: collected.map(it => ({ title: it.title, link: it.link })),
        loopReports,
        latestStr,
        earliestStr,
        cfg,
      },
      null,
      2
    ),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

/* ───────────────────────── Worker ───────────────────────── */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 임시 디버그 엔드포인트 (/env?admin=1)
    if (url.pathname === "/env") {
      if (url.searchParams.get("admin") !== "1") {
        return new Response("forbidden", { status: 403 });
      }
      const snap = buildEnvSnapshot(env);

      // (선택) ?kv=1 이면 KV의 개별 텍스트 키 힌트 포함
      if (url.searchParams.get("kv") === "1") {
        const [kvSearch, kvInclude, kvExclude, kvForce] = await Promise.all([
          env.FCANEWS_KV.get("SEARCH_KEYWORDS"),
          env.FCANEWS_KV.get("INCLUDE_KEYWORDS"),
          env.FCANEWS_KV.get("EXCLUDE_KEYWORDS"),
          env.FCANEWS_KV.get("FORCE_HOURS"),
        ]);
        (snap as any).kv_hints = {
          SEARCH_KEYWORDS: kvSearch ?? null,
          INCLUDE_KEYWORDS: kvInclude ?? null,
          EXCLUDE_KEYWORDS: kvExclude ?? null,
          FORCE_HOURS: kvForce ?? null,
        };
      }

      return new Response(JSON.stringify(snap, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname.toLowerCase() === "/test") {
      return await handleTestPreview(env); // 공개 미리보기
    }

    // 헬스체크/루트
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

      const shouldSend = computeShouldSend(
        nowKST,
        collected.length,
        cfg.min_send_threshold,
        cfg.force_hours
      );

      if (shouldSend && collected.length > 0) {
        const body = collected
          .map(
            (it, i) =>
              `${i + 1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`
          )
          .join("\n");
        await sendTelegram(body, env.TELEGRAM_CHAT_ID, env);

        await env.FCANEWS_KV.put(KV_LAST_SENT, targetIso);
        if (latestUTC)
          await env.FCANEWS_KV.put(KV_LAST_CHECKED, latestUTC.toISOString());
      }

      const totalLatest = loopReports.reduce(
        (s, r) => s + (r.time_filtered || 0),
        0
      );
      const totalExcl = loopReports.reduce(
        (s, r) => s + (r.title_exclude_hit || 0),
        0
      );
      const totalPass = loopReports.reduce(
        (s, r) => s + (r.title_include_pass || 0),
        0
      );
      const icon = shouldSend && collected.length > 0 ? "✅" : "⏸️";
      const status = shouldSend && collected.length > 0 ? "발송" : "보류";

      // 1행 포맷: (HH:MM:SS 기준) 
      const timeLabel = fmtKSTClockLabel(nowUTC);
      const lines: string[] = [];
      lines.push(
        `${icon} ${status} [${collected.length}건] (${timeLabel} 기준)`
      );

      // 2행: (-제외) 제목통과 ← 최신 | (제외)제목통과/최신  (제외가 0일 경우 마이너스 기호 생략)
      const exclLabel = totalExcl > 0 ? `(-${totalExcl})` : `(0)`;
      lines.push(`${exclLabel} ${totalPass} ← ${totalLatest} | (제외)제목통과/최신`);

      // 루프별: (n차) 최신 ← 호출 | 최신/호출
      for (const r of loopReports) {
        lines.push(`(${r.call_no}차) ${r.time_filtered} ← ${r.fetched} | 최신/호출`);
      }

      lines.push(`(최신) ${latestStr} ~ ${earliestStr}`);
      await sendTelegram(lines.join("\n"), env.ADMIN_CHAT_ID, env);
    } catch (e: any) {
      await sendTelegram(
        `❗️ fca-news error\n${String(e?.message || e)}`,
        env.ADMIN_CHAT_ID,
        env
      );
      console.error(e);
    }
  },
} satisfies ExportedHandler<Env>;
