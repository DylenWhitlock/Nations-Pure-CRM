// Vercel serverless function: texts new-lead details to your team.
// Runs server-side only — Twilio credentials never reach the browser.
//
// Required environment variables (set in Vercel -> Project -> Settings -> Environment Variables):
//   TWILIO_ACCOUNT_SID     - starts with AC...
//   TWILIO_AUTH_TOKEN      - from the same Twilio console page
//   TWILIO_FROM_NUMBER     - your Twilio phone number, e.g. +12145551234
//   NOTIFY_PHONE_NUMBERS   - comma-separated numbers to text, e.g. +12145551234,+18175559876
//   SUPABASE_URL           - same value as window.SUPABASE_URL in config.js
//   SUPABASE_ANON_KEY      - same value as window.SUPABASE_ANON_KEY in config.js
//
// The request must include a valid signed-in Supabase user's access token
// (sent automatically by the CRM) so this endpoint can't be used by outsiders
// to spam your team's phones for free.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'Not signed in' }); return; }

    const { SUPABASE_URL, SUPABASE_ANON_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, NOTIFY_PHONE_NUMBERS } = process.env;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { res.status(500).json({ error: 'Server not configured (Supabase)' }); return; }

    // Verify this is really a signed-in teammate before sending any texts
    const whoResp = await fetch(SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY },
    });
    if (!whoResp.ok) { res.status(401).json({ error: 'Invalid session' }); return; }

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !NOTIFY_PHONE_NUMBERS) {
      res.status(500).json({ error: 'Texting isn\'t set up yet (missing Twilio environment variables)' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const name = (body.name || 'New lead').toString().slice(0, 80);
    const phone = (body.phone || '').toString().slice(0, 40);
    const need = (body.need || '').toString().slice(0, 160);
    const address = (body.address || '').toString().slice(0, 120);
    const county = (body.county || '').toString().slice(0, 60);
    const addedBy = (body.addedBy || '').toString().slice(0, 60);

    const lines = ['New lead: ' + name];
    if (phone) lines.push(phone);
    if (need) lines.push(need);
    const place = [address, county].filter(Boolean).join(', ');
    if (place) lines.push(place);
    if (addedBy) lines.push('Added by ' + addedBy);
    const message = lines.join('\n').slice(0, 1500);

    const numbers = NOTIFY_PHONE_NUMBERS.split(',').map(s => s.trim()).filter(Boolean);
    const authHeader = 'Basic ' + Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');

    const results = await Promise.all(numbers.map(async (to) => {
      try {
        const params = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: message });
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        const j = await r.json().catch(() => ({}));
        return { to, ok: r.ok, error: r.ok ? undefined : (j.message || r.statusText) };
      } catch (e) {
        return { to, ok: false, error: String(e) };
      }
    }));

    res.status(200).json({ sent: results.filter(r => r.ok).length, total: results.length, results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
