// /api/drive — real driving times between appointment addresses (Google Routes API).
//
// POST /api/drive   body: { "addresses": ["addr A", "addr B", ...] }   (signed-in staff only)
//   -> { "minutes": [[0, 22, ...], [21, 0, ...], ...] }   minutes[i][j] = drive time from i to j,
//      null where Google could not find a route.
//
// Uses the same GOOGLE_MAPS_KEY as /api/property (the key must allow "Routes API").

const G = process.env.GOOGLE_MAPS_KEY || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';

function normAddr(a) {
  let s = String(a || '').replace(/\s+/g, ' ').trim();
  if (s && !/\b(TX|Texas)\b/i.test(s)) s += ', TX';
  return s;
}

async function signedInUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !SB_URL || !SB_ANON) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: auth } });
  return r.ok ? r.json() : null;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
    if (!(await signedInUser(req))) return res.status(401).json({ error: 'Sign in required' });
    if (!G) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not set in Vercel' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const list = Array.isArray(body.addresses) ? body.addresses.map(normAddr) : [];
    if (list.length < 2 || list.length > 20 || list.some(a => !a)) {
      return res.status(400).json({ error: 'Send 2–20 addresses' });
    }

    const wp = list.map(address => ({ waypoint: { address } }));
    const r = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': G,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition',
      },
      body: JSON.stringify({ origins: wp, destinations: wp, travelMode: 'DRIVE' }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(j)) {
      const msg = (j && j.error && j.error.message) || `Google returned ${r.status}`;
      console.error('routes error', msg);
      return res.status(502).json({ error: 'Drive-time service error: ' + msg });
    }

    const n = list.length;
    const minutes = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => (i === k ? 0 : null)));
    for (const e of j) {
      const i = e.originIndex || 0, k = e.destinationIndex || 0;   // index 0 is omitted by Google
      if (i === k) continue;
      if (e.condition === 'ROUTE_EXISTS' && e.duration) {
        minutes[i][k] = Math.ceil(parseInt(e.duration, 10) / 60);
      }
    }
    return res.status(200).json({ minutes });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Drive-time lookup failed' });
  }
};
