export interface Env {
  TELEGRAM_BOT_TOKEN: string; // wrangler secret
  TELEGRAM_CHAT_ID: string;   // wrangler secret
  APP_NAME?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtUTC = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600 * 1000);

async function sendTelegram(text: string, env: Env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
}

export default {
  // 선택: 수동 테스트 엔드포인트(원치 않으면 이 fetch 블록 삭제)
  async fetch(_req: Request, env: Env): Promise<Response> {
    const nowUTC = new Date();
    const nowKST = addHours(nowUTC, 9);
    const nextUTC = addHours(nowUTC, 2);           // 짝수시 주기(2h)
    const nextKST = addHours(nowKST, 2);
    const text = [
      `🧪 manual ping (${env.APP_NAME ?? "fca-news"})`,
      `• NOW  UTC: ${fmtUTC(nowUTC)} UTC`,
      `• NOW  KST: ${fmtUTC(nowKST)} KST`,
      `• NEXT UTC: ${fmtUTC(nextUTC)} UTC`,
      `• NEXT KST: ${fmtUTC(nextKST)} KST`,
      "• policy: KST 짝수시 00분에만 발송(크론으로 보장)"
    ].join("\n");
    await sendTelegram(text, env);
    return new Response("OK");
  },

  // ⏰ 크론이 정확히 KST 짝수시 정각에 호출함(UTC 1,3,5,7,9,11,13,15,17,19,21,23)
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const nowUTC = new Date(event.scheduledTime);
    const nowKST = addHours(nowUTC, 9);
    const nextUTC = addHours(nowUTC, 2);  // 다음 호출은 2시간 뒤
    const nextKST = addHours(nowKST, 2);

    const text = [
      `✅ ${env.APP_NAME ?? "fca-news"} cron fired`,
      `• cron: \`${event.cron}\``,
      `• NOW  UTC: ${fmtUTC(nowUTC)} UTC`,
      `• NOW  KST: ${fmtUTC(nowKST)} KST`,
      `• NEXT UTC: ${fmtUTC(nextUTC)} UTC`,
      `• NEXT KST: ${fmtUTC(nextKST)} KST`,
      "• policy: KST 짝수시 00분에만 발송(게이트 제거)"
    ].join("\n");

    await sendTelegram(text, env);
  },
} satisfies ExportedHandler<Env>;
