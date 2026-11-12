// Nation's Pure CRM — "send-texts" Supabase Edge Function (TextMagic)
// Secrets needed (Edge Functions → Secrets): TM_USERNAME, TM_API_KEY, TM_FROM_NUMBER, WEBHOOK_SECRET
// Turn OFF "Enforce JWT verification" for this function (it checks its own secret / login).
// Source of truth is the deployed function in Supabase; this copy is kept in the repo for reference.
import { createClient } from "npm:@supabase/supabase-js@2";

const TM_USERNAME = Deno.env.get("TM_USERNAME") ?? "";
const TM_API_KEY = Deno.env.get("TM_API_KEY") ?? "";
const TM_FROM = toPhone(Deno.env.get("TM_FROM_NUMBER") ?? "") ?? "";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Trigger = "new_lead" | "rep_assigned" | "won";
type Lead = Record<string, any>;

function digits(s: string) { return (s || "").replace(/\D/g, ""); }
function toPhone(s: string): string | null {
  const d = digits(s);
  if (d.length === 10) return "1" + d;
  if (d.length === 11 && d.startsWith("1")) return d;
  return null;
}
function clean(s: unknown) { return String(s ?? "").trim(); }
function sameName(a: unknown, b: unknown) { return clean(a).toLowerCase() === clean(b).toLowerCase(); }
function fmtAppt(date: string, start: string) {
  if (!date) return "";
  const d = new Date(date + "T12:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (!start) return day;
  const [h, m] = start.split(":").map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${day} at ${hh}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function money(n: unknown) {
  const v = Number(n);
  return isFinite(v) && v > 0 ? "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "";
}
function lines(...parts: (string | false | null | undefined)[]) {
  return parts.filter((p) => p && String(p).trim()).join("\n");
}

async function recipients(trigger: Trigger): Promise<string[]> {
  const { data } = await admin.from("notify_recipients").select("phone").eq("trigger_type", trigger).eq("active", true);
  return (data ?? []).map((r) => toPhone(r.phone)).filter(Boolean) as string[];
}
async function repPhone(repName: string): Promise<string | null> {
  if (!clean(repName)) return null;
  const { data } = await admin.from("rep_phones").select("rep_name, phone");
  const row = (data ?? []).find((r) => sameName(r.rep_name, repName));
  return row ? toPhone(row.phone) : null;
}

async function sendSms(trigger: string, leadId: string | null, phones: string[], text: string) {
  const to = [...new Set(phones)];
  if (!to.length) return { ok: true, skipped: true };
  let ok = false, error: string | null = null;
  try {
    const body: Record<string, string> = { text, phones: to.join(",") };
    if (TM_FROM) body.from = TM_FROM;
    const res = await fetch("https://rest.textmagic.com/api/v2/messages", {
      method: "POST",
      headers: { "X-TM-Username": TM_USERNAME, "X-TM-Key": TM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    ok = res.ok;
    if (!ok) error = `TextMagic ${res.status}: ${(await res.text()).slice(0, 400)}`;
  } catch (e) {
    error = String(e);
  }
  await admin.from("text_log").insert({ trigger_type: trigger, lead_id: leadId, to_phones: to, body: text, ok, error });
  return { ok, error };
}

// ---------- messages ----------
function newLeadText(l: Lead) {
  return lines(
    `Nation's Pure – ${clean(l.channel) === "service" ? "NEW SERVICE LEAD" : "NEW LEAD"}: ${clean(l.name) || "Unnamed"}`,
    clean(l.phone),
    clean(l.address),
    clean(l.need) && `Needs: ${clean(l.need)}`,
    clean(l.created_by_name) && `Added by ${clean(l.created_by_name)}`,
  );
}
function repText(l: Lead, forRep: boolean) {
  const appt = fmtAppt(clean(l.appt_date), clean(l.appt_start));
  const head = forRep
    ? `Nation's Pure – You've been assigned ${clean(l.name) || "a lead"}${appt ? ` for ${appt}` : ""}`
    : `Nation's Pure – ${clean(l.name) || "A lead"} assigned to ${clean(l.assigned_rep)}${appt ? ` for ${appt}` : ""}`;
  return lines(head, clean(l.address), clean(l.phone), clean(l.need) && `Needs: ${clean(l.need)}`);
}
function wonText(l: Lead) {
  return lines(
    `Nation's Pure – DEAL WON: ${clean(l.name) || "Customer"}`,
    [clean(l.system_name), money(l.sale_price)].filter(Boolean).join(" – "),
    clean(l.assigned_rep) && `Rep: ${clean(l.assigned_rep)}`,
  );
}

async function sendRepAssigned(l: Lead) {
  const leadId = l.id ? String(l.id) : null;
  const rep = await repPhone(l.assigned_rep);
  const extras = (await recipients("rep_assigned")).filter((p) => p !== rep);
  const results = [];
  if (rep) results.push(await sendSms("rep_assigned", leadId, [rep], repText(l, true)));
  else await admin.from("text_log").insert({
    trigger_type: "rep_assigned", lead_id: leadId, to_phones: [], ok: false,
    body: repText(l, true), error: `No cell number saved for rep "${clean(l.assigned_rep)}"`,
  });
  if (extras.length) results.push(await sendSms("rep_assigned", leadId, extras, repText(l, false)));
  return results;
}

// ---------- day-before appointment confirmations to customers ----------
// Called every afternoon by the database (pg_cron job "appt-reminders"). Only sends during the
// 5 PM hour in Dallas time so daylight saving doesn't matter, and never texts the same
// appointment twice (leads.reminder_sent_for remembers the date + time it was sent for).
const OFFICE_PHONE = "817-238-0050";
const TZ = "America/Chicago";
const SEND_HOUR = 17;

function ymdIn(ms: number) { return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ }); }
function hourIn() { return Number(new Date().toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" })); }
function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// "Hi Rachel," for a person; "Hi," for accounts like "KENT KWIK-461 (986179)" or "Erica Renteria - McCamey ISD"
function greetingName(name: string) {
  const n = clean(name);
  if (!n || /\d|\s-\s|c\/o|,/i.test(n)) return "";
  const f = n.split(/\s+/)[0];
  if (!/^[A-Za-z'’-]{2,}$/.test(f)) return "";
  // keep initials like "GG" as typed; fix "ANNIE" / "annie" to "Annie"
  if (f.length <= 2) return f.toUpperCase();
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}
function firstOf(name: string) { return clean(name).split(/\s+/)[0] || ""; }
function reminderText(l: Lead) {
  const who = greetingName(l.name);
  const rep = firstOf(l.assigned_rep);
  const when = fmtAppt(clean(l.appt_date), clean(l.appt_start)).replace(/^(\w+), /, "$1 ");
  // kept under 160 characters so it goes out as a single text
  return `Hi${who ? " " + who : ""}, Nation's Pure confirming your appointment tomorrow, ${when}${rep ? ` with ${rep}` : ""}. ` +
    `To cancel or reschedule, call ${OFFICE_PHONE}.`;
}

async function sendReminders(opts: { force?: boolean; dry?: boolean }) {
  if (!opts.force && hourIn() !== SEND_HOUR) return { skipped: `not ${SEND_HOUR}:00 hour in Dallas` };
  const tomorrow = addDays(ymdIn(Date.now()), 1);
  const { data, error } = await admin.from("leads")
    .select("id, name, phone, appt_date, appt_start, assigned_rep, stage, reminder_sent_for")
    .eq("appt_date", tomorrow);
  if (error) throw error;
  const out: unknown[] = [];
  for (const l of data ?? []) {
    if (["won", "lost"].includes(clean(l.stage))) continue;          // only appointments that haven't been run yet
    const key = `${clean(l.appt_date)} ${clean(l.appt_start)}`.trim();
    if (clean(l.reminder_sent_for) === key) continue;                // already confirmed this exact appointment
    const text = reminderText(l);
    const phone = toPhone(l.phone);
    if (opts.dry) { out.push({ name: l.name, phone, text }); continue; }
    if (!phone) {
      await admin.from("text_log").insert({ trigger_type: "appt_reminder", lead_id: String(l.id), to_phones: [], ok: false, body: text, error: "No valid customer phone number" });
      out.push({ name: l.name, ok: false, error: "no phone" });
      continue;
    }
    const r = await sendSms("appt_reminder", String(l.id), [phone], text);
    if (r.ok) await admin.from("leads").update({ reminder_sent_for: key }).eq("id", l.id);
    out.push({ name: l.name, ...r });
  }
  return { date: tomorrow, count: out.length, results: out };
}

// ---------- database trigger ----------
async function handleDbEvent(p: { type: string; record: Lead; old_record: Lead | null }) {
  const n = p.record || {}, o = p.old_record || {};
  const leadId = n.id ? String(n.id) : null;
  const out: unknown[] = [];

  if (p.type === "INSERT") {
    out.push(await sendSms("new_lead", leadId, await recipients("new_lead"), newLeadText(n)));
  }

  const hasRep = !!clean(n.assigned_rep);
  const repChanged = !sameName(n.assigned_rep, o.assigned_rep);
  const apptChanged = clean(n.appt_date) !== clean(o.appt_date) || clean(n.appt_start) !== clean(o.appt_start);
  const apptSet = !!clean(n.appt_date);
  if (hasRep && (repChanged || (apptChanged && apptSet))) {
    out.push(await sendRepAssigned(n));
  }

  if (n.stage === "won" && o.stage !== "won") {
    out.push(await sendSms("won", leadId, await recipients("won"), wonText(n)));
  }
  return out;
}

// ---------- "Send test" button ----------
async function handleTest(req: Request, trigger: Trigger) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return json({ error: "Not signed in" }, 401);
  if ((data.user.user_metadata?.role || "manager") === "rep") return json({ error: "Managers only" }, 403);
  if (!["new_lead", "rep_assigned", "won"].includes(trigger)) return json({ error: "Unknown trigger" }, 400);

  const phones = await recipients(trigger);
  if (!phones.length) return json({ error: "No active people on this list yet" }, 400);
  const label = { new_lead: "New lead", rep_assigned: "Rep assigned", won: "Deal won" }[trigger];
  const r = await sendSms(trigger, null, phones, `Nation's Pure – TEST: this number will get "${label}" texts from the CRM.`);
  return r.ok ? json({ ok: true, sent: phones.length }) : json({ error: r.error || "Send failed" }, 502);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (body?.action === "test") return handleTest(req, body.trigger_type);

  const secret = req.headers.get("x-webhook-secret") || "";
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
  try {
    if (body?.action === "reminders") return json({ ok: true, ...(await sendReminders({ force: !!body.force, dry: !!body.dry })) });
    return json({ ok: true, results: await handleDbEvent(body) });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : JSON.stringify(e) }, 500);
  }
});
