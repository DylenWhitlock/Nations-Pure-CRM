// /api/web-lead — website lead intake for the Nation's Pure CRM.
//
// POST https://nations-pure-crm.vercel.app/api/web-lead
//   Accepts JSON, application/x-www-form-urlencoded, or multipart/form-data (Jotform webhooks).
//   Creates a lead in the CRM's "New Lead" column (Installs or Service side) and fires the
//   team's new-lead text. See the "Website Lead Integration" doc for the full field list.
//
// Uses the existing SUPABASE_URL / SUPABASE_ANON_KEY env vars. The insert itself runs in the
// database function public.submit_web_lead(), which validates, de-duplicates and rate-limits.

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const MAX_BYTES = 100 * 1024;

const TRACK_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'landing_page', 'referrer', 'page_url'];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BYTES) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Vercel may already have buffered/parsed the body; fall back to reading the stream.
async function rawOrParsed(req) {
  let b;
  try { b = req.body; } catch (e) { return { error: 'bad_body' }; }
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return { parsed: b };
  if (typeof b === 'string') return { raw: Buffer.from(b) };
  if (Buffer.isBuffer(b)) return { raw: b };
  return { raw: await readStream(req) };
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return {};
  const boundary = '--' + (m[1] || m[2]).trim();
  const out = {};
  const text = buf.toString('utf8');
  for (const part of text.split(boundary)) {
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    const nm = /name="([^"]*)"/i.exec(head);
    if (!nm || /filename="/i.test(head)) continue; // text fields only
    out[nm[1]] = part.slice(idx + 4).replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');
  }
  return out;
}

async function readFields(req) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const got = await rawOrParsed(req);
  if (got.error) throw new Error(got.error);
  if (got.parsed) return got.parsed;
  const buf = got.raw || Buffer.alloc(0);
  if (buf.length > MAX_BYTES) throw new Error('too_large');
  if (ct.includes('multipart/form-data')) return parseMultipart(buf, req.headers['content-type']);
  const s = buf.toString('utf8');
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
  if (!s.trim()) return {};
  try { return JSON.parse(s); } catch (e) { throw new Error('bad_json'); }
}

// Flatten Jotform's rawRequest ("q3_name": {first,last}, "q4_phone": {full}, ...) and our own keys.
function normalizeKeys(fields) {
  let src = { ...fields };
  if (typeof src.rawRequest === 'string') {
    try { const rr = JSON.parse(src.rawRequest); if (rr && typeof rr === 'object') src = { ...src, ...rr }; } catch (e) { /* ignore */ }
  }
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'rawRequest' || k === 'pretty') continue;
    const key = String(k).toLowerCase().replace(/^q\d+_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) continue;
    if (out[key] === undefined || out[key] === '') out[key] = v;
  }
  return out;
}
const str = (v, max = 500) => {
  if (v == null) return '';
  if (Array.isArray(v)) v = v.filter(x => x != null && typeof x !== 'object').join(', ');
  if (typeof v === 'object') return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
};
const textBlock = (v, max = 2000) => (v == null || typeof v === 'object') ? '' : String(v).replace(/\r\n?/g, '\n').trim().slice(0, max);
const pick = (f, keys) => { for (const k of keys) { if (f[k] != null && f[k] !== '') return f[k]; } return undefined; };

function buildName(f) {
  const n = pick(f, ['name', 'full_name', 'fullname', 'your_name', 'customer_name']);
  if (n && typeof n === 'object') return str([n.prefix, n.first, n.middle, n.last, n.suffix].filter(Boolean).join(' '), 120);
  if (n) return str(n, 120);
  return str([pick(f, ['first_name', 'firstname', 'first', 'fname']), pick(f, ['last_name', 'lastname', 'last', 'lname'])].filter(Boolean).join(' '), 120);
}
function buildPhone(f) {
  const p = pick(f, ['phone', 'phone_number', 'phonenumber', 'tel', 'telephone', 'mobile', 'cell', 'cell_phone']);
  if (p && typeof p === 'object') return str(p.full || [p.area, p.phone].filter(Boolean).join(' '), 40);
  return str(p, 40);
}
function buildAddress(f) {
  const a = pick(f, ['address', 'street_address', 'street', 'address1', 'address_line_1', 'service_address']);
  if (a && typeof a === 'object') {
    return str([a.addr_line1, a.addr_line2, a.city, [a.state, a.postal].filter(Boolean).join(' ')].filter(Boolean).join(', '), 200);
  }
  const line2 = pick(f, ['address2', 'address_line_2', 'unit', 'apt']);
  const city = pick(f, ['city', 'town']);
  const state = pick(f, ['state']);
  const zip = pick(f, ['zip', 'zipcode', 'zip_code', 'postal', 'postal_code', 'postcode']);
  return str([str(a), str(line2), str(city), [str(state), str(zip)].filter(Boolean).join(' ')].filter(Boolean).join(', '), 200);
}
function buildChannel(f) {
  const t = str(pick(f, ['service_type', 'lead_type', 'request_type', 'type_of_service', 'interest', 'how_can_we_help', 'reason']), 120).toLowerCase();
  if (!t) return 'install';
  if (/^service$/.test(t) || /(service|repair|maintenance|existing|not working|broken|salt|filter change|current customer)/.test(t)) return 'service';
  return 'install';
}
function deriveSource(f, tr) {
  const explicit = str(pick(f, ['lead_source']), 80);
  if (explicit) return explicit;
  const src = (tr.utm_source || '').toLowerCase(), med = (tr.utm_medium || '').toLowerCase();
  const ref = (tr.referrer || '').toLowerCase();
  if (/(^|[^a-z])lsa([^a-z]|$)|local.?services/.test(src + ' ' + med)) return 'Google LSA';
  if (tr.gclid || tr.gbraid || tr.wbraid) return 'Google Ads';
  if (/google/.test(src)) {
    if (/(gbp|gmb|business|maps|local)/.test(med + ' ' + (tr.utm_campaign || '').toLowerCase())) return 'Google Business Profile';
    if (/(cpc|ppc|paid|ads|sem)/.test(med)) return 'Google Ads';
    return 'Google';
  }
  if (tr.fbclid || /(facebook|^fb$|meta)/.test(src)) return 'Facebook';
  if (/(instagram|^ig$)/.test(src)) return 'Instagram';
  if (tr.msclkid || /bing/.test(src)) return 'Bing';
  if (src) return str(tr.utm_source, 60).replace(/^./, c => c.toUpperCase());
  if (/(^|\.)google\./.test(hostOf(ref))) return 'Google';
  if (/bing\.com$/.test(hostOf(ref))) return 'Bing';
  if (/(facebook\.com|fb\.com)$/.test(hostOf(ref))) return 'Facebook';
  if (/yelp\.com$/.test(hostOf(ref))) return 'Yelp';
  if (/nextdoor\.com$/.test(hostOf(ref))) return 'Nextdoor';
  return 'Website';
}
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }

function buildLead(fields) {
  const f = normalizeKeys(fields || {});
  const tr = {};
  for (const k of TRACK_KEYS) { const v = str(f[k], 500); if (v) tr[k] = v; }
  if (f.submissionid) tr.jotform_submission_id = str(f.submissionid, 60);
  if (f.formid) tr.jotform_form_id = str(f.formid, 60);
  const need = textBlock(pick(f, ['message', 'comments', 'comment', 'need', 'details', 'notes', 'question', 'what_do_you_need', 'tell_us_more']));
  return {
    honeypot: str(f.company_website, 200),
    lead: {
      name: buildName(f),
      phone: buildPhone(f),
      email: str(pick(f, ['email', 'email_address', 'e_mail', 'your_email']), 160),
      address: buildAddress(f),
      county: str(pick(f, ['county']), 60),
      need,
      requested_window: str(pick(f, ['preferred_time', 'best_time', 'best_time_to_call', 'requested_window']), 120),
      channel: buildChannel(f),
      lead_source: deriveSource(f, tr),
      tracking: tr,
    },
    redirect: str(pick(f, ['_redirect', 'redirect']), 500),
  };
}

function safeRedirect(url, req) {
  if (!/^https:\/\//i.test(url)) return null;
  const ref = req.headers.origin || req.headers.referer || '';
  const h = hostOf(url), r = hostOf(ref);
  if (!h || !r) return null;
  const base = x => x.replace(/^www\./, '');
  return base(h) === base(r) ? url : null;
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method === 'GET') return send(res, 200, { ok: true, service: "Nation's Pure web-lead intake", method: 'POST' });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!SB_URL || !SB_ANON) return send(res, 500, { ok: false, error: 'not_configured' });

  let fields;
  try { fields = await readFields(req); }
  catch (e) {
    const code = e.message === 'too_large' ? 'too_large' : 'bad_body';
    return send(res, code === 'too_large' ? 413 : 400, { ok: false, error: code });
  }
  const { honeypot, lead, redirect } = buildLead(fields);
  const q = req.query || {};
  const dryRun = q.dry_run === '1' || fields.dry_run === '1' || fields.dry_run === true;
  const go = redirect ? safeRedirect(redirect, req) : null;

  if (honeypot) { // bot — pretend success, store nothing
    if (go) { res.statusCode = 303; res.setHeader('Location', go); return res.end(); }
    return send(res, 200, { ok: true });
  }
  if (!lead.name) return send(res, 400, { ok: false, error: 'name_required', message: 'Please enter your name.' });
  const digits = lead.phone.replace(/\D/g, '');
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email);
  if (digits.length < 10 && !emailOk) return send(res, 400, { ok: false, error: 'contact_required', message: 'Please enter a phone number or email.' });
  if (dryRun) return send(res, 200, { ok: true, dry_run: true, lead });

  let r, j;
  try {
    r = await fetch(`${SB_URL}/rest/v1/rpc/submit_web_lead`, {
      method: 'POST',
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: lead }),
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    console.error('web-lead rpc', e);
    return send(res, 502, { ok: false, error: 'crm_unreachable' });
  }
  if (!r.ok || !j) { console.error('web-lead rpc', r.status, j); return send(res, 502, { ok: false, error: 'crm_error' }); }
  if (!j.ok) {
    const status = j.error === 'rate_limited' ? 429 : 400;
    return send(res, status, { ok: false, error: j.error || 'rejected' });
  }
  if (go) { res.statusCode = 303; res.setHeader('Location', go); return res.end(); }
  return send(res, 200, { ok: true, id: j.id, duplicate: !!j.duplicate });
}

module.exports = handler;
module.exports._buildLead = buildLead; // for tests
