// Fair Dinkum online service: session sign-ups and emails.
// Runs on Cloudflare Workers; data in an EU-only D1 database (binding DB).
// Secrets: SETUP_CODE (needed to connect an app), BREVO_API_KEY, SENDER_EMAIL.
// Vars: JOIN_URL, SENDER_NAME, DAILY_EMAIL_LIMIT.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
const KEEP_DAYS = 30;           // sessions (and their sign-ups) are deleted this long after they start

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
}
function err(msg, status = 400) { return json({ error: msg }, status); }
function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:"Segoe UI",system-ui,sans-serif;background:#eef1f4;color:#111a22;margin:0;padding:40px 16px}
main{max-width:520px;margin:auto;background:#fff;border:1px solid #c9d2da;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 10px}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function rand(n = 16) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function clean(s, max = 80) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }
function validEmail(e) { return /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/.test(e) && e.length <= 254; }
function firstName(n) { return String(n || "").trim().split(/\s+/)[0] || "there"; }
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------------------------------------------------------- emails
async function canSend(env, count) {
  const day = new Date().toISOString().slice(0, 10), limit = parseInt(env.DAILY_EMAIL_LIMIT || "280", 10);
  const row = await env.DB.prepare("SELECT n FROM emaillog WHERE day = ?").bind(day).first();
  const used = row ? row.n : 0;
  return Math.max(0, Math.min(count, limit - used));
}
async function noteSent(env, n) {
  if (!n) return;
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO emaillog (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = n + excluded.n").bind(day, n).run();
}
function unsubUrl(env, req, org, p) {
  return new URL(`/u?o=${encodeURIComponent(org)}&p=${encodeURIComponent(p.pid)}&k=${encodeURIComponent(p.token)}`, req ? req.url : env.SELF_URL).toString();
}
function emailHtml(lines, link, linkText, unsub) {
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#111a22;max-width:520px">` +
    lines.map(l => `<p style="margin:0 0 12px">${l}</p>`).join("") +
    (link ? `<p style="margin:18px 0"><a href="${esc(link)}" style="background:#d7f23a;color:#111;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">${esc(linkText)}</a></p>` : "") +
    `<p style="margin:24px 0 0;font-size:12px;color:#56636f">Sent by Fair Dinkum for your pickleball group. ` +
    `<a href="${esc(unsub)}" style="color:#56636f">Stop these emails and forget my address</a>.</p></div>`;
}
async function sendEmail(env, to, name, subject, html) {
  if (env.TEST_MODE === "1") {          // local testing only: keep the email instead of sending it
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS testmail (at INTEGER, addr TEXT, subject TEXT, html TEXT)").run();
    await env.DB.prepare("INSERT INTO testmail VALUES (?, ?, ?, ?)").bind(Date.now(), to, subject, html).run();
    return true;
  }
  if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return false;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ sender: { name: env.SENDER_NAME || "Fair Dinkum", email: env.SENDER_EMAIL }, to: [{ email: to, name }], subject, htmlContent: html })
  });
  return r.status === 201 || r.status === 202;
}
function joinLink(env, s, pid) {
  return `${env.JOIN_URL}?s=${encodeURIComponent(s.id)}&o=${encodeURIComponent(s.org)}&t=${encodeURIComponent(s.token)}` + (pid ? `&p=${encodeURIComponent(pid)}` : "");
}
function sessionLine(s) { return `<b>${esc(s.name)}</b> on <b>${esc(s.when_text)}</b>` + (s.place ? ` at ${esc(s.place)}` : ""); }

// ---------------------------------------------------------------- organiser auth
async function orgFrom(req, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{16,128})$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const row = await env.DB.prepare("SELECT id, key_hash FROM orgs WHERE id = ?").bind(m[1]).first();
  if (!row) return null;
  return sameText(await sha(m[2]), row.key_hash) ? row.id : null;
}
async function getSession(env, org, id) {
  return env.DB.prepare("SELECT * FROM sessions WHERE org = ? AND id = ?").bind(org, id).first();
}

// ---------------------------------------------------------------- organiser API
async function register(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!env.SETUP_CODE || !sameText(String(b.code || ""), env.SETUP_CODE)) return err("That setup code isn't right.", 403);
  const id = rand(9), key = rand(24);
  await env.DB.prepare("INSERT INTO orgs (id, key_hash, name, created) VALUES (?, ?, ?, ?)").bind(id, await sha(key), clean(b.name, 60), Date.now()).run();
  return json({ org: id, key });
}

async function putSession(req, env, org) {
  const b = await req.json().catch(() => null);
  if (!b || !/^[A-Za-z0-9_-]{4,64}$/.test(b.id || "")) return err("Bad session.");
  const starts = Number(b.starts);
  if (!isFinite(starts)) return err("The session needs a date and time.");
  const invited = (Array.isArray(b.invited) ? b.invited : []).slice(0, 300)
    .map(x => ({ pid: clean(x && x.pid, 64), name: clean(x && x.name, 60) })).filter(x => /^[A-Za-z0-9_:+-]{1,64}$/.test(x.pid) && x.name);
  const now = Date.now(), old = await getSession(env, org, b.id);
  const token = old ? old.token : rand(12);
  const remind = Math.max(0, Math.min(168, parseInt(b.remindHours, 10) || 0));
  const st = [];
  if (old) {
    st.push(env.DB.prepare("UPDATE sessions SET name = ?, starts = ?, when_text = ?, place = ?, remind_hours = ?, reminded = CASE WHEN starts = ? THEN reminded ELSE 0 END, updated = ? WHERE org = ? AND id = ?")
      .bind(clean(b.name, 80), starts, clean(b.whenText, 60), clean(b.place, 80), remind, starts, now, org, b.id));
  } else {
    st.push(env.DB.prepare("INSERT INTO sessions (id, org, token, name, starts, when_text, place, remind_hours, reminded, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .bind(b.id, org, token, clean(b.name, 80), starts, clean(b.whenText, 60), clean(b.place, 80), remind, now, now));
  }
  st.push(env.DB.prepare("DELETE FROM invitees WHERE org = ? AND session = ?").bind(org, b.id));
  invited.forEach(x => st.push(env.DB.prepare("INSERT OR REPLACE INTO invitees (org, session, pid, name) VALUES (?, ?, ?, ?)").bind(org, b.id, x.pid, x.name)));
  // keep display names of known people up to date
  invited.forEach(x => st.push(env.DB.prepare("UPDATE people SET name = ? WHERE org = ? AND pid = ?").bind(x.name, org, x.pid)));
  await env.DB.batch(st);
  return json({ ok: true, link: joinLink(env, { id: b.id, org, token }) });
}

async function sessionStatus(env, org, id) {
  const s = await getSession(env, org, id);
  if (!s) return err("Not published.", 404);
  const sign = await env.DB.prepare("SELECT pid, name, status, newcomer, at FROM signups WHERE org = ? AND session = ? ORDER BY at").bind(org, id).all();
  const reach = await env.DB.prepare("SELECT COUNT(*) AS n FROM invitees i JOIN people p ON p.org = i.org AND p.pid = i.pid WHERE i.org = ? AND i.session = ? AND p.email IS NOT NULL AND p.unsub = 0")
    .bind(org, id).first();
  const inv = await env.DB.prepare("SELECT COUNT(*) AS n FROM invitees WHERE org = ? AND session = ?").bind(org, id).first();
  return json({ link: joinLink(env, s), signups: sign.results, invited: inv.n, reachable: reach.n, invitedAt: s.invited_at, reminded: !!s.reminded });
}

async function sendInvites(req, env, org, id) {
  const s = await getSession(env, org, id);
  if (!s) return err("Not published.", 404);
  if (s.starts < Date.now()) return err("That session has already started.");
  const rows = (await env.DB.prepare(`SELECT p.pid, p.name, p.email, p.token FROM invitees i JOIN people p ON p.org = i.org AND p.pid = i.pid
      WHERE i.org = ? AND i.session = ? AND p.email IS NOT NULL AND p.unsub = 0
      AND NOT EXISTS (SELECT 1 FROM signups g WHERE g.org = i.org AND g.session = i.session AND g.pid = i.pid)`).bind(org, id).all()).results;
  const allowed = await canSend(env, rows.length);
  let sent = 0;
  for (const p of rows.slice(0, allowed)) {
    const ok = await sendEmail(env, p.email, p.name, `You're invited: ${s.name}, ${s.when_text}`,
      emailHtml([`Hi ${esc(firstName(p.name))},`, `You're invited to ${sessionLine(s)}.`, `Let us know if you're coming:`],
        joinLink(env, s, p.pid), "I'm in / can't make it", unsubUrl(env, req, org, p)));
    if (ok) sent++;
  }
  await noteSent(env, sent);
  await env.DB.prepare("UPDATE sessions SET invited_at = ? WHERE org = ? AND id = ?").bind(Date.now(), org, id).run();
  const inv = await env.DB.prepare("SELECT COUNT(*) AS n FROM invitees WHERE org = ? AND session = ?").bind(org, id).first();
  return json({ sent, skipped: rows.length - sent, overLimit: rows.length > allowed, invited: inv.n });
}

async function deleteSession(env, org, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE org = ? AND id = ?").bind(org, id),
    env.DB.prepare("DELETE FROM invitees WHERE org = ? AND session = ?").bind(org, id),
    env.DB.prepare("DELETE FROM signups WHERE org = ? AND session = ?").bind(org, id)
  ]);
  return json({ ok: true });
}

async function listPeople(env, org) {
  const r = await env.DB.prepare("SELECT pid, name, CASE WHEN email IS NOT NULL AND unsub = 0 THEN 1 ELSE 0 END AS reachable FROM people WHERE org = ?").bind(org).all();
  return json({ people: r.results });
}

// ---------------------------------------------------------------- player API
async function publicSession(env, url) {
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE org = ? AND id = ?").bind(url.searchParams.get("o") || "", url.searchParams.get("s") || "").first();
  if (!s || !sameText(url.searchParams.get("t") || "", s.token)) return err("This sign-up link isn't valid any more. Ask the organiser for a new one.", 404);
  const inv = (await env.DB.prepare(`SELECT i.pid, i.name, g.status, CASE WHEN p.email IS NOT NULL AND p.unsub = 0 THEN 1 ELSE 0 END AS hasEmail
      FROM invitees i LEFT JOIN signups g ON g.org = i.org AND g.session = i.session AND g.pid = i.pid
      LEFT JOIN people p ON p.org = i.org AND p.pid = i.pid WHERE i.org = ? AND i.session = ? ORDER BY i.name`).bind(s.org, s.id).all()).results;
  const extra = (await env.DB.prepare(`SELECT g.pid, g.name, g.status FROM signups g WHERE g.org = ? AND g.session = ?
      AND NOT EXISTS (SELECT 1 FROM invitees i WHERE i.org = g.org AND i.session = g.session AND i.pid = g.pid) ORDER BY g.name`).bind(s.org, s.id).all()).results;
  return json({ name: s.name, whenText: s.when_text, starts: s.starts, place: s.place, past: s.starts < Date.now() - 6 * 3600e3,
    players: inv.map(x => ({ pid: x.pid, name: x.name, status: x.status || null, hasEmail: !!x.hasEmail }))
      .concat(extra.map(x => ({ pid: x.pid, name: x.name, status: x.status, hasEmail: false, newcomer: true }))) });
}

async function signup(req, env) {
  const b = await req.json().catch(() => null);
  if (!b) return err("Bad request.");
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE org = ? AND id = ?").bind(String(b.o || ""), String(b.s || "")).first();
  if (!s || !sameText(String(b.t || ""), s.token)) return err("This sign-up link isn't valid any more.", 404);
  if (s.starts < Date.now() - 6 * 3600e3) return err("This session has already happened.");
  const status = b.status === "in" ? "in" : b.status === "out" ? "out" : null;
  if (!status) return err("Choose I'm in or Can't make it.");
  let pid = clean(b.pid, 64), name, newcomer = 0;
  if (pid) {
    const inv = await env.DB.prepare("SELECT name FROM invitees WHERE org = ? AND session = ? AND pid = ?").bind(s.org, s.id, pid).first();
    const prev = inv ? null : await env.DB.prepare("SELECT name, newcomer FROM signups WHERE org = ? AND session = ? AND pid = ?").bind(s.org, s.id, pid).first();
    if (!inv && !prev) return err("That name isn't on this session's list.");
    name = inv ? inv.name : prev.name; newcomer = inv ? 0 : 1;
  } else {
    name = clean(b.name, 60);
    if (name.length < 2) return err("Type your name.");
    const clash = await env.DB.prepare("SELECT 1 FROM invitees WHERE org = ? AND session = ? AND lower(name) = lower(?)").bind(s.org, s.id, name).first();
    if (clash) return err("That name is already on the list. Pick it from the list instead.");
    pid = "n_" + rand(8); newcomer = 1;
  }
  const email = clean(b.email, 254).toLowerCase();
  if (email && !validEmail(email)) return err("That email address doesn't look right.");
  if (email && !b.consent) return err("Tick the box to agree to emails, or leave the email address empty.");
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO signups (org, session, pid, name, status, newcomer, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org, session, pid) DO UPDATE SET status = excluded.status, at = excluded.at`).bind(s.org, s.id, pid, name, status, newcomer, now).run();
  let person = await env.DB.prepare("SELECT * FROM people WHERE org = ? AND pid = ?").bind(s.org, pid).first();
  if (email) {
    const token = person && person.token ? person.token : rand(12);
    await env.DB.prepare(`INSERT INTO people (org, pid, name, email, consent_at, unsub, token) VALUES (?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(org, pid) DO UPDATE SET email = excluded.email, consent_at = excluded.consent_at, unsub = 0, name = excluded.name`)
      .bind(s.org, pid, name, email, now, token).run();
    person = { pid, name, email, token, unsub: 0 };
  }
  let emailed = false;
  if (status === "in" && person && person.email && !person.unsub && (await canSend(env, 1))) {
    emailed = await sendEmail(env, person.email, name, `You're in: ${s.name}, ${s.when_text}`,
      emailHtml([`Hi ${esc(firstName(name))},`, `Thanks — you're down for ${sessionLine(s)}.`,
        s.remind_hours ? `We'll send a reminder ${s.remind_hours} hours before.` : "", `If your plans change, let us know here:`].filter(Boolean),
        joinLink(env, s, pid), "Change my answer", unsubUrl(env, req, s.org, person)));
    if (emailed) await noteSent(env, 1);
  }
  return json({ ok: true, pid, status, emailed, hasEmail: !!(person && person.email && !person.unsub) });
}

async function unsubscribe(env, url) {
  const o = url.searchParams.get("o") || "", p = url.searchParams.get("p") || "", k = url.searchParams.get("k") || "";
  const row = await env.DB.prepare("SELECT token FROM people WHERE org = ? AND pid = ?").bind(o, p).first();
  if (!row || !sameText(k, row.token || "")) return page("Link not recognised", "<p>This link isn't valid, or your address has already been removed.</p>", 404);
  await env.DB.prepare("UPDATE people SET email = NULL, consent_at = NULL, unsub = 1 WHERE org = ? AND pid = ?").bind(o, p).run();
  return page("You won't get any more emails", "<p>Your email address has been deleted from Fair Dinkum. You can still sign up for sessions with the link your organiser shares.</p>");
}

// ---------------------------------------------------------------- reminders and clean-up (hourly)
async function hourly(env) {
  const now = Date.now();
  const due = (await env.DB.prepare(`SELECT * FROM sessions WHERE reminded = 0 AND remind_hours > 0 AND starts > ? AND starts - remind_hours * 3600000 <= ?`)
    .bind(now, now).all()).results;
  for (const s of due) {
    const rows = (await env.DB.prepare(`SELECT p.pid, p.name, p.email, p.token FROM signups g JOIN people p ON p.org = g.org AND p.pid = g.pid
        WHERE g.org = ? AND g.session = ? AND g.status = 'in' AND p.email IS NOT NULL AND p.unsub = 0`).bind(s.org, s.id).all()).results;
    const allowed = await canSend(env, rows.length);
    let sent = 0;
    for (const p of rows.slice(0, allowed)) {
      if (await sendEmail(env, p.email, p.name, `Reminder: ${s.name}, ${s.when_text}`,
        emailHtml([`Hi ${esc(firstName(p.name))},`, `Just a reminder: you're down for ${sessionLine(s)}.`, `Can't make it after all? Let us know:`],
          joinLink(env, s, p.pid), "Change my answer", unsubUrl(env, null, s.org, p)))) sent++;
    }
    await noteSent(env, sent);
    await env.DB.prepare("UPDATE sessions SET reminded = 1 WHERE org = ? AND id = ?").bind(s.org, s.id).run();
  }
  const old = now - KEEP_DAYS * 86400e3;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signups WHERE (org, session) IN (SELECT org, id FROM sessions WHERE starts < ?)").bind(old),
    env.DB.prepare("DELETE FROM invitees WHERE (org, session) IN (SELECT org, id FROM sessions WHERE starts < ?)").bind(old),
    env.DB.prepare("DELETE FROM sessions WHERE starts < ?").bind(old),
    env.DB.prepare("DELETE FROM emaillog WHERE day < ?").bind(new Date(now - 7 * 86400e3).toISOString().slice(0, 10))
  ]);
  return due.length;
}

// ---------------------------------------------------------------- routing
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url), path = url.pathname;
    env.SELF_URL = url.origin;
    try {
      if (path === "/" ) return page("Fair Dinkum", "<p>This is the Fair Dinkum sign-up service. Nothing to see here.</p>");
      if (path === "/u") return unsubscribe(env, url);
      if (path === "/api/session" && req.method === "GET") return publicSession(env, url);
      if (path === "/api/signup" && req.method === "POST") return signup(req, env);
      if (path === "/api/org/register" && req.method === "POST") return register(req, env);
      if (env.TEST_MODE === "1" && path === "/test/mail") return json((await env.DB.prepare("SELECT * FROM testmail ORDER BY at").all()).results);
      if (env.TEST_MODE === "1" && path === "/test/hourly") return json({ reminded: await hourly(env) });
      if (path.startsWith("/api/org/")) {
        const org = await orgFrom(req, env);
        if (!org) return err("Not connected. Reconnect Fair Dinkum's online features.", 401);
        if (path === "/api/org/check") return json({ ok: true, org, email: !!(env.BREVO_API_KEY && env.SENDER_EMAIL) || env.TEST_MODE === "1" });
        if (path === "/api/org/people" && req.method === "GET") return listPeople(env, org);
        const m = /^\/api\/org\/session\/([A-Za-z0-9_-]{4,64})(\/invite)?$/.exec(path);
        if (path === "/api/org/session" && req.method === "PUT") return putSession(req, env, org);
        if (m && !m[2] && req.method === "GET") return sessionStatus(env, org, m[1]);
        if (m && !m[2] && req.method === "DELETE") return deleteSession(env, org, m[1]);
        if (m && m[2] && req.method === "POST") return sendInvites(req, env, org, m[1]);
      }
      return err("Not found.", 404);
    } catch (e) {
      return err("Something went wrong on the server. Try again in a minute.", 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourly(env));
  },
  _hourly: hourly
};
