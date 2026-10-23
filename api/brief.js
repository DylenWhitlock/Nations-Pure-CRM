// /api/brief?t=<token> — plain-text morning briefing for the GM (yesterday, month to date,
// today's schedule, and what needs attention). The token is checked in the database function
// public.morning_brief() (see supabase-schema.sql), so the link only works with the secret.

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const TZ = 'America/Chicago';
const FORMER_REPS = ['tony rodriguez'];

function ymdIn(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function money(n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); }
function first(n) { return (n || '').trim().split(/\s+/)[0] || 'Unassigned'; }
function slot(s) {
  if (!/^\d{1,2}:\d{2}$/.test(s || '')) return '';
  const [h, m] = s.split(':').map(Number);
  return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm');
}
function city(addr) {
  const parts = (addr || '').split(',').map(p => p.trim()).filter(Boolean);
  const rest = parts.filter(p => !/^(tx|texas)\b|^\d{5}(-\d{4})?$|^usa?$/i.test(p));
  return rest.length > 1 ? rest[rest.length - 1] : '';
}
function longDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
}
function pct(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; }

function buildBrief(leads, blocks) {
  const today = ymdIn(Date.now()), yest = addDays(today, -1), month = today.slice(0, 7);
  const L = leads.map(l => ({ ...l, stage: l.stage === 'quoted' && Date.now() - Number(l.updated_at || l.created_at) >= 7 * 864e5 ? 'lost' : l.stage, ch: l.channel === 'service' ? 'service' : 'install',
    created: ymdIn(Number(l.created_at)), updated: ymdIn(Number(l.updated_at || l.created_at)), price: Number(l.sale_price) || 0 }));
  const svc = l => (l.ch === 'service' ? ' (service)' : '');
  const out = [];
  out.push(`Good morning — ${longDay(today)}`);

  // Yesterday
  const yNew = L.filter(l => l.created === yest);
  const yRan = L.filter(l => l.appt_date === yest);
  const yWon = L.filter(l => l.stage === 'won' && l.updated === yest);
  out.push('', 'YESTERDAY');
  out.push(`${yNew.length} new lead${yNew.length === 1 ? '' : 's'}` + (yNew.some(l => l.ch === 'service') ? ` (${yNew.filter(l => l.ch === 'service').length} service)` : ''));
  if (yRan.length) {
    out.push(`${yRan.length} appointment${yRan.length === 1 ? '' : 's'} run:`);
    yRan.sort((a, b) => (a.appt_start || '').localeCompare(b.appt_start || '')).forEach(l => {
      const res = l.stage === 'won' ? 'WON ' + money(l.price) : l.stage === 'lost' ? 'lost' : 'no outcome yet';
      out.push(`- ${first(l.assigned_rep)}: ${l.name || 'Customer'}${city(l.address) ? ', ' + city(l.address) : ''} — ${res}${svc(l)}`);
    });
  } else out.push('No appointments run');
  if (yWon.length) out.push(`Sold: ${yWon.length} for ${money(yWon.reduce((s, l) => s + l.price, 0))}`);

  // Month to date (installs)
  const inM = d => d && d.slice(0, 7) === month && d <= today;
  // only deals marked won or lost count (same rule as the CRM's Analytics tab)
  const decided = l => l.stage === 'won' || (l.stage === 'lost' && !!l.appt_date);
  const dDay = l => l.appt_date || l.updated;
  const mRan = L.filter(l => l.ch === 'install' && decided(l) && inM(dDay(l)));
  const mWon = mRan.filter(l => l.stage === 'won');
  const mRev = mWon.reduce((s, l) => s + l.price, 0);
  out.push('', 'MONTH TO DATE (installs)');
  out.push(`${money(mRev)} revenue · ${mWon.length} won · ${mRan.length - mWon.length} lost · ${pct(mWon.length, mRan.length)} close · ${mWon.length ? money(mRev / mWon.length) : '—'} avg`);
  const reps = [...new Set([...mRan, ...mWon].map(l => l.assigned_rep).filter(r => r && !FORMER_REPS.includes(r.trim().toLowerCase())))];
  reps.map(r => {
    const ran = mRan.filter(l => l.assigned_rep === r).length, won = mWon.filter(l => l.assigned_rep === r);
    return { r, ran, won: won.length, rev: won.reduce((s, l) => s + l.price, 0) };
  }).sort((a, b) => b.rev - a.rev).forEach(x => out.push(`- ${first(x.r)}: ${money(x.rev)} · ${x.won}/${x.ran} (${pct(x.won, x.ran)})`));

  // Today
  const tAppts = L.filter(l => l.appt_date === today && l.stage !== 'lost').sort((a, b) => (a.appt_start || '').localeCompare(b.appt_start || ''));
  out.push('', 'TODAY');
  if (tAppts.length) {
    const byRep = {};
    tAppts.forEach(l => (byRep[first(l.assigned_rep)] = byRep[first(l.assigned_rep)] || []).push(l));
    Object.entries(byRep).forEach(([r, list]) => {
      out.push(`${r} (${list.length}):`);
      list.forEach(l => out.push(`- ${slot(l.appt_start)} ${l.name || 'Customer'}${city(l.address) ? ', ' + city(l.address) : ''}${svc(l)}${l.off_hours && !l.rep_confirmed ? ' — NOT CONFIRMED by rep' : ''}`));
    });
  } else out.push('No appointments booked');
  const off = {};
  (blocks || []).filter(b => b.date === today && b.status === 'blocked').forEach(b => { off[first(b.rep)] = (off[first(b.rep)] || 0) + 1; });
  Object.entries(off).forEach(([r, n]) => out.push(`${r} has ${n >= 16 ? 'the day' : 'time'} blocked off`));

  // Needs attention
  const att = [];
  const noOutcome = L.filter(l => l.stage === 'scheduled' && l.appt_date && l.appt_date < today);
  if (noOutcome.length) att.push(`${noOutcome.length} past appointment${noOutcome.length === 1 ? '' : 's'} still need${noOutcome.length === 1 ? 's' : ''} won/lost: ` +
    noOutcome.slice(0, 5).map(l => `${first(l.assigned_rep)} – ${l.name || 'Customer'}`).join(', ') + (noOutcome.length > 5 ? '…' : ''));
  const cutoff = Date.now() - 24 * 3600e3;
  const stale = L.filter(l => l.stage === 'new' && Number(l.created_at) < cutoff);
  if (stale.length) att.push(`${stale.length} new lead${stale.length === 1 ? '' : 's'} untouched 24h+: ` +
    stale.sort((a, b) => a.created_at - b.created_at).slice(0, 5).map(l => l.name || 'Unnamed').join(', ') + (stale.length > 5 ? '…' : ''));
  const unassigned = L.filter(l => l.appt_date >= today && !l.assigned_rep && l.stage !== 'lost');
  if (unassigned.length) att.push(`${unassigned.length} upcoming appointment${unassigned.length === 1 ? '' : 's'} with no rep`);
  const unconfirmed = L.filter(l => l.off_hours && !l.rep_confirmed && l.appt_date >= today && !['won', 'lost'].includes(l.stage));
  if (unconfirmed.length) att.push(`${unconfirmed.length} off-hours appointment${unconfirmed.length === 1 ? '' : 's'} waiting on rep confirmation`);
  out.push('', 'NEEDS ATTENTION');
  out.push(...(att.length ? att.map(a => '- ' + a) : ['Nothing — all caught up']));
  return out.join('\n');
}

module.exports = async function handler(req, res) {
  const token = String((req.query && req.query.t) || '');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (token.length < 32) { res.statusCode = 404; return res.end('Not found'); }
  if (!SB_URL || !SB_ANON) { res.statusCode = 500; return res.end('Server not configured'); }
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/morning_brief`, {
      method: 'POST',
      headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) { console.error('brief rpc', r.status, data); res.statusCode = 502; return res.end('Briefing unavailable — database function not set up yet'); }
    if (!data) { res.statusCode = 404; return res.end('Not found'); }
    res.statusCode = 200;
    return res.end(buildBrief(data.leads || [], data.blocks || []));
  } catch (e) {
    console.error('brief', e);
    res.statusCode = 500; return res.end('Briefing failed');
  }
};
module.exports.buildBrief = buildBrief;
