export interface Env {
  // Secrets
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ADMIN_CHAT_ID: string;

  // Vars
  APP_NAME?: string;
  SEARCH_KEYWORDS?: string;
  INCLUDE_KEYWORDS?: string;
  EXCLUDE_KEYWORDS?: string;
  DISPLAY_PER_CALL?: string;   // "30"
  MAX_LOOPS?: string;          // "3"
  MIN_SEND_THRESHOLD?: string; // "3"

  // KV
  FCANEWS_KV: KVNamespace;
}

const KST_MS = 9 * 3600 * 1000;
const toKST = (d: Date) => new Date(d.getTime() + KST_MS);
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

const KV_LAST_SENT = "last_sent_target_iso";   // 짝수시 정각(UTC) 기준 중복 방지
const KV_LAST_CHECKED = "last_checked_time_iso"; // 마지막 본 기사 시각(UTC)

function splitList(v?: string): string[] {
  if (!v) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

// utm 등 흔한 추적파라미터 제거 + https 강제 (중복 링크 방지에 도움)
function normalizeUrl(u: string) {
  try {
    const url = new URL(u);
    url.protocol = "https:";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","fbclid","gclid"].forEach(p => url.searchParams.delete(p));
    return url.toString();
  } catch { return u.trim(); }
}

// RFC-2822 → Date(KST)
function parsePubToKST(pub: string): Date | null {
  try {
    const dt = new Date(pub);
    if (String(dt) === "Invalid Date") return null;
    return new Date(dt.getTime() + KST_MS);
  } catch { return null; }
}

// target 짝수시 정각(KST) 계산 (안전용)
function computeTargetKST(fromUTC: Date) {
  const k = toKST(fromUTC);
  const t = new Date(k.getTime());
  t.setUTCMinutes(0,0,0);
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

async function searchRecentNews(env: Env) {
  const CLIENT_ID = env.NAVER_CLIENT_ID;
  const CLIENT_SECRET = env.NAVER_CLIENT_SECRET;
  const DISPLAY = Number(env.DISPLAY_PER_CALL || "30");
  const MAX_LOOPS = Number(env.MAX_LOOPS || "3");

  const searchKeywords = splitList(env.SEARCH_KEYWORDS);
  const includeKeywords = splitList(env.INCLUDE_KEYWORDS);
  const excludeKeywords = splitList(env.EXCLUDE_KEYWORDS);

  const base = "https://openapi.naver.com/v1/search/news.json";
  const query = encodeURIComponent(searchKeywords.join(" ").trim());
  const headers: Record<string,string> = {
    "X-Naver-Client-Id": CLIENT_ID,
    "X-Naver-Client-Secret": CLIENT_SECRET,
    "User-Agent": "Mozilla/5.0 (compatible; fcanews/1.0)",
  };

  const lastCheckedUTC = await env.FCANEWS_KV.get(KV_LAST_CHECKED);
  const lastChecked = lastCheckedUTC ? new Date(lastCheckedUTC) : null;

  const collected: Array<{title: string; link: string; pubKST: Date}> = [];
  const loopReports: any[] = [];
  const seen = new Set<string>();

  let stopDueToOld = false;
  let pubTimesKST: Date[] = [];

  for (let page = 1; page <= MAX_LOOPS; page++) {
    const start = (page - 1) * DISPLAY + 1;
    const url = `${base}?query=${query}&display=${DISPLAY}&start=${start}&sort=date`;

    const r = await fetch(url, { headers, cf: { cacheTtl: 0 }, method: "GET" });
    if (!r.ok) {
      console.error("NAVER error", r.status, await r.text());
      break;
    }
    const json = await r.json();
    const items: any[] = json?.items || [];
    if (!items.length) break;

    let time_filtered = 0, include_fail = 0, exclude_hit = 0, fetched = items.length;

    for (const it of items) {
      const rawTitle = String(it?.title || "");
      const title = rawTitle.replace(/<b>/g,"").replace(/<\/b>/g,"");
      const link = normalizeUrl(String(it?.link || "").trim());
      const pubKST = parsePubToKST(String(it?.pubDate || ""));
      if (!pubKST) continue;

      // 최신성 필터: 이전에 본 시각보다 과거면 스킵(또는 루프 종료 트리거)
      if (lastChecked && pubKST.getTime() <= (lastChecked.getTime())) {
        stopDueToOld = true;
        continue;
      }

      time_filtered++;
      pubTimesKST.push(pubKST);

      // 포함 키워드 (없으면 통과, 있으면 하나라도 포함)
      let includeOk = true;
      if (includeKeywords.length) {
        const t = title.toLowerCase();
        includeOk = includeKeywords.some(kw => t.includes(kw.toLowerCase()));
      }
      if (!includeOk) { include_fail++; continue; }

      // 제외 키워드
      if (excludeKeywords.length) {
        const t = title.toLowerCase();
        const hit = excludeKeywords.some(ek => t.includes(ek.toLowerCase()));
        if (hit) { exclude_hit++; continue; }
      }

      // 링크 중복 제거
      if (seen.has(link)) continue;
      seen.add(link);

      collected.push({ title, link, pubKST });
    }

    loopReports.push({
      call_no: page, fetched, time_filtered,
      title_include_fail: include_fail,
      title_exclude_hit: exclude_hit,
      title_include_pass: Math.max(0, time_filtered - include_fail),
    });

    if (stopDueToOld) break;
    if (items.length < DISPLAY) break;
  }

  const latest = pubTimesKST.length ? pubTimesKST.reduce((a,b)=>a>b?a:b) : null;
  const earliest = pubTimesKST.length ? pubTimesKST.reduce((a,b)=>a<b?a:b) : null;
  const latestStr   = latest   ? `${pad(latest.getUTCMonth()+1)}-${pad(latest.getUTCDate())}(${pad(latest.getUTCHours())}:${pad(latest.getUTCMinutes())})` : "N/A";
  const earliestStr = earliest ? `${pad(earliest.getUTCMonth()+1)}-${pad(earliest.getUTCDate())}(${pad(earliest.getUTCHours())}:${pad(earliest.getUTCMinutes())})` : "N/A";

  return { collected, loopReports, latestStr, earliestStr, latestKST: latest };
}

export default {
  // 선택: 상태 확인용 (브라우저 접속 시 OK 반환)
  async fetch(_req: Request, env: Env): Promise<Response> {
    return new Response(`OK: ${env.APP_NAME ?? "fca-news"}`);
  },

  // ⏰ KST 짝수시 정각에만 호출됨(크론)
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const nowUTC = new Date(event.scheduledTime);
      const nowKST = toKST(nowUTC);

      // 같은 타겟(짝수시 정각)에 한 번만 발송
      const { targetUTC } = computeTargetKST(nowUTC);
      const targetIso = targetUTC.toISOString();
      const lastSent = await env.FCANEWS_KV.get(KV_LAST_SENT);
      if (lastSent === targetIso) {
        console.log("skip: already sent this even-hour", targetIso);
        return;
      }

      // 1) 네이버 검색 + 필터
      const { collected, loopReports, latestStr, earliestStr, latestKST } = await searchRecentNews(env);

      // 2) 발송 정책: 강제시간/최소건수
      const MIN_SEND_THRESHOLD = Number(env.MIN_SEND_THRESHOLD || "3");
      const forceHours = new Set([0,8,10,12,14,16,18,20,22]); // 필요 시 조정
      const shouldSend = forceHours.has(nowKST.getUTCHours())
        ? (collected.length >= 1)
        : (collected.length >= MIN_SEND_THRESHOLD);

      // 3) 본채널 발송
      if (shouldSend && collected.length > 0) {
        const body = collected.map((it, i) =>
          `${i+1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`
        ).join("\n");
        await sendTelegram(body, env.TELEGRAM_CHAT_ID, env);

        // 상태 업데이트
        await env.FCANEWS_KV.put(KV_LAST_SENT, targetIso);
        if (latestKST) {
          const latestUTC = new Date(latestKST.getTime() - KST_MS);
          await env.FCANEWS_KV.put(KV_LAST_CHECKED, latestUTC.toISOString());
        }
      }

      // 4) 관리자 리포트
      const total_latest = loopReports.reduce((s, r) => s + (r.time_filtered || 0), 0);
      const total_excl   = loopReports.reduce((s, r) => s + (r.title_exclude_hit || 0), 0);
      const total_pass   = loopReports.reduce((s, r) => s + (r.title_include_pass || 0), 0);
      const icon = (shouldSend && collected.length > 0) ? "✅" : "⏸️";
      const status = (shouldSend && collected.length > 0) ? "발송" : "보류";

      const lines: string[] = [];
      lines.push(`${icon} ${status} [${collected.length}건] (${fmt(nowKST)} KST 기준)`);
      lines.push(`(제외${total_excl}) 제목통과 ${total_pass} / 최신${total_latest}`);
      for (const r of loopReports) {
        lines.push(`(${r.call_no}차) 최신${r.time_filtered} / 호출${r.fetched}`);
      }
      lines.push(`(최신) ${latestStr} ~ ${earliestStr}`);
      await sendTelegram(lines.join("\n"), env.ADMIN_CHAT_ID, env);
    } catch (e:any) {
      // 에러는 관리자에게도 알림
      await sendTelegram(`❗️ fca-news error\n${String(e?.message || e)}`, (env.ADMIN_CHAT_ID), env);
      console.error(e);
    }
  },
} satisfies ExportedHandler<Env>;
