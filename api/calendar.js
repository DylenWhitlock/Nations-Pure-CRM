// /api/calendar?t=<token> — private calendar feed (iCal) of booked CRM appointments.
//
// Each specialist (and the whole team) gets a secret link from the CRM's Calendar tab →
// "Sync to Google". Paste it into Google Calendar → Other calendars → From URL.
// The link's token is checked in the database function public.calendar_feed(), which only
// returns appointments for the specialist that link belongs to.

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const TZ = 'America/Chicago';

// minutes in the home, same as the CRM's scheduling rules
const REP_MINUTES = { 'dylen whitlock': 30, 'chris novotny': 60, 'tony rodriguez': 60 };
function minutesFor(rep) { return REP_MINUTES[(rep || '').trim().toLowerCase()] || 60; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}
// fold lines at 75 octets per RFC 5545
function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const out = []; let cur = ''; let curLen = 0; let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (curLen + n > limit) { out.push(cur); cur = ''; curLen = 0; limit = 74; }
    cur += ch; curLen += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function pad(n) { return String(n).padStart(2, '0'); }
function localStamp(dateStr, minutes) {
  // dateStr YYYY-MM-DD, minutes from midnight (may roll past midnight)
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`;
}
function utcStamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:America/Chicago',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

function buildIcs(feed) {
  const team = feed.rep === '*';
  const calName = team ? "Nation's Pure — Team Appointments" : `Nation's Pure — ${feed.rep}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', "PRODID:-//Nation's Pure//CRM//EN", 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(calName), 'X-WR-TIMEZONE:' + TZ, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H', ...VTIMEZONE,
  ];
  for (const a of feed.appts || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.appt_date || '') || !/^\d{1,2}:\d{2}$/.test(a.appt_start || '')) continue;
    const [h, m] = a.appt_start.split(':').map(Number);
    const start = h * 60 + m;
    const end = start + minutesFor(a.assigned_rep);
    const service = a.channel === 'service';
    const who = (a.name || 'Customer').trim();
    const firstName = (a.assigned_rep || '').trim().split(' ')[0];
    const summary = (service ? 'Service: ' : 'Water appt: ') + who + (team && firstName ? ` (${firstName})` : '')
      + (a.stage === 'won' ? ' — SOLD' : '');
    const desc = [
      a.phone ? 'Phone: ' + a.phone : '',
      a.email ? 'Email: ' + a.email : '',
      a.need ? 'Need: ' + a.need : '',
      team && a.assigned_rep ? 'Specialist: ' + a.assigned_rep : '',
      a.notes ? 'Notes: ' + a.notes : '',
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.id}@nations-pure-crm`,
      'DTSTAMP:' + utcStamp(a.updated_at),
      'LAST-MODIFIED:' + utcStamp(a.updated_at),
      `DTSTART;TZID=${TZ}:` + localStamp(a.appt_date, start),
      `DTEND;TZID=${TZ}:` + localStamp(a.appt_date, end),
      'SUMMARY:' + esc(summary),
      ...(a.address ? ['LOCATION:' + esc(a.address)] : []),
      ...(desc ? ['DESCRIPTION:' + esc(desc)] : []),
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

async function handler(req, res) {
  const q = req.query || {};
  const token = String(q.t || q.token || '').trim();
  if (!/^[a-f0-9]{32,128}$/i.test(token)) { res.statusCode = 404; return res.end('Not found'); }
  if (!SB_URL || !SB_ANON) { res.statusCode = 500; return res.end('Not configured'); }
  let r, feed;
  try {
    r = await fetch(`${SB_URL}/rest/v1/rpc/calendar_feed`, {
      method: 'POST',
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
    });
    feed = await r.json().catch(() => null);
  } catch (e) {
    console.error('calendar rpc', e);
    res.statusCode = 502; return res.end('Calendar unavailable');
  }
  if (!r.ok) { console.error('calendar rpc', r.status, feed); res.statusCode = 502; return res.end('Calendar unavailable'); }
  if (!feed || !feed.rep) { res.statusCode = 404; return res.end('Not found'); }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="nations-pure.ics"');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.end(buildIcs(feed));
}

module.exports = handler;
module.exports._buildIcs = buildIcs; // for tests
