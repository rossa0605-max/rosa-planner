// Rosa 플래너 푸시 알림 발송
// - cron(5분마다): { secret } 로 호출 → 마감 미리 알림 / 마감 알림 / 아침 요약
// - 앱의 "테스트 알림": Authorization: Bearer <사용자 토큰>, { action: "test" }
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CATS: Record<string, string> = { academy: "영어 학원", online: "온라인 사업", personal: "개인" };
const KST = 9 * 3600_000;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

type Item = {
  id: string; user_id: string; title: string; cat: string;
  date: string | null; time: string | null; due_date: string | null; due_time: string | null;
  remind: number; done: boolean; prio: string;
};
type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

// 앱과 같은 규칙: 마감일이 있으면 마감, 없으면 일정 시각. 시간이 없으면 23:59 (한국 시간)
function dueAt(it: Item): number | null {
  const d = it.due_date || it.date;
  if (!d) return null;
  const t = it.due_date ? (it.due_time || "23:59") : (it.time || "23:59");
  return Date.parse(`${d}T${t}:00+09:00`);
}
function remain(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}분`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}시간`;
  return `${Math.round(h / 24)}일`;
}
function kstDate(ms: number) { return new Date(ms + KST).toISOString().slice(0, 10); }

async function config() {
  const { data, error } = await db.from("planner_config").select("name,value");
  if (error) throw error;
  const c = Object.fromEntries(data.map((r) => [r.name, r.value]));
  webpush.setVapidDetails("mailto:planner@example.com", c.vapid_public, c.vapid_private);
  return c;
}

async function sendTo(subs: Sub[], payload: object) {
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("planner_push_subs").delete().eq("id", s.id);
      else console.error("push failed", code, (e as Error).message);
    }
  }
  return sent;
}

// 처음 보내는 알림이면 true (중복 발송 방지)
async function claim(user_id: string, key: string) {
  const { data, error } = await db.from("planner_sent")
    .upsert({ user_id, key }, { onConflict: "user_id,key", ignoreDuplicates: true }).select();
  if (error) throw error;
  return data.length > 0;
}

async function runCron() {
  const now = Date.now();
  const { data: subs } = await db.from("planner_push_subs").select("*");
  if (!subs?.length) return { sent: 0 };
  const byUser = new Map<string, Sub[]>();
  for (const s of subs as Sub[]) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);
  const users = [...byUser.keys()];

  const { data: items } = await db.from("planner_items").select("*").in("user_id", users).eq("done", false);
  let sent = 0;

  for (const it of (items || []) as Item[]) {
    if (!it.remind) continue;
    const due = dueAt(it);
    if (due == null) continue;
    const ms = due - now;
    const tag = `[${CATS[it.cat] || ""}] `;
    if (ms > 0 && ms <= it.remind * 60000 && await claim(it.user_id, `r:${it.id}:${due}`)) {
      sent += await sendTo(byUser.get(it.user_id)!, {
        title: `⏰ ${it.due_date ? "마감" : "일정"} ${remain(ms)} 전`, body: tag + it.title, tag: it.id,
      });
    }
    if (ms <= 0 && ms > -3600_000 && await claim(it.user_id, `d:${it.id}:${due}`)) {
      sent += await sendTo(byUser.get(it.user_id)!, {
        title: it.due_date ? "⚠️ 마감 시간이에요" : "📅 일정 시작 시간이에요", body: tag + it.title, tag: it.id,
      });
    }
  }

  // 아침 요약
  const { data: settings } = await db.from("planner_settings").select("*").in("user_id", users);
  const setMap = new Map((settings || []).map((s) => [s.user_id, s]));
  const kNow = new Date(now + KST);
  const today = kstDate(now);
  for (const u of users) {
    const st = setMap.get(u) || { summary_on: true, summary_hour: 7 };
    if (!st.summary_on) continue;
    if (kNow.getUTCHours() !== st.summary_hour || kNow.getUTCMinutes() >= 30) continue;
    if (!await claim(u, `s:${today}`)) continue;
    const mine = ((items || []) as Item[]).filter((i) => i.user_id === u);
    const todays = mine.filter((i) => i.date === today || i.due_date === today);
    const overdue = mine.filter((i) => { const d = dueAt(i); return d != null && d < now; });
    const high = todays.filter((i) => i.prio === "high");
    const lines = [
      `오늘 일정·마감 ${todays.length}개` + (high.length ? ` (중요 ${high.length})` : ""),
      overdue.length ? `마감 지난 일 ${overdue.length}개` : "",
      ...todays.slice(0, 4).map((i) => `• ${i.time || i.due_time ? (i.time || i.due_time) + " " : ""}${i.title}`),
    ].filter(Boolean);
    sent += await sendTo(byUser.get(u)!, { title: "☀️ 오늘의 플래너", body: lines.join("\n"), tag: `summary-${today}` });
  }

  // 오래된 발송 기록 정리
  await db.from("planner_sent").delete().lt("sent_at", new Date(now - 60 * 86400_000).toISOString());
  return { sent };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const c = await config();
    const body = await req.json().catch(() => ({}));

    if (body.action === "test") {
      const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: { user } } = await db.auth.getUser(token);
      if (!user) return new Response("unauthorized", { status: 401, headers: cors });
      const { data: subs } = await db.from("planner_push_subs").select("*").eq("user_id", user.id);
      const sent = await sendTo((subs || []) as Sub[], { title: "🔔 테스트 알림", body: "알림이 잘 도착했어요!", tag: "test" });
      return Response.json({ sent, devices: subs?.length || 0 }, { headers: cors });
    }

    if (body.secret !== c.cron_secret) return new Response("forbidden", { status: 403, headers: cors });
    return Response.json(await runCron(), { headers: cors });
  } catch (e) {
    console.error(e);
    return new Response(String((e as Error).message || e), { status: 500, headers: cors });
  }
});
