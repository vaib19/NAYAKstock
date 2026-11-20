const http = require("http");
const fs = require("fs");
const path = require("path");
const { UNIVERSE } = require("./universe");

const PORT = Number(process.env.PORT) || 4173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const CACHE_MS = 90_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

let cache = { at: 0, payload: null, pending: null };

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round(n, d = 2) {
  if (n == null || Number.isNaN(n)) return null;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function parseChart(symbol, json) {
  const result = json?.chart?.result?.[0];
  if (!result?.meta) return null;
  const meta = result.meta;
  const quote = result.indicators?.quote?.[0] || {};
  const bars = [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];
  const highs = quote.high || [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] == null) continue;
    bars.push({
      close: closes[i],
      volume: volumes[i] ?? 0,
      high: highs[i] ?? closes[i]
    });
  }
  if (bars.length < 22) return null;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const price = meta.regularMarketPrice ?? last.close;
  const dayPct =
    meta.regularMarketChangePercent != null
      ? meta.regularMarketChangePercent
      : ((price - prev.close) / prev.close) * 100;

  let todayVol = meta.regularMarketVolume;
  if (!todayVol) todayVol = last.volume || prev.volume;
  const history = bars.slice(-21, -1);
  const avgVolume = mean(history.map((b) => b.volume).filter((v) => v > 0));
  const volRatio = avgVolume ? todayVol / avgVolume : null;

  const sma = (n) => mean(bars.slice(-n).map((b) => b.close));
  const sma20 = sma(20);
  const sma50 = bars.length >= 50 ? sma(50) : null;
  const closeNAgo = (n) => (bars.length > n ? bars[bars.length - 1 - n].close : null);
  const ret = (n) => {
    const base = closeNAgo(n);
    return base ? ((price - base) / base) * 100 : null;
  };
  const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
  const distFromHigh20 = high20 ? ((high20 - price) / high20) * 100 : null;
  const high52 = meta.fiftyTwoWeekHigh;
  const distFrom52w = high52 ? ((high52 - price) / high52) * 100 : null;

  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    price,
    dayPct,
    volume: todayVol,
    avgVolume,
    volRatio,
    ret5: ret(5),
    ret20: ret(20),
    aboveSma20: sma20 != null && price >= sma20,
    aboveSma50: sma50 != null && price >= sma50,
    sma20,
    sma50,
    distFromHigh20,
    distFrom52w,
    high52,
    spark: bars.slice(-40).map((b) => round(b.close, 2)),
    updatedAt: (meta.regularMarketTime || 0) * 1000
  };
}

function scoreStock(row) {
  const r = row.volRatio ?? 0;
  const day = row.dayPct ?? 0;

  let activity = 4;
  if (r >= 3) activity = 35;
  else if (r >= 2) activity = 30;
  else if (r >= 1.5) activity = 24;
  else if (r >= 1.2) activity = 18;
  else if (r >= 0.9) activity = 10;

  let confirmation = 0;
  if (day > 0 && r >= 1.2) confirmation = 25;
  else if (day > 0 && r >= 0.9) confirmation = 16;
  else if (day > 0) confirmation = 8;
  else if (day > -0.4 && r >= 1.5) confirmation = 6;
  if (day <= -1.5) confirmation = 0;

  let trend = 0;
  if (row.aboveSma20) trend += 10;
  if (row.aboveSma50) trend += 8;
  if ((row.ret5 ?? 0) > 0) trend += 4;
  if ((row.ret20 ?? 0) > 0) trend += 3;

  let setup = 0;
  if (row.distFromHigh20 != null && row.distFromHigh20 <= 2) setup += 8;
  else if (row.distFromHigh20 != null && row.distFromHigh20 <= 6) setup += 5;
  if (row.distFrom52w != null && row.distFrom52w <= 8) setup += 7;
  else if (row.distFrom52w != null && row.distFrom52w <= 15) setup += 4;
  if (day > 5) setup -= 6;
  if (day > 8) setup -= 4;
  setup = clamp(setup, 0, 15);

  const parts = { activity, confirmation, trend, setup };
  const score = activity + confirmation + trend + setup;
  const favourable =
    score >= 70 && day > 0 && day < 6 && r >= 1.3 && row.aboveSma20;

  const why = [];
  const caution = [];
  if (r >= 2) why.push(`Volume is ${r.toFixed(1)}× the recent average, so a lot of people are trading it.`);
  else if (r >= 1.3) why.push(`Volume is ${r.toFixed(1)}× normal. The stock is more active than usual.`);
  else why.push("Volume is ordinary or quiet, so crowd interest is not elevated.");

  if (day > 0 && r >= 1.2) why.push(`Price is up ${day.toFixed(2)}% with that heavier volume, which usually means buyers are active.`);
  else if (day > 0) why.push(`Price is up ${day.toFixed(2)}% today, but volume is not confirming it strongly.`);
  else why.push(`Price is ${day.toFixed(2)}% today, so the session itself is not supportive.`);

  if (row.aboveSma20 && row.aboveSma50) why.push("Price is above both the 20-day and 50-day averages.");
  else if (row.aboveSma20) why.push("Price is above the 20-day average, but not the 50-day average.");
  else caution.push("Price is below the 20-day average. The short trend is not in favour.");

  if (row.distFromHigh20 != null && row.distFromHigh20 <= 2) why.push("It is pressing the 20-day high, a sign of strength.");
  if (row.distFrom52w != null && row.distFrom52w <= 8) why.push("It is close to the 52-week high.");
  else if (row.distFrom52w != null && row.distFrom52w > 25) caution.push(`It is still ${row.distFrom52w.toFixed(0)}% under the 52-week high.`);

  if (day > 5) caution.push(`Already up ${day.toFixed(1)}% today. A fast jump can reverse just as quickly.`);
  if ((row.ret5 ?? 0) > 12) caution.push(`Up ${row.ret5.toFixed(1)}% in about a week. The move may already be crowded.`);
  if (r >= 2 && day < -1) caution.push("Heavy volume on a down day can mean people are selling, not accumulating.");

  let heat = "Quiet";
  if (r >= 2) heat = "Crowded";
  else if (r >= 1.3) heat = "Active";

  return { ...row, parts, score, favourable, why, caution, heat };
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return out;
}

async function loadSymbol(entry) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(entry.symbol)}?interval=1d&range=6mo&includePrePost=false`;
  const json = await fetchJson(url);
  const parsed = parseChart(entry.symbol, json);
  if (!parsed) return null;
  return scoreStock({ ...parsed, ticker: entry.ticker, sector: entry.sector });
}

function slim(row) {
  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    price: round(row.price, 2),
    dayPct: round(row.dayPct, 2),
    volume: row.volume,
    avgVolume: row.avgVolume == null ? null : Math.round(row.avgVolume),
    volRatio: round(row.volRatio, 2),
    ret5: round(row.ret5, 2),
    ret20: round(row.ret20, 2),
    aboveSma20: row.aboveSma20,
    aboveSma50: row.aboveSma50,
    distFromHigh20: round(row.distFromHigh20, 2),
    distFrom52w: round(row.distFrom52w, 2),
    score: row.score,
    parts: row.parts,
    favourable: row.favourable,
    heat: row.heat,
    why: row.why,
    caution: row.caution,
    spark: row.spark
  };
}

async function buildBoard() {
  const indexPromise = fetchJson(
    "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1mo&includePrePost=false"
  ).catch(() => null);

  const rows = (await mapPool(UNIVERSE, 8, loadSymbol)).filter(Boolean);
  rows.sort((a, b) => b.score - a.score || (b.volRatio ?? 0) - (a.volRatio ?? 0));

  const indexJson = await indexPromise;
  const nifty = indexJson ? parseChart("^NSEI", indexJson) : null;
  const advancers = rows.filter((r) => (r.dayPct ?? 0) > 0).length;
  const favourable = rows.filter((r) => r.favourable);

  return {
    updatedAt: Date.now(),
    scanned: rows.length,
    requested: UNIVERSE.length,
    advancers,
    decliners: rows.length - advancers,
    favourableCount: favourable.length,
    nifty: nifty
      ? {
          price: round(nifty.price, 2),
          dayPct: round(nifty.dayPct, 2),
          spark: nifty.spark
        }
      : null,
    stocks: rows.map(slim),
    note:
      "A high score means the stock is active and the recent trend is supportive. It is a sign of interest, not a promise that the price will rise."
  };
}

async function getBoard() {
  if (cache.payload && Date.now() - cache.at < CACHE_MS) return cache.payload;
  if (!cache.pending) {
    cache.pending = buildBoard()
      .then((payload) => {
        cache = { at: Date.now(), payload, pending: null };
        return payload;
      })
      .catch((err) => {
        cache.pending = null;
        throw err;
      });
  }
  return cache.pending;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/api/board") {
      const board = await getBoard();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify(board));
      return;
    }

    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Market data could not be loaded. Try again in a moment." }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Nayakstock running at http://127.0.0.1:${PORT}`);
});
