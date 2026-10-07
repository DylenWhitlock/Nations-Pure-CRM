// /api/property — house photo + estimated value for an appointment address.
//
// GET /api/property?address=...            (needs the signed-in user's Supabase token)
//   -> { address, lat, lng, photoUrl, value, valueLow, valueHigh, beds, baths, sqft,
//        lotSqft, yearBuilt, propertyType, lastSaleDate, lastSalePrice, valueStatus }
// GET /api/property?address=...&mode=photo  -> { photoUrl } only (no RentCast call, free)
// GET /api/property?photo=1&a=...&s=...     -> the image itself (signed link, safe for <img>)
//
// Vercel environment variables:
//   GOOGLE_MAPS_KEY    Google Cloud key with Geocoding, Street View Static and Maps Static APIs on
//   RENTCAST_API_KEY   from app.rentcast.io (value estimate + beds/baths/sqft/year built)
//   SUPABASE_URL       same value as in config.js
//   SUPABASE_ANON_KEY  same value as in config.js

const crypto = require('node:crypto');

const G = process.env.GOOGLE_MAPS_KEY || '';
const RC = process.env.RENTCAST_API_KEY || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';

function normAddr(a) {
  let s = String(a || '').replace(/\s+/g, ' ').trim();
  if (s && !/\b(TX|Texas)\b/i.test(s)) s += ', TX';
  return s;
}
function sign(addr) {
  return crypto.createHmac('sha256', G || 'unset').update(addr.toLowerCase()).digest('hex').slice(0, 32);
}
function photoLink(addr) {
  return `/api/property?photo=1&a=${encodeURIComponent(addr)}&s=${sign(addr)}`;
}

async function signedInUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !SB_URL || !SB_ANON) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: auth } });
  return r.ok ? r.json() : null;
}

async function geocode(addr) {
  if (!G) return null;
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&region=us&key=${G}`);
  const j = await r.json();
  const hit = j.results && j.results[0];
  if (!hit) return null;
  return { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, formatted: hit.formatted_address };
}

function bearing(from, to) {
  const rad = d => d * Math.PI / 180;
  const y = Math.sin(rad(to.lng - from.lng)) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
            Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(rad(to.lng - from.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Street View pointed at the house; satellite view when the street has no coverage.
async function photoImageUrl(addr) {
  const geo = await geocode(addr);
  if (!geo) return null;
  const house = { lat: geo.lat, lng: geo.lng };
  const meta = await (await fetch(
    `https://maps.googleapis.com/maps/api/streetview/metadata?location=${house.lat},${house.lng}&radius=60&source=outdoor&key=${G}`
  )).json();
  if (meta.status === 'OK' && meta.location) {
    const heading = Math.round(bearing(meta.location, house));
    return `https://maps.googleapis.com/maps/api/streetview?size=640x400&pano=${meta.pano_id}&heading=${heading}&fov=70&pitch=4&key=${G}`;
  }
  return `https://maps.googleapis.com/maps/api/staticmap?center=${house.lat},${house.lng}&zoom=20&size=640x400&scale=2&maptype=satellite&key=${G}`;
}

async function rentcastValue(addr) {
  const r = await fetch(`https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(addr)}&compCount=5`, {
    headers: { 'X-Api-Key': RC, Accept: 'application/json' },
  });
  if (r.status === 404) return { status: 'no_data' };
  if (r.status === 401 || r.status === 403) return { status: 'bad_key' };
  if (r.status === 429) return { status: 'quota' };
  if (!r.ok) return { status: 'error' };
  const j = await r.json();
  const p = j.subjectProperty || {};
  return {
    status: j.price ? 'ok' : 'no_data',
    value: j.price ?? null, valueLow: j.priceRangeLow ?? null, valueHigh: j.priceRangeHigh ?? null,
    beds: p.bedrooms ?? null, baths: p.bathrooms ?? null, sqft: p.squareFootage ?? null,
    lotSqft: p.lotSize ?? null, yearBuilt: p.yearBuilt ?? null, propertyType: p.propertyType ?? null,
    lastSaleDate: p.lastSaleDate ?? null, lastSalePrice: p.lastSalePrice ?? null,
  };
}

module.exports = async function handler(req, res) {
  try {
    // 1) The image itself — signed link, so it can sit in an <img> tag without a login header.
    if (req.query.photo) {
      const addr = String(req.query.a || '');
      if (!G || !addr || req.query.s !== sign(addr)) return res.status(403).end();
      const url = await photoImageUrl(addr);
      if (!url) return res.status(404).end();
      const img = await fetch(url);
      if (!img.ok) return res.status(502).end();
      res.setHeader('Content-Type', img.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=2592000, s-maxage=2592000, immutable');
      return res.status(200).send(Buffer.from(await img.arrayBuffer()));
    }

    // 2) Lookups need a signed-in teammate (these calls cost money).
    if (!(await signedInUser(req))) return res.status(401).json({ error: 'Sign in required' });
    const raw = normAddr(req.query.address);
    if (!raw) return res.status(400).json({ error: 'Address required' });
    if (!G) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not set in Vercel' });

    if (req.query.mode === 'photo') return res.status(200).json({ photoUrl: photoLink(raw) });

    const geo = await geocode(raw);
    const addr = geo?.formatted || raw;
    const out = { address: addr, lat: geo?.lat ?? null, lng: geo?.lng ?? null, photoUrl: photoLink(raw) };
    Object.assign(out, RC ? await rentcastValue(addr) : { status: 'not_configured' });
    out.valueStatus = out.status; delete out.status;
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}
