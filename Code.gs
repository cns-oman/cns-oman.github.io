/* SPMS notification sender · Google Apps Script (free with your Google account, no card).
   SPMS tells it which request changed; it reads that request from your Firebase database, works out who has the next
   step (the same rules as the app: their hub, else their country, else everyone in that role) and sends them a
   notification through Firebase Cloud Messaging, even when SPMS is closed on their phone, and an email (the driver gets
   the notification only, no email).
   It works as you, the owner of the Firebase project (appsscript.json asks Google only for the database,
   notifications, Firebase logins (to set a password the Team Leader chose), sending email and saving the nightly backup
   in your Google Drive).
   Deploy as a Web app: Execute as Me, Who has access: Anyone. */

/* ---------- who gets a notification, and what it says ---------- */
/* Who gets a notification when a request or a stock change moves on, and what it says.
   Pure functions (no Firebase), so they can be tested on their own. Every value sent is a string. */
const ROLE_NAME = { TL: 'Team Leader', STOCK: 'Stock', TECH: 'Engineer', WS: 'Workshop' };
/* the step was made by someone in this role (older records call the Engineer "Technician") */
const sameRole = (r, who) => r === ROLE_NAME[who] || (who === 'TECH' && r === 'Technician');
/* whose turn each step is (same as the app) */
const WHO = { TL: 'TL', STOCK: 'STOCK', TM: 'TM', DISPATCHED: 'TECH', RECEIVED: 'TECH', RETURN: 'TECH', RETURNING: 'STOCK', ATHUB: 'STOCK', WORKSHOP: 'WS', REPAIRING: 'WS', REPAIRED: 'STOCK',
  /* outside hubs: the engineer takes the part from his own hub; the Main Hub refills that hub and he confirms it arrived */
  USE_OK: 'TECH', REPL: 'STOCK', REPL_CONF: 'TECH',
  /* a part from the engineer's own van: the Team Leader approves, then the engineer records it */
  VAN_OK: 'TECH',
  /* Driver & courier: the driver hands the part to the courier and adds the receipt photo */
  DRV_COUR: 'DRIVER' };
const TITLE = { TL: 'New part request', STOCK: 'Approved · ready to send', TM: 'Technical Manager approval needed', DISPATCHED: 'Part on the way to you', RECEIVED: 'Record the replacement', RETURN: 'Return due', RETURNING: 'Return on the way', ATHUB: 'Return to route', WORKSHOP: 'Part sent for repair', REPAIRING: 'Repair to finish', REPAIRED: 'Repaired part coming back',
  USE_OK: 'Approved · take it from your hub', REPL: 'Hub refill to send', REPL_CONF: 'Refill on the way to your hub', VAN_OK: 'Approved · use it from your van',
  DRV_COUR: 'Part to hand to the courier' };
/* the driver is told by push only, no email (14 Nov 2026) */
const PUSH_ONLY = ['DRIVER'];
const REP_TITLE = { TL: 'Van restock to approve', STOCK: 'Van restock to send', DISPATCHED: 'Restock on the way to your van' };
const VAN_TITLE = { TL: 'Van part use to approve' };
/* parts Stock sends from the Muscat Main Hub to a regional hub: the receiving engineer confirms */
const XFER_TITLE = { REPL_CONF: 'Parts on the way to your hub' };
/* Stock chose "the engineer collects it": no driver brings the part */
const COLLECT_TITLE = { req: { DISPATCHED: 'Part ready to collect at Stock' }, rep: { DISPATCHED: 'Van restock ready to collect at Stock' }, hubrep: { REPL_CONF: 'Refill ready to collect at the Muscat Main Hub' }, xfer: { REPL_CONF: 'Parts ready to collect at the Muscat Main Hub' } };
const collectTitle = j => j.dispatch && j.dispatch.delivery === 'collect' ? (COLLECT_TITLE[j.xfer ? 'xfer' : j.type] || COLLECT_TITLE.req)[j.status] || '' : '';
/* parts an engineer sends back to the Main Hub in one go */
const RET_TITLE = { RETURNING: 'Parts coming back to the Main Hub' };
const qtyOf = j => j.dispatch && Array.isArray(j.dispatch.items) && j.dispatch.items.length ? j.dispatch.items.reduce((n, t) => n + (t.sn ? 1 : (+t.qty || 0)), 0) : (j.qtyApproved || j.qty || 1);
const lineOf = j => j.type === 'ret' ? `${qtyOf(j)} part${qtyOf(j) === 1 ? '' : 's'} · ${j.desc || 'Return to the Main Hub'} · ${j.techName || ''}`
  : `${j.pn} × ${qtyOf(j)}${j.desc ? ' · ' + j.desc : ''} · ${j.type === 'rep' ? (j.techName || '') + '’s van' : j.techName || ''}${j.type === 'hubrep' && j.to ? ' · for ' + j.to : ''}`;
const lastRole = j => { const h = Array.isArray(j.history) ? j.history[j.history.length - 1] : null; return h ? h.role || '' : ''; };
const str = o => { const r = {}; for (const [k, v] of Object.entries(o)) if (v != null && v !== '') r[k] = String(v); return r; };
const adjText = a => a.kind === 'qty' ? `Remove ${-a.delta} × ${a.pn}${a.sn ? ' SN ' + a.sn : ''}` : a.kind === 'sn' ? `Correct serial ${a.sn} → ${a.newSn}` : `Correct count ${a.qtyWas} → ${a.newQty} · ${a.pn}`;
/* Team Leaders, Stock and Workshop get only their own hub's requests (the engineer's hub); the server function
   looks the hub up from the engineer when an older request has none */
/* the Technical Manager approves the requests Stock sends him (same list as the app) */
const TECH_MANAGERS = ['mohamed.said@cns-me.com'];
const target = (role, j) => role === 'TECH' ? { role, techId: j.techId || '' } : role === 'TM' ? { role } : { role, hub: j.hub || '', techId: j.techId || '' };
const lastStep = j => (Array.isArray(j.history) && j.history[j.history.length - 1]) || {};
/* steps that belong to the one person who took them: nobody else was told, so nobody else needs a "handled" update */
const OWNED = ['REPAIRING', 'ATHUB'];

/* jobs/{id} changed: returns [{ role, techId?, data }]. A part sent for repair waits for the morning batch (08:00 on the
   next working day): the Workshop is told then, in one message (the sender's hourly run), not now. */
function planJob(before, after, id, nowArg) {
  if (!after || !after.status || !after.pn) return [];
  if (before && before.status === after.status) return [];          /* only a new step notifies */
  const out = [], line = lineOf(after), url = './?job=' + encodeURIComponent(id);
  if (before && WHO[before.status]) {
    const prev = WHO[before.status], h = lastStep(after);
    /* it was waiting for someone and is now cancelled or withdrawn: replace their notification (same tag) */
    if (after.status === 'CANCELLED' || (after.status === 'REJECTED' && !['TL', 'TM'].includes(before.status))) {
      const by = after.status === 'CANCELLED' ? 'Cancelled by ' + (after.techName || 'the engineer') : 'Withdrawn';
      out.push(Object.assign(target(prev, before), { data: str({ title: after.type === 'ret' ? 'Return cancelled' : 'Request cancelled', body: `${by}: ${line}`, tag: id, silent: '1', url: './', job: '' }) }));
    } else if (prev !== 'TECH' && !OWNED.includes(before.status)) {
      /* one Team Leader, Stock or Workshop person took it: the others' notification changes to "Already handled" */
      out.push(Object.assign(target(prev, before), { except: h.byId || '', data: str({ title: 'Already handled', body: `${h.action || 'Done'}${h.by ? ' · ' + h.by : ''} · ${line}`, tag: id, silent: '1', url, job: id }) }));
    }
  }
  const byTm = after.status === 'REJECTED' && before && before.status === 'TM', why = byTm ? (after.tm && after.tm.note) || '' : (after.tl && after.tl.note) || '';
  /* the Technical Manager rejected what Stock sent him: Stock hears it too */
  if (byTm) out.push(Object.assign(target('STOCK', after), { data: str({ title: 'Rejected by Technical Manager', body: line + (why ? ' · ' + why : ''), tag: id, renotify: '1', url, job: id }) }));
  if (after.status === 'REJECTED')
    out.push(Object.assign(target('TECH', after), { data: str({ title: after.type === 'rep' ? 'Van restock rejected' : after.type === 'van' ? 'Van part use rejected' : byTm ? 'Request rejected by Technical Manager' : 'Request rejected', body: line + (why ? ' · ' + why : ''), tag: id, renotify: '1', url, job: id }) }));
  const who = WHO[after.status]; if (!who) return out;
  if (after.status === 'WORKSHOP' && after.ret && +after.ret.wsAt > (+nowArg || Date.now())) return out;   /* in the next morning batch */
  /* the person who made this step has the same role as the next one (e.g. the engineer recording their own replacement): no notification */
  if (sameRole(lastRole(after), who)) return out;
  if (before && WHO[before.status] === who) return out;
  const title = collectTitle(after) || (after.xfer && XFER_TITLE[after.status]) || (after.type === 'rep' && REP_TITLE[after.status]) || (after.type === 'van' && VAN_TITLE[after.status]) || (after.type === 'ret' && RET_TITLE[after.status]) || (after.status === 'STOCK' && before && before.status === 'TM' && 'Technical Manager approved · ready to send') || TITLE[after.status] || 'SPMS';
  const urgent = after.urgency === 'urgent' && ['TL', 'STOCK', 'TM'].includes(after.status);
  const askWhy = after.status === 'TM' && after.tmAsk && after.tmAsk.note ? ' · ' + after.tmAsk.note : '';
  const cour = after.status === 'DRV_COUR' && after.dispatch && after.dispatch.company ? ' · courier: ' + after.dispatch.company : '';
  out.push(Object.assign(target(who, after), { data: str({ title: urgent ? title + ' · URGENT' : title, body: line + (after.scn ? ' · ' + after.scn : '') + askWhy + cour, tag: id, renotify: '1', urgent: urgent ? '1' : '', nomail: PUSH_ONLY.includes(who) ? '1' : '', url, job: id }) }));
  return out;
}
/* adj/{id} changed (stock changes the Team Leader approves) */
function planAdj(before, after, id) {
  if (!after) return [];
  if (after.status === 'pending' && (!before || before.status !== 'pending'))
    return [{ role: 'TL', hub: /^VAN-/.test(after.loc || '') ? '' : after.loc || '', techId: /^VAN-/.test(after.loc || '') ? after.loc.slice(4) : '', data: str({ title: 'Stock change to approve', body: `${adjText(after)} · ${after.reason || ''} · ${after.by || ''}`, tag: 'adj-' + id, renotify: '1', url: './' }) }];
  return [];
}
/* who in a role hears about a request at this hub (same rule as the app): that hub's people; if nobody in the role works
   there, the people in the same country; if nobody there either, everyone in the role. Anyone with no hub always hears.
   "except" is the person who just did the step. */
const DEFAULT_HUB_COUNTRY = { MMH: 'Oman', MH: 'Oman', SLH: 'Oman', SOH: 'Oman', SUR: 'Oman', IBR: 'Oman', NZW: 'Oman', SUW: 'Oman', SNW: 'Oman' };
function pickUsers(users, hub, except, hubCountry) {
  const country = h => (hubCountry && hubCountry[h]) || DEFAULT_HUB_COUNTRY[h] || '';
  const act = users.filter(u => u.active !== false);
  let pool = act;
  if (hub && act.some(u => u.hub === hub)) pool = act.filter(u => !u.hub || u.hub === hub);
  else if (hub && country(hub) && act.some(u => u.hub && country(u.hub) === country(hub))) pool = act.filter(u => !u.hub || country(u.hub) === country(hub));
  return pool.filter(u => !except || u.sid !== except).map(u => u.email);
}

/* ---------- the sender: runs in Google Apps Script (free with a Google account, no card) ---------- */
/* SPMS's web settings (the same apiKey as in firebase-config.js): used only to check that a message comes from someone signed in */
const SPMS_API_KEY = 'AIzaSyCtx68GiSKrPWR53WC30Kw9FdAKEERDQu4';
/* Your Firebase project ID, and the Firestore database SPMS uses */
const SPMS_PROJECT = 'spms-65b1a';
const SPMS_DATABASE = '(default)';
/* The SPMS link: emails have an "Open in SPMS" button */
const SPMS_APP_URL = 'https://cns-oman.github.io/';

/* ---------- OTP (one-time codes) for login (2-factor) and password reset ----------
   A fresh random 6-digit code every time; only its salted SHA-256 hash is stored (never the code itself), with a
   10-minute expiry and at most 5 tries. The codes live in the "otp" collection, which the security rules hide from
   everyone — only this sender (which runs as the project owner) can read or write them. On a correct login code the
   sender writes "authok/<uid>" with an expiry; the rules let that person load SPMS data only while it is fresh. */
const OTP_TTL = 10 * 60 * 1000, OTP_MAX_TRIES = 5;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/* Team Leaders and the Operations Manager built into SPMS (same lists as the app and the rules): a reset code may be
   e-mailed to them too */
const BUILTIN_STAFF = ['mohamed.said@cns-me.com', 'madhu.kuriakose@cns-me.com', 'mohamed.fawzy@cns-me.com', 'hany.khalifa@cns-me.com'];
/* Mohamed Said's account is locked: only he can change his own password */
const LOCKED_ACCOUNT = 'mohamed.said@cns-me.com';
/* the password rules (the app checks the same): 8+ characters with a capital letter, a small letter, a number and a
   special character, no spaces */
function pwWeak(pw) { pw = String(pw == null ? '' : pw); return pw.length < 8 || /\s/.test(pw) || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw) || !/[^A-Za-z0-9]/.test(pw); }
function randomCode() { const u = Utilities.getUuid().replace(/-/g, ''); return ('00000' + (parseInt(u.slice(0, 12), 16) % 1000000)).slice(-6); }
function sha256hex(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }

/* SPMS calls this after it saves a request or a stock change: { t: sign-in token, col: 'jobs' | 'adj', id } */
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return reply('bad request'); }
  const col = body.col, id = String(body.id || '');
  if (body.op === 'otp-login-send') return otpLoginSend(body.t);
  if (body.op === 'otp-login-check') return otpLoginCheck(body.t, body.code);
  if (body.op === 'otp-reset-send') return otpResetSend(body.email);
  if (body.op === 'otp-reset-check') return otpResetCheck(body.email, body.code, body.pw);
  if (body.op === 'admin-set-pw') return adminSetPw(body.t, body.email, body.pw, body.force === true);
  if (col === 'test' && body.t) return sendTest(body.t);
  if ((col !== 'jobs' && col !== 'adj') || !id || id.length > 200 || /[\/]/.test(id) || !body.t) return reply('bad request');
  const email = signedInEmail(body.t); if (!email) return reply('not signed in');
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const users = listDocs('users');
    const me = users.find(u => u.id === email); if (!me || me.active === false) return reply('not on the staff list');
    const after = getDoc(col, id), stateId = col + '_' + id, st = getDoc('pushstate', stateId);
    const before = st && st.s ? JSON.parse(st.s) : null;
    const messages = col === 'jobs' ? planJob(before, after, id) : planAdj(before, after, id);
    const sent = messages.length ? deliver(messages, users) : 0;
    if (after) setDoc('pushstate', stateId, { s: JSON.stringify(col === 'jobs' ? { status: after.status || '', hub: after.hub || '', techId: after.techId || '' } : { status: after.status || '' }), at: Date.now() });
    else delDoc('pushstate', stateId);
    return reply('ok · ' + sent + ' sent');
  } finally { lock.releaseLock(); }
}
/* "Send me a test" in SPMS: a notification to the person's own phones and an email to them */
function sendTest(idToken) {
  const email = signedInEmail(idToken); if (!email) return reply('not signed in');
  const me = getDoc('users', email); if (!me || me.active === false) return reply('not on the staff list');
  const data = { title: 'SPMS test', body: 'Notifications work on this phone.', tag: 'spms-test', url: './', job: '' };
  const tokens = listDocs('tokens').filter(t => String(t.email || '').toLowerCase() === email);
  const r = pushTo(tokens, data), mailed = mailTo([email], data);
  return reply('phones ' + tokens.length + ' · sent ' + r.sent + (r.errors.length ? ' · problem: ' + r.errors.join(' | ') : '') + ' · email ' + (mailed ? 'sent' : 'not sent (daily email limit reached)'));
}
/* ---------- login 2-factor ---------- */
/* SPMS asks for a code after the password is accepted: { op:'otp-login-send', t: sign-in token } */
function otpLoginSend(idToken) {
  const u = signedInUser(idToken); if (!u) return reply('not signed in');
  const me = getDoc('users', u.email); if (!me || me.active === false) return reply('not on the staff list');
  const code = randomCode(), salt = Utilities.getUuid();
  setDoc('otp', u.uid, { purpose: 'login', email: u.email, salt: salt, hash: sha256hex(salt + ':' + code), exp: Date.now() + OTP_TTL, tries: 0, at: Date.now() });
  const sent = mailCode(u.email, code, 'login');
  return reply(sent ? 'sent' : 'email failed (daily limit reached) — ask the Team Leader');
}
/* { op:'otp-login-check', t, code }: on the right code, SPMS marks this phone trusted (so it won't ask again) */
function otpLoginCheck(idToken, code) {
  const u = signedInUser(idToken); if (!u) return reply('not signed in');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const d = getDoc('otp', u.uid);
    if (!d || d.purpose !== 'login') return reply('no code');
    if (Date.now() > d.exp) { delDoc('otp', u.uid); return reply('expired'); }
    if ((d.tries || 0) >= OTP_MAX_TRIES) { delDoc('otp', u.uid); return reply('locked'); }
    if (sha256hex(d.salt + ':' + String(code || '')) !== d.hash) { setDoc('otp', u.uid, Object.assign({}, d, { tries: (d.tries || 0) + 1 })); return reply('bad'); }
    delDoc('otp', u.uid);
    return reply('ok');
  } finally { lock.releaseLock(); }
}
/* ---------- password reset by code (the sender sets the new password: as the project owner, or with the service-account key) ---------- */
/* { op:'otp-reset-send', email }: e-mails a code only to a real staff member or a built-in Team Leader; the reply is
   always "sent" so nobody can use it to find out which e-mails exist. */
function otpResetSend(email) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return reply('bad');
  /* no Firebase-login access (an older setup): the app falls back to the reset link. Asked for every email, so the
     answer never shows who has a login. */
  let uid = ''; try { uid = adminUid(email); } catch (e) { console.warn(e.message); return reply('no-admin'); }
  const me = getDoc('users', email), allowed = (me && me.active !== false) || BUILTIN_STAFF.indexOf(email) >= 0;
  if (allowed) {
    if (uid) {
      const ex = getDoc('otp', 'r_' + uid);
      if (!(ex && ex.purpose === 'reset' && Date.now() < (ex.at || 0) + 45000)) {   /* don't re-send within 45 s */
        const code = randomCode(), salt = Utilities.getUuid();
        setDoc('otp', 'r_' + uid, { purpose: 'reset', email: email, salt: salt, hash: sha256hex(salt + ':' + code), exp: Date.now() + OTP_TTL, tries: 0, at: Date.now() });
        mailCode(email, code, 'reset');
      }
    }
  }
  return reply('sent');
}
/* { op:'otp-reset-check', email, code, pw }: on a correct code, set the new password (with the app's "spms:" prefix) */
function otpResetCheck(email, code, pw) {
  email = String(email || '').trim().toLowerCase();
  if (pwWeak(pw)) return reply('weak');
  let uid = ''; try { uid = adminUid(email); } catch (e) { console.warn(e.message); return reply('no-admin'); }
  if (!uid) return reply('no user');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const d = getDoc('otp', 'r_' + uid);
    if (!d || d.purpose !== 'reset') return reply('no code');
    if (Date.now() > d.exp) { delDoc('otp', 'r_' + uid); return reply('expired'); }
    if ((d.tries || 0) >= OTP_MAX_TRIES) { delDoc('otp', 'r_' + uid); return reply('locked'); }
    if (sha256hex(d.salt + ':' + String(code || '')) !== d.hash) { setDoc('otp', 'r_' + uid, Object.assign({}, d, { tries: (d.tries || 0) + 1 })); return reply('bad'); }
    try { adminSetPassword(uid, 'spms:' + String(pw)); } catch (e) { console.warn(e.message); return reply('no-admin'); }
    delDoc('otp', 'r_' + uid);
    /* start the 90-day password clock, and clear any "must change" flag — only if the staff record already exists */
    if (getDoc('users', email)) { try { mergeDoc('users', email, { pwAt: Date.now(), mustChange: false }); } catch (e) { console.warn('pwAt: ' + e.message); } }
    return reply('ok');
  } finally { lock.releaseLock(); }
}
/* the code e-mails (login and reset); the code is never stored anywhere in plain text except this one message */
function mailCode(email, code, kind) {
  const left = mailLeft();
  if (left <= 0) { console.warn('OTP e-mail limit reached'); return false; }
  const reset = kind === 'reset';
  const title = reset ? 'Set a new SPMS password' : 'Your SPMS login code';
  const lead = reset ? 'Use this code in SPMS to choose a new password:' : 'Enter this code in SPMS to finish signing in:';
  const warn = reset ? 'The code expires in 10 minutes and works once. If you didn’t ask to reset your password, ignore this email.'
    : 'The code expires in 10 minutes and works once. If you didn’t just sign in to SPMS, ignore this email and tell your Team Leader — someone may have your password.';
  const spaced = String(code).split('').join('&nbsp;&nbsp;');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1b2430;max-width:520px">'
    + '<p style="font-size:18px;font-weight:bold;margin:0 0 8px">' + title + '</p>'
    + '<p style="margin:0 0 14px">' + lead + '</p>'
    + '<div style="font-family:Consolas,Menlo,monospace;font-size:30px;font-weight:bold;letter-spacing:6px;color:#B0282C;background:#faf3f3;border:1px solid #e6e8ec;border-radius:12px;padding:16px 10px;text-align:center;margin:0 0 16px">' + spaced + '</div>'
    + '<p style="font-size:13px;color:#6b7684;margin:0 0 16px">' + warn + '</p>'
    + '<p style="font-size:12px;color:#6b7684;margin:0">SPMS Oman · CNS Middle East.</p></div>';
  try { sendMail({ to: email, subject: reset ? 'SPMS password reset code' : 'SPMS login code', htmlBody: html, body: title + '\n' + lead + '\n\n' + code + '\n\n' + warn, name: 'SPMS Oman' }); return true; }
  catch (e) { console.warn('OTP e-mail to ' + email + ' failed: ' + e.message); return false; }
}
/* who sent the message, with the Firebase user id (needed for authok and admin password changes) */
function signedInUser(idToken) {
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(SPMS_API_KEY),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: String(idToken) }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  const u = (JSON.parse(r.getContentText()).users || [])[0];
  return u && u.email ? { email: String(u.email).toLowerCase(), uid: u.localId } : null;
}
/* { op:'admin-set-pw', t: sign-in token, email, pw, force }: a Team Leader gives someone a password. SPMS calls this when
   the person already had a login (the app itself can't change another person's password). Only for people on the staff
   list, never Mohamed Said's locked account (except by him). Without force (an Excel import) someone who has already
   chosen their own password keeps it ('own'). The staff record then says the password is the Team Leader's
   (mustChange: null) and the 90-day clock starts again. */
function adminSetPw(t, email, pw, force) {
  const who = signedInEmail(t); if (!who) return reply('not signed in');
  const me = getDoc('users', who); if (!me || me.active === false || me.role !== 'TL') return reply('not a team leader');
  email = String(email || '').trim().toLowerCase(); if (!EMAIL_RE.test(email)) return reply('bad');
  if (email === LOCKED_ACCOUNT && who !== LOCKED_ACCOUNT) return reply('locked');
  if (pwWeak(pw)) return reply('weak');
  const u = getDoc('users', email); if (!u) return reply('not on the staff list');
  if (!force && u.mustChange === false) return reply('own');
  let uid = ''; try { uid = adminUid(email); } catch (e) { console.warn(e.message); return reply('no-admin'); }
  if (!uid) return reply('no user');
  try { adminSetPassword(uid, 'spms:' + String(pw)); } catch (e) { console.warn(e.message); return reply('no-admin'); }
  try { mergeDoc('users', email, { pwAt: Date.now(), mustChange: null }); } catch (e) { console.warn('pwAt: ' + e.message); }
  return reply('ok');
}
/* ---------- Firebase Auth admin: find a login by e-mail, set its password ----------
   As you, the project owner (appsscript.json asks for Firebase logins, "identitytoolkit"), or as the service account
   when the SERVICE_ACCOUNT Script property is set. */
function adminHeaders() {
  if (hasServiceAccount()) return { Authorization: 'Bearer ' + adminToken() };
  return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': SPMS_PROJECT };
}
function adminCall(op, body) {
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/' + projectId() + '/accounts:' + op,
    { method: 'post', contentType: 'application/json', headers: adminHeaders(), payload: JSON.stringify(body), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Firebase logins (' + op + ') ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText() || '{}');
}
/* the person's Firebase user id; '' when there is no login for this email. Throws when the access is missing. */
function adminUid(email) { const u = (adminCall('lookup', { email: [email] }).users || [])[0]; return u ? u.localId : ''; }
function adminSetPassword(uid, password) { adminCall('update', { localId: uid, password: password, emailVerified: true }); }
/* a service-account access token with the Identity Toolkit (Auth admin) scope, cached for an hour */
function adminToken() { return accessToken('https://www.googleapis.com/auth/identitytoolkit', 'spms-admin-token'); }

/* Open the Web app URL in a browser to check the setup */
function doGet() {
  try { listDocs('users'); }
  catch (e) { return reply('SPMS notification sender is NOT ready: ' + e.message); }
  let pw = 'ready'; try { adminUid('setup.check@spms.invalid'); } catch (e) { pw = 'NOT ready (' + e.message + ')'; }
  return reply('SPMS notification sender is ready · project ' + projectId() + ' · passwords: ' + pw + ' · email: ' + mailStatus() + ' · backup: ' + backupStatus());
}
function reply(text) { return ContentService.createTextOutput(text); }

/* who sent the message: Firebase checks the sign-in token */
function signedInEmail(idToken) {
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(SPMS_API_KEY),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: String(idToken) }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return '';
  const u = (JSON.parse(r.getContentText()).users || [])[0];
  return u && u.email ? String(u.email).toLowerCase() : '';
}

/* send to everyone each message is for: a notification to their phones, and an email (not for the quiet "already
   handled" updates). Addresses of phones that no longer exist are removed. */
function deliver(messages, users) {
  const countries = hubCountries(), tokens = listDocs('tokens');
  let sent = 0;
  for (const m of messages) {
    let emails = [];
    if (m.role === 'TECH') emails = m.techId ? users.filter(u => u.sid === m.techId && u.active !== false).map(u => u.id) : [];
    else if (m.role === 'TM') emails = TECH_MANAGERS.filter(e => !m.except || !users.some(u => u.id === e && u.sid === m.except));   /* the Technical Manager */
    else {
      const hub = m.hub || (m.techId ? ((users.find(u => u.sid === m.techId) || {}).hub || '') : '');
      emails = pickUsers(users.filter(u => u.role === m.role).map(u => ({ email: u.id, sid: u.sid || '', hub: u.hub || '', active: u.active })), hub, m.except, countries);
    }
    emails = emails.map(e => String(e || '').toLowerCase()).filter(Boolean);
    sent += pushTo(tokens.filter(t => emails.indexOf(String(t.email || '').toLowerCase()) >= 0), m.data).sent;
    if (m.data && m.data.silent !== '1' && m.data.nomail !== '1') mailTo(emails, m.data);   /* nomail: push only (the driver) */
  }
  return sent;
}
function pushTo(list, data) {
  const out = { sent: 0, errors: [] }; if (!list.length) return out;
  const headers = authHeaders(), url = 'https://fcm.googleapis.com/v1/projects/' + projectId() + '/messages:send';
  const res = UrlFetchApp.fetchAll(list.map(t => ({ url, method: 'post', contentType: 'application/json', headers, muteHttpExceptions: true,
    payload: JSON.stringify({ message: { token: t.id, data, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } }) })));
  res.forEach((r, i) => {
    const c = r.getResponseCode();
    if (c === 200) { out.sent++; return; }
    const text = r.getContentText();
    if (c === 404 || (c === 400 && /UNREGISTERED|registration token|INVALID_ARGUMENT/i.test(text))) delDoc('tokens', list[i].id);
    console.warn('FCM ' + c + ': ' + text.slice(0, 300)); out.errors.push(c + ' ' + text.slice(0, 160));
  });
  return out;
}
/* step emails: from Microsoft 365 when set up, otherwise from the Google account that owns this script (sendMail) */
function mailTo(emails, data) {
  if (!emails.length) return false;
  const left = mailLeft();
  if (left < emails.length) { console.warn('Email limit reached for today: ' + left + ' left, ' + emails.length + ' needed'); if (left <= 0) return false; emails = emails.slice(0, left); }
  const link = SPMS_APP_URL + (data.job ? '?job=' + encodeURIComponent(data.job) : '');
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b2430;max-width:520px">'
    + '<p style="font-size:18px;font-weight:bold;margin:0 0 8px">' + esc(data.title) + '</p>'
    + '<p style="margin:0 0 18px">' + esc(data.body) + '</p>'
    + '<p style="margin:0 0 18px"><a href="' + esc(link) + '" style="background:#B0282C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open in SPMS</a></p>'
    + '<p style="font-size:12px;color:#6b7684;margin:0">SPMS Oman · CNS Middle East. You get this because it is your step in SPMS.</p></div>';
  let ok = false;
  for (const to of emails) {
    try { sendMail({ to, subject: 'SPMS · ' + data.title, htmlBody: html, body: data.title + '\n' + data.body + '\n' + link, name: 'SPMS Oman' }); ok = true; }
    catch (e) { console.warn('Email to ' + to + ' failed: ' + e.message); }
  }
  return ok;
}
/* ---------- sending email ----------
   With the Microsoft 365 settings saved in this script's Script Properties (Project Settings → Script Properties):
     MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_SENDER (for example spms@cns-me.com)
   emails go out from that mailbox through Microsoft Graph (about 10,000 recipients a day). Without them, or whenever
   Microsoft refuses a message, the email goes out from this Google account instead (about 100 recipients a day). */
function msConfig() {
  const p = PropertiesService.getScriptProperties(), g = k => String(p.getProperty(k) || '').trim();
  const c = { tenant: g('MS_TENANT_ID'), id: g('MS_CLIENT_ID'), secret: g('MS_CLIENT_SECRET'), from: g('MS_SENDER').toLowerCase() };
  return c.tenant && c.id && c.secret && EMAIL_RE.test(c.from) ? c : null;
}
/* a Microsoft access token for sending, kept for up to 50 minutes */
function msToken(c, fresh) {
  const cache = CacheService.getScriptCache(), key = 'ms_token_' + c.id;
  if (!fresh) { const hit = cache.get(key); if (hit) return hit; }
  const r = UrlFetchApp.fetch('https://login.microsoftonline.com/' + encodeURIComponent(c.tenant) + '/oauth2/v2.0/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: c.id, client_secret: c.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' } });
  let j = {}; try { j = JSON.parse(r.getContentText() || '{}'); } catch (e) { j = {}; }
  if (r.getResponseCode() !== 200 || !j.access_token) throw new Error('Microsoft sign-in failed (' + (j.error || ('HTTP ' + r.getResponseCode())) + ')');
  cache.put(key, j.access_token, Math.max(60, Math.min(3000, (+j.expires_in || 3600) - 600)));
  return j.access_token;
}
function msSend(c, m) {
  const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).map(a => ({ emailAddress: { address: a } }));
  const payload = JSON.stringify({ message: { subject: m.subject, body: { contentType: 'HTML', content: m.htmlBody }, toRecipients: list(m.to), ccRecipients: list(m.cc) }, saveToSentItems: false });
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(c.from) + '/sendMail';
  for (let i = 0; i < 2; i++) {
    const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + msToken(c, i > 0) }, payload, muteHttpExceptions: true });
    const code = r.getResponseCode();
    if (code === 202) return;
    if (code === 401 && i === 0) continue;   /* the saved token expired early: get a new one and try once more */
    throw new Error('Microsoft send failed (HTTP ' + code + ')');
  }
}
/* how many more people can be emailed today */
function mailLeft() {
  if (msConfig()) return 10000;
  try { return MailApp.getRemainingDailyQuota(); } catch (e) { return 0; }
}
/* send one email { to, cc?, subject, htmlBody, body, name }: from Microsoft 365 when set up, otherwise from Gmail */
function sendMail(m) {
  const c = msConfig();
  if (c) { try { msSend(c, m); return 'microsoft'; } catch (e) { console.warn(e.message + ' · sent from Gmail instead'); } }
  MailApp.sendEmail(m); return 'gmail';
}
/* for the setup check: which mailbox sends, and whether Microsoft accepts the settings */
function mailStatus() {
  const c = msConfig(); if (!c) return 'Gmail';
  try { msToken(c, true); return 'Microsoft 365 (' + c.from + ')'; } catch (e) { return 'Microsoft 365 NOT ready: ' + e.message + ' · Gmail is used meanwhile'; }
}

/* ---------- overdue returns ----------
   Runs every hour from a time trigger (Apps Script → Triggers → Add trigger → overdueReturns · Time-driven · Hour timer ·
   Every hour). A part the engineer must send back (installed, arrived faulty or unused) is overdue a set number of days
   after the install: the Muscat Main Hub and the other hubs each have their number (2 and 5 unless the Team Leader
   changed them in SPMS → Database → Return deadline). The first time a return is overdue, the engineer gets one email
   that lists his overdue parts, with his hub's Team Leaders and the Technical Manager in copy. Each part is emailed once
   (pushstate/od_<request id>); the dashboard keeps showing it until it is back. */
const TECH_MANAGER = LOCKED_ACCOUNT;
const DAY_MS = 86400000;
function returnDaysFor(cfg, hub) {
  const n = v => { const x = parseInt(v, 10); return x >= 1 && x <= 60 ? x : 0; };
  return hub === 'MMH' ? (n(cfg && cfg.mmh) || 2) : (n(cfg && cfg.other) || 5);
}
/* Oman time (UTC+4), e.g. "5 Nov 2026, 14:30" */
function gulfTime(t) {
  const d = new Date(+t + 4 * 3600000), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getUTCDate() + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
}
const dayWord = n => n + ' day' + (n === 1 ? '' : 's');
function lateBy(ms) { const h = Math.max(1, Math.floor(ms / 3600000)), d = Math.floor(h / 24), r = h % 24; return d ? d + ' day' + (d === 1 ? '' : 's') + (r ? ' ' + r + ' h' : '') : h + ' h'; }
function overdueReturns(nowArg) {
  const now = +nowArg || Date.now();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    let weekly = ''; try { weekly = weeklyMaybe(now); } catch (e) { console.warn('Weekly summary: ' + e.message); }   /* Sunday mornings only */
    let batch = ''; try { batch = wsBatchMaybe(now); } catch (e) { console.warn('Workshop batch: ' + e.message); }   /* working-day mornings */
    let backup = ''; try { backup = backupMaybe(now); } catch (e) { console.warn('Backup: ' + e.message); }   /* once a night, 02:00–05:59 */
    const done = r => [r, weekly, batch, backup].filter(Boolean).join(' · ');
    const waiting = queryDocs('jobs', 'status', 'RETURN').filter(j => j.ret);
    if (!waiting.length) return done('ok · 0 overdue');
    const cfg = getDoc('settings', 'returns') || {}, users = listDocs('users'), countries = hubCountries();
    const late = [];
    for (const j of waiting) {
      const tech = users.find(u => u.sid === j.techId) || {}, hub = j.hub || tech.hub || '';
      const at = j.use && +j.use.at ? +j.use.at : 0, due = at ? at + returnDaysFor(cfg, hub) * DAY_MS : (+j.ret.due || 0);
      if (!due || due >= now) continue;
      if (getDoc('pushstate', 'od_' + j.id)) continue;   /* already emailed */
      late.push({ j, tech, hub, due });
    }
    const groups = {};
    for (const x of late) (groups[x.j.techId || x.j.techName || '?'] = groups[x.j.techId || x.j.techName || '?'] || []).push(x);
    let emails = 0, parts = 0;
    for (const k of Object.keys(groups)) {
      const g = groups[k], first = g[0], tech = first.tech;
      const techEmail = tech.id && tech.active !== false && !/@spms\.invalid$/i.test(tech.id) ? String(tech.id).toLowerCase() : '';
      const tls = pickUsers(users.filter(u => u.role === 'TL').map(u => ({ email: u.id, sid: u.sid || '', hub: u.hub || '', active: u.active })), first.hub, '', countries);
      const cc = [];
      for (const e of tls.concat([TECH_MANAGER])) { const v = String(e || '').toLowerCase(); if (v && v !== techEmail && cc.indexOf(v) < 0) cc.push(v); }
      const to = techEmail || cc.shift() || '';
      if (!to) continue;
      const left = mailLeft();
      if (left < 1 + cc.length) { console.warn('Email limit reached: overdue emails wait for the next run'); break; }
      const name = first.j.techName || tech.name || 'Engineer';
      const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const rows = g.sort((a, b) => a.due - b.due).map(x => {
        const r = x.j.ret, link = SPMS_APP_URL + '?job=' + encodeURIComponent(x.j.id);
        return { link, id: x.j.id, part: (r.pn || x.j.pn || '') + (r.name || x.j.desc ? ' · ' + (r.name || x.j.desc) : ''), sn: r.sn ? 'SN ' + r.sn : '× ' + (r.qty || 1),
          kind: r.arrived ? 'Arrived faulty' : r.type === 'unused' ? 'Not used' : 'Removed (installed)', call: [x.j.machine, x.j.scn].filter(Boolean).join(' · '), due: gulfTime(x.due), late: lateBy(now - x.due) };
      });
      const td = 'style="padding:6px 8px;border-bottom:1px solid #e3e6ea;vertical-align:top"';
      const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2430;max-width:640px">'
        + '<p style="font-size:18px;font-weight:bold;margin:0 0 8px;color:#B0282C">Return overdue</p>'
        + '<p style="margin:0 0 14px">' + esc(name) + ', ' + (rows.length === 1 ? 'this part was' : 'these ' + rows.length + ' parts were') + ' due back at Stock and ' + (rows.length === 1 ? 'is' : 'are') + ' now overdue. Please send ' + (rows.length === 1 ? 'it' : 'them') + ' back today and record the return in SPMS.</p>'
        + '<table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="background:#f4f5f7;text-align:left">'
        + ['Request', 'Part', 'Return', 'Machine · call', 'Due', 'Late by'].map(h => '<th ' + td + '>' + h + '</th>').join('') + '</tr>'
        + rows.map(r => '<tr><td ' + td + '><a href="' + esc(r.link) + '">' + esc(r.id) + '</a></td><td ' + td + '>' + esc(r.part) + '<br><span style="color:#6b7684">' + esc(r.sn) + '</span></td><td ' + td + '>' + esc(r.kind) + '</td><td ' + td + '>' + esc(r.call || '–') + '</td><td ' + td + '>' + esc(r.due) + '</td><td style="padding:6px 8px;border-bottom:1px solid #e3e6ea;vertical-align:top;color:#B0282C;font-weight:bold">' + esc(r.late) + '</td></tr>').join('')
        + '</table><p style="margin:18px 0"><a href="' + esc(SPMS_APP_URL) + '" style="background:#B0282C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open in SPMS</a></p>'
        + '<p style="font-size:12px;color:#6b7684;margin:0">SPMS Oman · CNS Middle East. Return deadline: ' + dayWord(returnDaysFor(cfg, 'MMH')) + ' at the Muscat Main Hub, ' + dayWord(returnDaysFor(cfg, 'other')) + ' at the other hubs, from the install. Copy to the Team Leader and the Technical Manager.</p></div>';
      const text = 'Return overdue: ' + name + '\n' + rows.map(r => r.id + ' · ' + r.part + ' · ' + r.sn + ' · ' + r.kind + ' · due ' + r.due + ' · late by ' + r.late + ' · ' + r.link).join('\n');
      try {
        sendMail({ to, cc: cc.join(','), subject: 'SPMS · Return overdue · ' + name + ' · ' + rows.length + ' part' + (rows.length === 1 ? '' : 's'), htmlBody: html, body: text, name: 'SPMS Oman' });
      } catch (e) { console.warn('Overdue email to ' + to + ' failed: ' + e.message); continue; }
      emails++; parts += g.length;
      for (const x of g) setDoc('pushstate', 'od_' + x.j.id, { at: now, to, cc: cc.join(',') });
    }
    return done('ok · ' + parts + ' overdue part' + (parts === 1 ? '' : 's') + ' emailed in ' + emails + ' email' + (emails === 1 ? '' : 's'));
  } finally { lock.releaseLock(); }
}
/* ---------- the morning repair batch ----------
   Parts Stock sends for repair wait until 08:00 (Oman time) on the next working day (Sunday to Thursday), then reach the
   Workshop together. The first hourly run between 08:00 and 12:00 on a working day tells the Workshop once: one notification and one
   email with the list of parts waiting for repair (pushstate/wsbatch_<date>). */
const WS_OUT_HUBS = ['MH', 'SOH', 'SUR', 'IBR', 'NZW', 'SLH', 'SUW', 'SNW'];   /* outside hubs: their requests are repaired at the Muscat Main Hub */
const wsHubOf = j => j.type === 'req' && WS_OUT_HUBS.indexOf(j.hub) >= 0 ? 'MMH' : (j.hub || '');
function wsBatchMaybe(now) {
  const o = omanDay(now); if (o.day === 5 || o.day === 6 || o.hour < 8 || o.hour >= 12) return '';   /* 08:00–11:59 on working days */
  const key = 'wsbatch_' + o.ymd; if (getDoc('pushstate', key)) return '';
  const ready = queryDocs('jobs', 'status', 'WORKSHOP').filter(j => j.ret && +j.ret.wsAt && +j.ret.wsAt <= now);
  const byHub = {};
  for (const j of ready) (byHub[wsHubOf(j)] = byHub[wsHubOf(j)] || []).push(j);
  const users = ready.length ? listDocs('users') : [];
  let sent = 0;
  for (const h of Object.keys(byHub)) {
    const g = byHub[h], n = g.length;
    const list = g.map(j => (j.ret.pn || j.pn) + (j.ret.sn ? ' SN ' + j.ret.sn : ' × ' + (j.ret.qty || 1))).join(', ');
    sent += deliver([{ role: 'WS', hub: h, data: { title: 'Parts for repair today', body: n + ' part' + (n === 1 ? '' : 's') + ' ready for the Workshop: ' + list, tag: 'wsbatch-' + o.ymd, renotify: '1', url: './', job: '' } }], users);
  }
  setDoc('pushstate', key, { at: now, parts: ready.length });
  return ready.length ? 'workshop batch ' + ready.length + ' part' + (ready.length === 1 ? '' : 's') + ' · ' + sent + ' sent' : '';
}
/* the documents of a collection where one field equals a value (reads only those documents) */
function queryDocs(col, field, value) {
  const res = fsCall('post', ':runQuery', { structuredQuery: { from: [{ collectionId: col }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) } }, limit: 1000 } }) || [];
  return res.filter(x => x && x.document).map(x => Object.assign(fromFields(x.document.fields || {}), { id: docId(x.document) }));
}
/* hub → country from the hub list in SPMS (settings/hubs) */
function hubCountries() { const d = getDoc('settings', 'hubs'), m = {}; for (const h of (d && d.list) || []) if (h && h.code) m[h.code] = h.country || ''; return m; }
/* the documents of a collection where a number field is at least a value (for example everything updated this week) */
function queryFrom(col, field, from) {
  const res = fsCall('post', ':runQuery', { structuredQuery: { from: [{ collectionId: col }], where: { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: toValue(from) } }, limit: 3000 } }) || [];
  return res.filter(x => x && x.document).map(x => Object.assign(fromFields(x.document.fields || {}), { id: docId(x.document) }));
}

/* ---------- weekly summary for the Operations Manager ----------
   Every Sunday morning (Oman time) the hourly run also sends one email to the Operations Manager(s), with the Technical
   Manager in copy: the last 7 days by hub (new requests, parts installed, open requests, overdue returns, returns on
   time, request → installed time, cost) and the requests waiting longest. Sent once a week (pushstate/weekly_<date>).
   weeklySummaryPreview() (run it from the editor) sends the same email to the Technical Manager only. */
const OPS_MANAGERS = ['hany.khalifa@cns-me.com'];
const WEEK_HUBS = [['MMH', 'Muscat Main Hub'], ['MH', 'Al Musanaah Hub'], ['SLH', 'Salalah Hub'], ['SOH', 'Sohar Hub'], ['SUR', 'Sur Hub'], ['IBR', 'Ibri Hub'], ['NZW', 'Nizwa Hub'], ['SUW', 'Suwaiq Hub'], ['SNW', 'Sinaw Hub']];
const WK_STEP = { TL: 'Waiting for Team Leader', STOCK: 'Approved · waiting for Stock', DISPATCHED: 'On the way to engineer', DRV_PICK: 'Ready · waiting for the driver', DRV_GO: 'Driver is bringing the part',
  USE_OK: 'Approved · take it from the hub', VAN_OK: 'Approved · use it from the van', REPL: 'Hub refill · Muscat Main Hub to send', REPL_GO: 'Replenishment on the way to the hub', REPL_CONF: 'Refill on the way to the hub', DRV_COUR: 'With the driver · to hand to the courier', RECEIVED: 'With engineer',
  RETURNING: 'Return on the way to Stock', ATHUB: 'Returned · at Stock', WORKSHOP: 'Sent to Workshop', REPAIRING: 'Under repair', REPAIRED: 'Repaired · back to Stock' };
const omanDay = t => { const d = new Date(+t + 4 * 3600000); return { day: d.getUTCDay(), hour: d.getUTCHours(), ymd: d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2) }; };
const weeklyDue = now => { const o = omanDay(now); return o.day === 0 && o.hour >= 8 && o.hour < 12; };   /* Sunday 08:00–11:59 Oman time */
function weeklyMaybe(now) {
  if (!weeklyDue(now)) return '';
  const key = 'weekly_' + omanDay(now).ymd;
  if (getDoc('pushstate', key)) return '';
  const r = weeklySummary(now);
  if (r.sent) setDoc('pushstate', key, { at: now, to: r.to, cc: r.cc });
  return r.text;
}
function weeklySummaryPreview() { return weeklySummary(Date.now(), TECH_MANAGER).text; }
/* the numbers: the same rules as the dashboard in SPMS */
const wkUse = j => ['rep', 'hubrep', 'ret'].indexOf(j.type) < 0;
function wkUnits(j) {
  if (!j.use) return 0;
  if (Array.isArray(j.use.units)) return j.use.units.reduce((n, u) => n + (u.bulk ? (+u.used || 0) : u.used ? 1 : 0), 0);
  return j.use.replaced ? (+(j.qtyApproved || j.qty) || 0) : 0;
}
function wkValue(j) {
  if (!j.use || !wkUse(j) || j.split) return 0;
  const up = +j.unit || 0, items = (j.dispatch && j.dispatch.items) || [], priceOf = it => it && +it.price > 0 ? +it.price : up;
  if (Array.isArray(j.use.units) && j.use.units.length) {
    let v = 0;
    j.use.units.forEach((u, i) => { const it = u.sn ? items.find(t => String(t.sn || '').toUpperCase() === String(u.sn).toUpperCase()) || items[i] : items[i] || items[0]; if (u.bulk) v += (+u.used || 0) * priceOf(it); else if (u.used) v += priceOf(it); });
    return v;
  }
  return j.use.replaced ? up * (+(j.qtyApproved || j.qty) || 0) : 0;
}
function wkDur(ms) { if (ms == null) return '–'; if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + ' min'; const h = Math.round(ms / 3600000), d = Math.floor(h / 24), r = h % 24; return d ? d + ' day' + (d === 1 ? '' : 's') + (r ? ' ' + r + ' h' : '') : h + ' h'; }
function weeklySummary(nowArg, onlyTo) {
  const now = +nowArg || Date.now(), from = now - 7 * DAY_MS;
  const byId = {}; for (const j of queryDocs('jobs', 'open', true).concat(queryFrom('jobs', 'updatedAt', from))) if (j.status && j.pn) byId[j.id] = j;
  const jobs = Object.keys(byId).map(k => byId[k]);
  const users = listDocs('users'), cfg = getDoc('settings', 'returns') || {}, hd = getDoc('settings', 'hubs');
  const hubs = hd && Array.isArray(hd.list) && hd.list.some(h => h && h.code) ? hd.list.filter(h => h && h.code).map(h => [h.code, h.name || h.code]) : WEEK_HUBS;
  const sidHub = {}; for (const u of users) if (u.sid) sidHub[u.sid] = u.hub || '';
  const inList = h => hubs.some(x => x[0] === h), hubOf = j => inList(j.hub) ? j.hub : inList(sidHub[j.techId]) ? sidHub[j.techId] : hubs[0][0];   /* as in the app */
  const inW = t => +t >= from && +t < now;
  const due = j => j.use && +j.use.at ? +j.use.at + returnDaysFor(cfg, hubOf(j)) * DAY_MS : +(j.ret && j.ret.due) || 0;
  const stats = js => {
    const inst = js.filter(j => wkUse(j) && j.use && inW(j.use.at)), tat = js.filter(j => j.type === 'req' && !j.parent && +j.createdAt && j.use && inW(j.use.at));
    let dueN = 0, ok = 0;
    for (const j of js) { if (!j.ret || !wkUse(j) || !(j.use && +j.use.at)) continue; const d = due(j); if (!inW(d)) continue; const sent = +j.ret.shippedAt || 0; if (!sent && j.status !== 'RETURN') continue; dueN++; if (sent && sent <= d) ok++; }
    return { reqs: js.filter(j => j.type === 'req' && !j.parent && inW(j.createdAt)).length, units: inst.reduce((n, j) => n + wkUnits(j), 0), open: js.filter(j => j.open === true || (j.open == null && ['CLOSED', 'REJECTED', 'CANCELLED'].indexOf(j.status) < 0)).length,
      late: js.filter(j => j.status === 'RETURN' && j.ret && due(j) < now).length, dueN, ok, speed: tat.length ? tat.reduce((n, j) => n + (j.use.at - j.createdAt), 0) / tat.length : null,
      cost: inst.reduce((n, j) => n + wkValue(j), 0) + js.filter(j => j.ws && inW(j.ws.doneAt)).reduce((n, j) => n + (+j.ws.total || 0), 0) };
  };
  const all = stats(jobs), rows = hubs.map(h => [h[1], stats(jobs.filter(j => hubOf(j) === h[0]))]);
  const waitAt = j => { const h = Array.isArray(j.history) && j.history.length ? +j.history[j.history.length - 1].at : 0; return h || +j.updatedAt || +j.createdAt || 0; };
  const stuck = jobs.filter(j => (j.open === true) && j.status !== 'RETURN' && j.type !== 'van').map(j => ({ j, age: now - waitAt(j) })).sort((a, b) => b.age - a.age).slice(0, 5);
  const lateEng = {}; for (const j of jobs) if (j.status === 'RETURN' && j.ret && due(j) < now) { const k = j.techName || j.techId || '?'; lateEng[k] = lateEng[k] || { name: k, hub: hubOf(j), n: 0, worst: 0 }; lateEng[k].n++; lateEng[k].worst = Math.max(lateEng[k].worst, now - due(j)); }
  const lates = Object.keys(lateEng).map(k => lateEng[k]).sort((a, b) => (b.n - a.n) || (b.worst - a.worst)).slice(0, 5);
  /* who gets it */
  const mgrs = users.filter(u => u.role === 'MGR' && u.active !== false).map(u => String(u.id || u.email || '').toLowerCase()).concat(OPS_MANAGERS).filter(e => EMAIL_RE.test(e) && !/@spms\.invalid$/i.test(e));
  const to = onlyTo ? [String(onlyTo).toLowerCase()] : mgrs.filter((e, i) => mgrs.indexOf(e) === i), cc = onlyTo ? [] : [TECH_MANAGER].filter(e => to.indexOf(e) < 0);
  if (!to.length) return { sent: false, text: 'weekly summary: nobody to send to' };
  if (mailLeft() < to.length + cc.length) return { sent: false, text: 'weekly summary waits: email limit reached' };
  /* the email */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const omr = v => Math.round(+v || 0).toLocaleString('en-GB'), pct = x => x.dueN ? Math.round(x.ok / x.dueN * 100) + '%' : '–';
  const day = t => { const d = new Date(+t + 4 * 3600000), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return d.getUTCDate() + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const span = day(from) + ' – ' + day(now - 1);
  const td = 'style="padding:6px 8px;border-bottom:1px solid #e3e6ea;text-align:right;white-space:nowrap"', tdl = 'style="padding:6px 8px;border-bottom:1px solid #e3e6ea;text-align:left;white-space:nowrap"';
  const th = al => 'style="padding:6px 8px;border-bottom:1px solid #e3e6ea;text-align:' + al + ';font-size:12px;color:#4a5361;vertical-align:bottom"';
  const red = (v, bad) => bad ? '<b style="color:#B0282C">' + v + '</b>' : v;
  const row = (name, x, bold) => '<tr' + (bold ? ' style="background:#f4f5f7;font-weight:bold"' : '') + '><td ' + tdl + '>' + esc(name) + '</td><td ' + td + '>' + x.reqs + '</td><td ' + td + '>' + x.units + '</td><td ' + td + '>' + x.open + '</td><td ' + td + '>' + red(x.late || '–', x.late) + '</td><td ' + td + '>' + red(pct(x), x.dueN && x.ok / x.dueN < .7) + '</td><td ' + td + '>' + wkDur(x.speed) + '</td><td ' + td + '>' + omr(x.cost) + '</td></tr>';
  const tile = (v, k) => '<td style="padding:10px 12px;background:#f4f5f7;border-radius:8px;width:25%"><div style="font-size:22px;font-weight:bold">' + v + '</div><div style="font-size:12px;color:#6b7684">' + k + '</div></td>';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2430;max-width:700px">'
    + '<p style="font-size:18px;font-weight:bold;margin:0 0 4px;color:#B0282C">SPMS Oman · weekly summary</p><p style="margin:0 0 14px;color:#6b7684">' + esc(span) + '</p>'
    + '<table style="border-collapse:separate;border-spacing:6px;width:100%;margin:0 -6px 10px"><tr>' + tile(all.reqs, 'new requests') + tile(all.units, 'parts installed') + tile(all.open, 'open requests now') + tile(red(all.late, all.late), 'overdue returns now') + '</tr></table>'
    + '<p style="font-weight:bold;margin:16px 0 6px">By hub</p><table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="background:#f4f5f7">'
    + ['Hub', 'New requests', 'Parts installed', 'Open now', 'Overdue returns', 'Returned on time', 'Request → installed', 'Cost (OMR)'].map((h, i) => '<th ' + th(i ? 'right' : 'left') + '>' + h + '</th>').join('') + '</tr>'
    + rows.map(r => row(r[0], r[1])).join('') + row('All hubs', all, true) + '</table>'
    + (stuck.length ? '<p style="font-weight:bold;margin:18px 0 6px">Waiting longest at a step</p><table style="border-collapse:collapse;width:100%;font-size:13px">'
      + stuck.map(x => '<tr><td ' + tdl + '><a href="' + esc(SPMS_APP_URL + '?job=' + encodeURIComponent(x.j.id)) + '">' + esc(x.j.id) + '</a></td><td ' + tdl + '>' + esc(WK_STEP[x.j.status] || x.j.status) + '</td><td ' + tdl + '>' + esc((x.j.pn || '') + ' · ' + (x.j.techName || '')) + '</td><td ' + td + '>' + red(wkDur(x.age), x.age > 2 * DAY_MS) + '</td></tr>').join('') + '</table>' : '')
    + (lates.length ? '<p style="font-weight:bold;margin:18px 0 6px">Engineers with overdue returns</p><table style="border-collapse:collapse;width:100%;font-size:13px">'
      + lates.map(e => '<tr><td ' + tdl + '>' + esc(e.name) + '</td><td ' + tdl + '>' + esc((hubs.find(h => h[0] === e.hub) || [e.hub, e.hub])[1]) + '</td><td ' + td + '>' + e.n + ' overdue</td><td ' + td + '>' + red(wkDur(e.worst) + ' late', true) + '</td></tr>').join('') + '</table>' : '')
    + '<p style="margin:20px 0"><a href="' + esc(SPMS_APP_URL) + '" style="background:#B0282C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open the dashboard</a></p>'
    + '<p style="font-size:12px;color:#6b7684;margin:0">SPMS Oman · CNS Middle East. Sent every Sunday morning. Open requests and overdue returns are as of now; the other numbers cover the last 7 days. Cost is parts installed plus Workshop repairs.</p></div>';
  const text = 'SPMS Oman weekly summary, ' + span + '\n' + rows.concat([['All hubs', all]]).map(r => r[0] + ': ' + r[1].reqs + ' new requests, ' + r[1].units + ' parts installed, ' + r[1].open + ' open, ' + r[1].late + ' overdue returns, ' + pct(r[1]) + ' returned on time, request to installed ' + wkDur(r[1].speed) + ', cost OMR ' + omr(r[1].cost)).join('\n') + '\n' + SPMS_APP_URL;
  sendMail({ to: to.join(','), cc: cc.join(','), subject: 'SPMS Oman · Weekly summary · ' + span, htmlBody: html, body: text, name: 'SPMS Oman' });
  return { sent: true, to: to.join(','), cc: cc.join(','), text: 'weekly summary sent to ' + to.join(', ') };
}

/* ---------- nightly backup ----------
   The first hourly run between 02:00 and 05:59 Oman time saves a full copy of the SPMS database in the owner's Google
   Drive: folder "SPMS Oman backups", file SPMS-Oman-backup-<date>-<time>.json.gz (JSON, gzip). When the database is
   bigger than one file may be (photos are saved inside the requests), the copy is split into several files,
   SPMS-Oman-backup-<date>-<time>-part1of3.json.gz and so on (14 Nov 2026): each holds about 35 MB at most, so no file
   reaches the 50 MB Google allows, however big the database grows. Put back, all parts of one night together are the full
   copy. The newest 30 nights are kept; older ones go to the Drive bin. Login codes, phone push addresses, locks and the
   sender's own notes are left out. A failed try is tried again the next hour, at most 3 times a day; the parts already
   saved by a failed try go to the bin. backupNow() (run it from the editor) saves a copy at once; the first run also
   asks the owner to allow Google Drive. Every saved document counts as one database read (free plan: 50,000 a day). */
const BACKUP_COLS = ['users', 'settings', 'machines', 'jobs', 'stockpacks', 'partpacks', 'importpacks', 'ledger', 'adj', 'budgets', 'lines', 'parts', 'stockrows', 'stock'];
const BACKUP_FOLDER = 'SPMS Oman backups', BACKUP_KEEP = 30, BACKUP_TRIES = 3, BACKUP_MAX = 45 * 1024 * 1024;
var BACKUP_PART = 35 * 1024 * 1024;   /* characters of JSON in one file at most (var: the tests make it smaller) */
const BACKUP_PAGE = 40;   /* documents read per call: 40 × 1 MB (the largest a document can be) stays under Google's 50 MB per answer */
const backupDue = now => { const o = omanDay(now); return o.hour >= 2 && o.hour < 6; };   /* 02:00–05:59 Oman time */
const scriptProps = () => PropertiesService.getScriptProperties();
function backupMaybe(now) {
  if (!backupDue(now)) return '';
  const p = scriptProps(), ymd = omanDay(now).ymd;
  if (p.getProperty('BACKUP_DAY') === ymd) return '';
  const tries = String(p.getProperty('BACKUP_TRY') || '').split(':'), n = tries[0] === ymd ? +tries[1] || 0 : 0;
  if (n >= BACKUP_TRIES) return '';
  p.setProperty('BACKUP_TRY', ymd + ':' + (n + 1));
  const r = backupNow(now);
  if (r.ok) p.setProperty('BACKUP_DAY', ymd);
  return r.text;
}
function backupNow(nowArg) {
  const now = +nowArg || Date.now(), p = scriptProps(), o = omanDay(now);
  const base = 'SPMS-Oman-backup-' + o.ymd + '-' + gulfTime(now).slice(-5).replace(':', '');
  const made = []; let docs = 0, bytes = 0;
  try {
    let cols = {}, chars = 0, inPart = 0;
    /* one file: the documents read since the last one */
    const save = () => {
      const n = made.length + 1, name = base + '-part' + n + '.json.gz';
      const json = JSON.stringify({ app: 'SPMS Oman', project: projectId(), at: new Date(now).toISOString(), backup: base, part: n, documents: inPart, collections: cols });
      const gz = Utilities.gzip(Utilities.newBlob(json, 'application/json', name.replace(/\.gz$/, '')), name), size = gz.getBytes().length;
      if (size > BACKUP_MAX) throw new Error('the backup file is too large (' + Math.round(size / 1048576) + ' MB)');
      made.push(backupFolder().createFile(gz)); bytes += size;
      cols = {}; chars = 0; inPart = 0;
    };
    for (const c of BACKUP_COLS) {
      cols[c] = cols[c] || [];
      eachRawPage(c, page => {
        for (const d of page) {
          const len = JSON.stringify(d).length + 1;
          if (chars + len > BACKUP_PART && inPart) save();
          (cols[c] = cols[c] || []).push(d); chars += len; inPart++; docs++;
        }
      });
    }
    save();
    const names = made.length === 1 ? [base + '.json.gz'] : made.map((f, i) => base + '-part' + (i + 1) + 'of' + made.length + '.json.gz');
    made.forEach((f, i) => f.setName(names[i]));
    const trashed = backupPrune();
    const kb = Math.max(1, Math.round(bytes / 1024)), what = made.length === 1 ? names[0] : base + ' (' + made.length + ' files)';
    p.setProperty('BACKUP_LAST', JSON.stringify({ at: now, name: what, files: made.length, docs: docs, kb: kb }));
    p.deleteProperty('BACKUP_ERR');
    const text = 'backup saved: ' + what + ' · ' + docs + ' records · ' + kb + ' KB' + (trashed ? ' · ' + trashed + ' old moved to the bin' : '');
    console.log(text);   /* shown in the editor's Execution log when backupNow is run by hand */
    return { ok: true, text: text };
  } catch (e) {
    for (const f of made) { try { f.setTrashed(true); } catch (x) { /* already gone */ } }   /* no half backup is left */
    p.setProperty('BACKUP_ERR', JSON.stringify({ at: now, msg: String(e.message || e).slice(0, 200) }));
    console.warn('Backup: ' + e.message);
    return { ok: false, text: 'backup failed: ' + e.message };
  }
}
/* for the setup check: when the last backup was saved, or why the last try failed */
function backupStatus() {
  const p = scriptProps(), j = k => { try { return JSON.parse(p.getProperty(k) || 'null'); } catch (e) { return null; } };
  const last = j('BACKUP_LAST'), err = j('BACKUP_ERR');
  const good = last ? 'last ' + gulfTime(last.at) + ' (' + last.docs + ' records' + (last.files > 1 ? ', ' + last.files + ' files' : '') + ')' : 'none yet';
  return err && (!last || +err.at > +last.at) ? 'last try failed ' + gulfTime(err.at) + ': ' + err.msg + ' · ' + good : good;
}
/* every document of a collection as Firestore stores it (field types kept, so a backup can be put back as it was),
   a page at a time, so the whole database is never in memory at once */
function eachRawPage(col, fn) {
  let page = '';
  do {
    const d = fsCall('get', '/' + col + '?pageSize=' + BACKUP_PAGE + (page ? '&pageToken=' + encodeURIComponent(page) : '')) || {};
    fn((d.documents || []).map(x => ({ id: docId(x), fields: x.fields || {}, updateTime: x.updateTime || '' })));
    page = d.nextPageToken || '';
  } while (page);
}
/* the backup folder in the owner's Google Drive (made again if someone deleted it) */
function backupFolder() {
  const p = scriptProps(), id = p.getProperty('BACKUP_FOLDER');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { if (!/no item|not found/i.test(String(e.message))) throw e; /* deleted for good: make a new one */ } }
  const f = DriveApp.createFolder(BACKUP_FOLDER); p.setProperty('BACKUP_FOLDER', f.getId()); return f;
}
/* keep the newest 30 nights (all parts of a night count as one); older ones go to the Drive bin (emptied by Google after
   30 days). Returns how many files went to the bin. */
const backupNight = name => name.replace(/-part\d+(of\d+)?\.json\.gz$/, '').replace(/\.json\.gz$/, '');
function backupPrune() {
  const nights = {}, it = backupFolder().getFiles();
  while (it.hasNext()) {
    const f = it.next(); if (f.isTrashed() || !/^SPMS-Oman-backup-/.test(f.getName())) continue;
    const k = backupNight(f.getName()), t = +f.getDateCreated(), x = nights[k] || (nights[k] = { t: t, files: [] });
    x.files.push(f); if (t > x.t) x.t = t;
  }
  const old = Object.keys(nights).map(k => nights[k]).sort((x, y) => y.t - x.t).slice(BACKUP_KEEP);
  let n = 0; for (const x of old) for (const f of x.files) { f.setTrashed(true); n++; }
  return n;
}

/* ---------- Google sign-in for the sender ----------
   Normally the sender works as you (the owner of the Firebase project): Google gives it your access, limited to the
   database and notifications (see appsscript.json). Or, with the Script property SERVICE_ACCOUNT (the private key file
   from Firebase → Project settings → Service accounts), it works as the Firebase service account instead. */
const hasServiceAccount = () => !!PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT');
function projectId() { return hasServiceAccount() ? serviceAccount().project_id : SPMS_PROJECT; }
function authHeaders() {
  if (hasServiceAccount()) return { Authorization: 'Bearer ' + accessToken() };
  return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': SPMS_PROJECT };
}
function serviceAccount() {
  const raw = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT');
  if (!raw) throw new Error('add the Script property SERVICE_ACCOUNT (the private key file from Firebase)');
  let k; try { k = JSON.parse(raw); } catch (e) { throw new Error('SERVICE_ACCOUNT is not the whole private key file: paste everything from { to }'); }
  if (!k.client_email || !k.private_key || !k.project_id) throw new Error('SERVICE_ACCOUNT is missing client_email, private_key or project_id');
  return k;
}
function accessToken(scope, cacheKey) {
  scope = scope || 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging';
  cacheKey = cacheKey || 'spms-token';
  const cache = CacheService.getScriptCache(), hit = cache.get(cacheKey); if (hit) return hit;
  const k = serviceAccount(), now = Math.floor(Date.now() / 1000);
  const b64 = v => Utilities.base64EncodeWebSafe(v).replace(/=+$/, '');
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({ iss: k.client_email, scope: scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64(Utilities.computeRsaSha256Signature(head + '.' + claim, k.private_key));
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Google did not accept the private key: ' + r.getContentText().slice(0, 300));
  const t = JSON.parse(r.getContentText()).access_token;
  cache.put(cacheKey, t, 3000);
  return t;
}

/* ---------- the Firebase database (Firestore) over its web address ---------- */
function fsUrl(path) { return 'https://firestore.googleapis.com/v1/projects/' + projectId() + '/databases/' + encodeURIComponent(SPMS_DATABASE) + '/documents' + path; }
function fsCall(method, path, body) {
  const o = { method, headers: authHeaders(), muteHttpExceptions: true };
  if (body) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(fsUrl(path), o), c = r.getResponseCode();
  if (c === 404) return null;
  if (c !== 200) throw new Error('Firestore ' + method + ' ' + path + ': ' + c + ' ' + r.getContentText().slice(0, 300));
  return JSON.parse(r.getContentText() || '{}');
}
function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}
function fromFields(f) { const o = {}; for (const k of Object.keys(f)) o[k] = fromValue(f[k]); return o; }
function toValue(v) {
  if (v == null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
const docId = d => decodeURIComponent(String(d.name).split('/').pop());
function getDoc(col, id) { const d = fsCall('get', '/' + col + '/' + encodeURIComponent(id)); return d && d.fields ? Object.assign(fromFields(d.fields), { id }) : null; }
function listDocs(col) {
  const out = []; let page = '';
  do {
    const d = fsCall('get', '/' + col + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : '')) || {};
    for (const x of d.documents || []) out.push(Object.assign(fromFields(x.fields || {}), { id: docId(x) }));
    page = d.nextPageToken || '';
  } while (page);
  return out;
}
function setDoc(col, id, obj) { const fields = {}; for (const k of Object.keys(obj)) fields[k] = toValue(obj[k]); fsCall('patch', '/' + col + '/' + encodeURIComponent(id), { fields }); }
/* change only the named fields, leaving the rest of the document untouched */
function mergeDoc(col, id, obj) { const fields = {}, mask = Object.keys(obj).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&'); for (const k of Object.keys(obj)) fields[k] = toValue(obj[k]); fsCall('patch', '/' + col + '/' + encodeURIComponent(id) + '?' + mask, { fields }); }
function delDoc(col, id) { try { fsCall('delete', '/' + col + '/' + encodeURIComponent(id)); } catch (e) { console.warn(e.message); } }
