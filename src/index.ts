export interface Env {
  // Secrets (대시보드에 Secret으로 존재해야 함)
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ADMIN_CHAT_ID: string;

  // Vars (wrangler.toml의 [vars])
  APP_NAME?: string;
  SEARCH_KEYWORDS?: string;
  INCLUDE_KEYWORDS?: string;
  EXCLUDE_KEYWORDS?: string;
  DISPLAY_PER_CALL?: string;   // "30"
  MAX_LOOPS?: string;          // "3"
  MIN_SEND_THRESHOLD?: string; // "3"

  // KV (wrangler.toml [[kv_namespaces]] 바인딩)
  FCANEWS_KV: KVNamespace;
}

/* ───────────────────────────────────── helpers ───────────────────────────────────── */
const KST_MS = 9 * 3600 * 1000;
const toKST = (d: Date) => new Date(d.getTime() + KST_MS);
const pad = (n: number) => String(n).padStart(2, "0");
const fmtUTC = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

const KV_LAST_SENT    = "last_sent_target_iso";   // 짝수시 정각(UTC) ISO 저장
const KV_LAST_CHECKED = "last_checked_time_iso";  // 마지막 본 기사 시각(UTC) ISO 저장

function splitList(v?: string): string[] {
  if (!v) return [];
  return v.split(",").map(s => s.trim()).filter(Boolean);
}
function escapeHtml(s: string) {
  return s.replace(/&/g,"&amp;")
          .replace(/</g,"&lt;")
          .replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;");
}
// 추적파라미터 제거 + https 고정 → 링크 중복 방지 도움
function normalizeUrl(u: string) {
  try {
    const url = new URL(u);
    url.protocol = "https:";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","fbclid","gclid"].forEach(k=>url.searchParams.delete(k));
    return url.toString();
  } catch { return u.trim(); }
}
function parsePubToKST(pub: string): Date | null {
  try {
    const dt = new Date(pub);
    if (String(dt) === "Invalid Date") return null;
    return new Date(dt.getTime() + KST_MS);
  } catch { return null; }
}
// “이번 타임” 목표 짝수시 정각(KST) 계산 → UTC로 변환하여 ISO 저장
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
    })
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("Telegram send failed", res.status, t);
  }
}

/* ───────────────────────────────────── NAVER fetch + filter ───────────────────────────────────── */
async function searchRecentNews(env: Env) {
  const CLIENT_ID = env.NAVER_CLIENT_ID;
  const CLIENT_SECRET = env.NAVER_CLIENT_SECRET;
  const DISPLAY = Math.min(Math.max(Number(env.DISPLAY_PER_CALL || "30"), 1), 100);
  const MAX_LOOPS = Math.min(Math.max(Number(env.MAX_LOOPS || "3"), 1), 10);

  const searchKeywords = splitList(env.SEARCH_KEYWORDS);
  const includeKeywords = splitList(env.INCLUDE_KEYWORDS);
  const excludeKeywords = splitList(env.EXCLUDE_KEYWORDS);

  const base = "https://openapi.naver.com/v1/search/news.json";
  const query = encodeURIComponent(searchKeywords.join(" ").trim());
  const headers: Record<string,string> = {
    "X-Naver-Client-Id": CLIENT_ID,
    "X-Naver-Client-Secret": CLIENT_SECRET,
    "User-Agent": "Mozilla/5.0 (compatible; fcanews/1.0)"
  };

  const lastCheckedUTC = await env.FCANEWS_KV.get(KV_LAST_CHECKED);
  const lastChecked = lastCheckedUTC ? new Date(lastCheckedUTC) : null;

  const seen = new Set<string>();
  const collected: Array<{ title: string; link: string; pubKST: Date }> = [];
  const loopReports: Array<{call_no:number; fetched:number; time_filtered:number; title_include_fail:number; title_exclude_hit:number; title_include_pass:number;}> = [];
  const pubTimesKST: Date[] = [];

  let stopDueToOld = false;

  for (let page = 1; page <= MAX_LOOPS; page++) {
    const start = (page - 1) * DISPLAY + 1;
    const url = `${base}?query=${query}&display=${DISPLAY}&start=${start}&sort=date`;

    const r = await fetch(url, { method:"GET", headers, cf:{ cacheTtl:0 } });
    if (!r.ok) {
      console.error("NAVER error", r.status, await r.text());
      break;
    }
    const data = await r.json();
    const items: any[] = data?.items || [];
    if (!items.length) break;

    let fetched = items.length, time_filtered = 0, title_include_fail = 0, title_exclude_hit = 0;

    for (const it of items) {
      const title = String(it?.title || "").replace(/<b>/g,"").replace(/<\/b>/g,"");
      const link  = normalizeUrl(String(it?.link || "").trim());
      const pubKST = parsePubToKST(String(it?.pubDate || ""));
      if (!pubKST) continue;

      // 시간 필터(이전 실행 이후만 수집)
      if (lastChecked && pubKST.getTime() <= lastChecked.getTime()) { stopDueToOld = true; continue; }
      time_filtered++;
      pubTimesKST.push(pubKST);

      // 포함/제외 필터
      let includeOk = true;
      if (includeKeywords.length) {
        const t = title.toLowerCase();
        includeOk = includeKeywords.some(k => t.includes(k.toLowerCase()));
      }
      if (!includeOk) { title_include_fail++; continue; }

      if (excludeKeywords.length) {
        const t = title.toLowerCase();
        if (excludeKeywords.some(k => t.includes(k.toLowerCase()))) { title_exclude_hit++; continue; }
      }

      // 링크 중복 제거
      if (seen.has(link)) continue;
      seen.add(link);

      collected.push({ title, link, pubKST });
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

  const latest = pubTimesKST.length ? pubTimesKST.reduce((a,b)=> a>b ? a : b) : null;
  const earliest = pubTimesKST.length ? pubTimesKST.reduce((a,b)=> a<b ? a : b) : null;

  const latestStr   = latest   ? `${pad(latest.getUTCMonth()+1)}-${pad(latest.getUTCDate())}(${pad(latest.getUTCHours())}:${pad(latest.getUTCMinutes())})` : "N/A";
  const earliestStr = earliest ? `${pad(earliest.getUTCMonth()+1)}-${pad(earliest.getUTCDate())}(${pad(earliest.getUTCHours())}:${pad(earliest.getUTCMinutes())})` : "N/A";

  return { collected, loopReports, latestStr, earliestStr, latestKST: latest };
}

/* ───────────────────────────────────── policy helpers ───────────────────────────────────── */
function computeShouldSend(nowKST: Date, candidateCount: number, minSend: number) {
  const FORCE = new Set([0,8,10,12,14,16,18,20,22]); // 필요시 조정
  return FORCE.has(nowKST.getUTCHours())
    ? (candidateCount >= 1)
    : (candidateCount >= minSend);
}

/* ───────────────────────────────────── HTTP handlers ───────────────────────────────────── */
async function handleTestPreview(env: Env) {
  // 1) 지금 시각 기준 수집/필터
  const { collected, loopReports, latestStr, earliestStr } = await searchRecentNews(env);

  // 2) 이번 타임 보낼지 여부(운영 정책과 동일)
  const nowUTC = new Date();
  const nowKST = toKST(nowUTC);
  const minSend = Math.max(Number(env.MIN_SEND_THRESHOLD || "3"), 0);
  const shouldSend = computeShouldSend(nowKST, collected.length, minSend);

  // 3) 관리자 채널로만 미리보기 전송 (본 채널로는 안 보냄)
  const totalLatest = loopReports.reduce((s, r) => s + (r.time_filtered || 0), 0);
  const totalExcl   = loopReports.reduce((s, r) => s + (r.title_exclude_hit || 0), 0);
  const totalPass   = loopReports.reduce((s, r) => s + (r.title_include_pass || 0), 0);

  const head = `🧪 TEST PREVIEW [${collected.length}건] (${fmtUTC(nowKST)} KST)\n• 정책결과: ${shouldSend ? "보낼 예정(조건 충족)" : "보류 예정(조건 미충족)"}\n• 임계값(MIN_SEND_THRESHOLD): ${minSend}`;
  const loops = [
    `(집계) (제외${totalExcl}) 제목통과 ${totalPass} / 최신${totalLatest}`,
    ...loopReports.map(r => `(${r.call_no}차) 최신${r.time_filtered} / 호출${r.fetched}`),
    `(최신) ${latestStr} ~ ${earliestStr}`
  ].join("\n");
  const body = collected.map((it, i) => `${i+1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`).join("\n");

  await sendTelegram([head, loops, body || "— 후보 없음 —"].join("\n"), env.ADMIN_CHAT_ID, env);

  // 4) HTTP 응답(JSON)도 함께 반환
  return new Response(JSON.stringify({
    shouldSend,
    minSend,
    count: collected.length,
    items: collected.map((it) => ({ title: it.title, link: it.link })),
    loopReports,
    latestStr, earliestStr
  }, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8" }});
}

/* ───────────────────────────────────── Worker ───────────────────────────────────── */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ✅ 테스트 미리보기: 네이버 호출/필터 → 관리자 채널로만 전송 + JSON 응답
    if (url.pathname === "/test") {
      return await handleTestPreview(env); // 토큰 없이 공개 사용 (요청하신 대로)
    }

    // 기본 헬스체크
    const now = new Date();
    const { targetKST, targetUTC } = computeTargetKST(now);
    return new Response(
      `${env.APP_NAME ?? "fca-news"} OK\nNOW UTC: ${fmtUTC(now)}\nNEXT KST: ${fmtUTC(targetKST)}\nNEXT UTC: ${fmtUTC(targetUTC)}\n`,
      { status: 200 }
    );
  },

  // ⏰ KST 짝수시 정각 크론
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const nowUTC = new Date(event.scheduledTime);
      const { targetUTC } = computeTargetKST(nowUTC);
      const targetIso = targetUTC.toISOString();

      // 같은 타임 중복 발송 방지
      const lastSent = await env.FCANEWS_KV.get(KV_LAST_SENT);
      if (lastSent === targetIso) { console.log("SKIP: already sent", targetIso); return; }

      // 1) 네이버 호출/필터
      const { collected, loopReports, latestStr, earliestStr, latestKST } = await searchRecentNews(env);

      // 2) 발송 정책
      const nowKST = toKST(nowUTC);
      const minSend = Math.max(Number(env.MIN_SEND_THRESHOLD || "3"), 1);
      const shouldSend = computeShouldSend(nowKST, collected.length, minSend);

      // 3) 본채널 발송
      if (shouldSend && collected.length > 0) {
        const body = collected.map((it, i) => `${i+1}. <b>${escapeHtml(it.title)}</b>\n${it.link}`).join("\n");
        await sendTelegram(body, env.TELEGRAM_CHAT_ID, env);

        // 상태 업데이트
        await env.FCANEWS_KV.put(KV_LAST_SENT, targetIso);
        if (latestKST) {
          const latestUTC = new Date(latestKST.getTime() - KST_MS);
          await env.FCANEWS_KV.put(KV_LAST_CHECKED, latestUTC.toISOString());
        }
      }

      // 4) 관리자 리포트
      const totalLatest = loopReports.reduce((s, r) => s + (r.time_filtered || 0), 0);
      const totalExcl   = loopReports.reduce((s, r) => s + (r.title_exclude_hit || 0), 0);
      const totalPass   = loopReports.reduce((s, r) => s + (r.title_include_pass || 0), 0);
      const icon   = (shouldSend && collected.length > 0) ? "✅" : "⏸️";
      const status = (shouldSend && collected.length > 0) ? "발송" : "보류";

      const lines: string[] = [];
      lines.push(`${icon} ${status} [${collected.length}건] (${fmtUTC(toKST(nowUTC))} KST 기준)`);
      lines.push(`(제외${totalExcl}) 제목통과 ${totalPass} / 최신${totalLatest}`);
      for (const r of loopReports) lines.push(`(${r.call_no}차) 최신${r.time_filtered} / 호출${r.fetched}`);
      lines.push(`(최신) ${latestStr} ~ ${earliestStr}`);
      await sendTelegram(lines.join("\n"), env.ADMIN_CHAT_ID, env);
    } catch (e:any) {
      await sendTelegram(`❗️ fca-news error\n${String(e?.message || e)}`, env.ADMIN_CHAT_ID, env);
      console.error(e);
    }
  },
} satisfies ExportedHandler<Env>;
