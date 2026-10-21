// 订阅日历：苹果日历定期来访问这个网址，按台账里"还没完成的提醒"现生成一份 .ics 返回。
// 口径跟网页提醒事项页（getActiveReminders）一致：
//   - 岗位级：已提交、没删的岗位，stage_deadlines 里有日期的环节，progress 里没打勾的
//   - 公司级：名下有已提交岗位的公司，stage_deadlines 里有日期、done 不为 true 的
// 网址里必须带 ?token=...，跟 calendar_feed_tokens 表里的对上才返回数据。
import { createClient } from "npm:@supabase/supabase-js@2";

const STAGE_LABEL: Record<string, string> = {
  assessment: "测评", written: "笔试", groupInterview: "群面", aiInterview: "AI面",
  interview1: "一面", interview2: "二面", offered: "Offered", ended: "结束",
};

const esc = (t: unknown) => String(t ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const enc = new TextEncoder();
// 每行不超过 75 字节，超了折到下一行（续行开头一个空格）
function fold(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const normLink = (u: unknown) => {
  const s = String(u ?? "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
};

type Item = { uid: string; title: string; date: string; desc: string; link: string };

function buildIcs(items: Item[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//wangshen-tracker//feed//CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:网申提醒", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  for (const it of items) {
    const [d, t] = it.date.split("T");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const [Y, M, D] = d.split("-").map(Number);
    lines.push("BEGIN:VEVENT", `UID:${it.uid}@wangshen-tracker`, `DTSTAMP:${stamp}`);
    if (t && /^\d{1,2}:\d{2}/.test(t)) {
      const [hh, mm] = t.split(":").map(Number);
      // 时间不带时区（浮动时间），按手机/电脑当地时间显示，跟网页一样
      const start = new Date(Date.UTC(Y, M - 1, D, hh, mm));
      const end = new Date(start.getTime() + 30 * 60000);
      const hm = (x: Date) => `${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`;
      lines.push(`DTSTART:${ymd(start)}T${hm(start)}`, `DTEND:${ymd(end)}T${hm(end)}`);
    } else {
      const next = new Date(Date.UTC(Y, M - 1, D + 1));
      lines.push(`DTSTART;VALUE=DATE:${d.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${ymd(next)}`);
    }
    lines.push(`SUMMARY:${esc(it.title)}`);
    if (it.desc) lines.push(`DESCRIPTION:${esc(it.desc)}`);
    if (it.link) lines.push(`URL:${esc(it.link)}`);
    // 有具体时间：提前 1 天、提前 1 小时；全天：前一天 9 点、当天 9 点
    for (const tr of (t ? ["-P1D", "-PT1H"] : ["-PT15H", "PT9H"])) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(it.title)}`, `TRIGGER:${tr}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

Deno.serve(async (req: Request) => {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!/^[0-9a-f]{64}$/.test(token)) return new Response("not found", { status: 404 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: tok } = await sb.from("calendar_feed_tokens").select("sync_id").eq("token", token).maybeSingle();
  if (!tok) return new Response("not found", { status: 404 });
  const syncId = tok.sync_id;

  const [{ data: comps, error: e1 }, { data: poss, error: e2 }] = await Promise.all([
    sb.from("companies").select("id,name,deleted,stage_deadlines").eq("sync_id", syncId),
    sb.from("positions").select("id,company_id,position,status,deleted,link,progress,stage_deadlines").eq("sync_id", syncId),
  ]);
  if (e1 || e2) return new Response("error", { status: 500 });

  const companyById = new Map((comps || []).filter((c) => !c.deleted).map((c) => [c.id, c]));
  const submitted = (poss || []).filter((p) => !p.deleted && p.status === "submitted");
  const byCompany = new Map<string, typeof submitted>();
  for (const p of submitted) {
    if (!byCompany.has(p.company_id)) byCompany.set(p.company_id, []);
    byCompany.get(p.company_id)!.push(p);
  }
  // 公司默认链接：名下已提交岗位里出现最多的那个
  const companyLink = (cid: string) => {
    const counts = new Map<string, number>();
    for (const p of byCompany.get(cid) || []) {
      const l = normLink(p.link);
      if (l) counts.set(l, (counts.get(l) || 0) + 1);
    }
    let best = "", n = 0;
    counts.forEach((c, l) => { if (c > n) { best = l; n = c; } });
    return best;
  };
  const label = (k: string) => STAGE_LABEL[k] || k;
  const entryOf = (v: unknown) => {
    if (!v) return null;
    if (typeof v === "string") return { date: v, note: "", booked: false, done: false };
    const o = v as Record<string, unknown>;
    return { date: String(o.date || ""), note: String(o.note || ""), booked: !!o.booked, done: !!o.done };
  };
  const cleanNote = (n: string) => n.replace(/\*\*(.+?)\*\*/g, "$1");

  const items: Item[] = [];
  for (const p of submitted) {
    const company = companyById.get(p.company_id);
    if (!company) continue;
    const progress = (p.progress || {}) as Record<string, unknown>;
    for (const [key, v] of Object.entries((p.stage_deadlines || {}) as Record<string, unknown>)) {
      const e = entryOf(v);
      if (!e || !e.date || progress[key]) continue;
      items.push({
        uid: `position-${p.id}-${key}`,
        title: `${company.name} · ${label(key)}`,
        date: e.date,
        desc: [p.position || "", e.note ? cleanNote(e.note) : "", e.booked ? "已预约" : ""].filter(Boolean).join("\n"),
        link: normLink(p.link) || companyLink(p.company_id),
      });
    }
  }
  for (const [cid] of byCompany) {
    const company = companyById.get(cid);
    if (!company) continue;
    for (const [key, v] of Object.entries((company.stage_deadlines || {}) as Record<string, unknown>)) {
      const e = entryOf(v);
      if (!e || !e.date || e.done) continue;
      items.push({
        uid: `company-${cid}-${key}`,
        title: `${company.name} · ${label(key)}`,
        date: e.date,
        desc: ["全部岗位通用", e.note ? cleanNote(e.note) : "", e.booked ? "已预约" : ""].filter(Boolean).join("\n"),
        link: companyLink(cid),
      });
    }
  }

  return new Response(buildIcs(items), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="wangshen.ics"',
      "Cache-Control": "no-cache",
    },
  });
});
