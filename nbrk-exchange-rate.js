const fetch = require('node-fetch');
const { pool } = require('./auth');

// National Bank of Kazakhstan's public rates feed. Returns the official rate
// for the given date (their own snapshot of the previous trading day).
async function fetchRateFromNBRK(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const url = `https://nationalbank.kz/rss/get_rates.cfm?fdate=${dd}.${mm}.${yyyy}`;

  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`NBRK responded ${res.status}`);
  const xml = await res.text();

  const m = xml.match(/<title>USD<\/title>\s*<description>([\d.]+)<\/description>/);
  if (!m) throw new Error('USD rate not found in NBRK response');
  return parseFloat(m[1]);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Returns today's USD/KZT rate, using the DB cache if already fetched today,
// otherwise fetching fresh from NBRK and storing it. This is what bonus
// calculations should call — "rate at the moment the report is generated".
async function getTodayRate() {
  const today = new Date();
  const key = dateKey(today);

  const { rows } = await pool.query(
    'SELECT rate FROM ticketsmodule_exchange_rates WHERE rate_date=$1', [key]
  );
  if (rows.length) return parseFloat(rows[0].rate);

  const rate = await fetchRateFromNBRK(today);
  await pool.query(
    `INSERT INTO ticketsmodule_exchange_rates (rate_date, rate, fetched_at) VALUES ($1,$2,NOW())
     ON CONFLICT (rate_date) DO UPDATE SET rate=$2, fetched_at=NOW()`,
    [key, rate]
  );
  return rate;
}

// Looks up the rate for an arbitrary past date — checks the cache first,
// falls back to asking NBRK directly (their feed serves historical dates too).
async function getRateForDate(date) {
  const key = dateKey(date);
  const { rows } = await pool.query(
    'SELECT rate FROM ticketsmodule_exchange_rates WHERE rate_date=$1', [key]
  );
  if (rows.length) return parseFloat(rows[0].rate);

  const rate = await fetchRateFromNBRK(date);
  await pool.query(
    `INSERT INTO ticketsmodule_exchange_rates (rate_date, rate, fetched_at) VALUES ($1,$2,NOW())
     ON CONFLICT (rate_date) DO UPDATE SET rate=$2, fetched_at=NOW()`,
    [key, rate]
  );
  return rate;
}

// Called once a day (see server.js) to keep the cache warm and give a
// visible daily-updating rate even before anyone runs a bonus calculation.
async function refreshDailyRate() {
  try {
    const rate = await getTodayRate();
    console.log(`💱 Курс USD/KZT обновлён: ${rate}`);
  } catch (e) {
    console.error('refreshDailyRate error:', e.message);
  }
}

module.exports = { getTodayRate, getRateForDate, refreshDailyRate };
