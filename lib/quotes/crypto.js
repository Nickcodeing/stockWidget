const { requestJson, firstSettled } = require('../http');
const { parseCryptoInstrument } = require('../symbols');
const { missingQuote } = require('./placeholder');

const BINANCE_SPOT = [
  'https://data-api.binance.vision',
  'https://api.binance.com'
];
const BINANCE_FUT = ['https://fapi.binance.com'];
const GATE = ['https://api.gateio.ws'];
const OKX = ['https://www.okx.com'];

function toQuote(inst, price, pct) {
  return {
    code: inst.code,
    name: inst.name,
    price,
    pct,
    secId: inst.secId,
    kind: inst.kind,
    kindLabel: inst.kindName
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function beijingHHmm(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${pad2(get('hour'))}:${pad2(get('minute'))}`;
}

function requestHosts(hosts, path) {
  return firstSettled(hosts.map((host) => requestJson(host + path)));
}

function pctFromOpen(last, open) {
  const price = Number(last);
  const prev = Number(open);
  if (!Number.isFinite(price) || !Number.isFinite(prev) || prev === 0) return null;
  return ((price - prev) / prev) * 100;
}

function tickerFromBinance(data) {
  const last = Number(data && data.lastPrice);
  const open = Number(data && data.openPrice);
  const pct = Number(data && data.priceChangePercent);
  return {
    price: last,
    pct: Number.isFinite(pct) ? pct : pctFromOpen(last, open),
    preClose: Number.isFinite(open) && open > 0 ? open : last / (1 + (Number(pct) || 0) / 100)
  };
}

function tickerFromOkx(json) {
  const row = json && json.data && json.data[0];
  if (!row) return null;
  const last = Number(row.last);
  const open = Number(row.open24h);
  return {
    price: last,
    pct: pctFromOpen(last, open),
    preClose: Number.isFinite(open) && open > 0 ? open : last
  };
}

function requireTicker(q, label) {
  if (!q || !Number.isFinite(Number(q.price)) || Number(q.price) <= 0) {
    throw new Error(label || 'empty ticker');
  }
  return q;
}

function tickerFromGateSpot(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return null;
  const last = Number(row.last);
  const pct = Number(row.change_percentage);
  const preClose = Number.isFinite(pct) ? last / (1 + pct / 100) : last;
  return { price: last, pct: Number.isFinite(pct) ? pct : null, preClose };
}

function tickerFromGateFut(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return null;
  const last = Number(row.last);
  const pct = Number(row.change_percentage);
  const preClose = Number.isFinite(pct) ? last / (1 + pct / 100) : last;
  return { price: last, pct: Number.isFinite(pct) ? pct : null, preClose };
}

function fetchGateTicker(inst) {
  if (inst.kind === 'perp') {
    return requestHosts(GATE, `/api/v4/futures/usdt/tickers?contract=${inst.base}_USDT`).then((data) =>
      requireTicker(tickerFromGateFut(data), 'gate fut')
    );
  }
  return requestHosts(GATE, `/api/v4/spot/tickers?currency_pair=${inst.base}_USDT`).then((data) =>
    requireTicker(tickerFromGateSpot(data), 'gate spot')
  );
}

function fetchBinanceTicker(inst) {
  const path = `/api/v3/ticker/24hr?symbol=${inst.binanceSymbol}`;
  const futPath = `/fapi/v1/ticker/24hr?symbol=${inst.binanceSymbol}`;
  if (inst.kind === 'perp') {
    return requestHosts(BINANCE_FUT, futPath).then((data) => requireTicker(tickerFromBinance(data), 'binance fut'));
  }
  return requestHosts(BINANCE_SPOT, path).then((data) => requireTicker(tickerFromBinance(data), 'binance spot'));
}

function fetchOkxTicker(inst) {
  return requestHosts(OKX, `/api/v5/market/ticker?instId=${inst.okxInstId}`).then((json) =>
    requireTicker(tickerFromOkx(json), 'okx')
  );
}

function fetchTicker(inst) {
  if (inst.kind === 'perp') {
    return firstSettled([fetchGateTicker(inst), fetchBinanceTicker(inst), fetchOkxTicker(inst)]);
  }
  return firstSettled([fetchBinanceTicker(inst), fetchGateTicker(inst), fetchOkxTicker(inst)]);
}

function pointsFromOhlcv(rows, tsIdx, closeIdx, volIdx, newestFirst) {
  const list = newestFirst ? [...rows].reverse() : rows;
  let sumPV = 0;
  let sumV = 0;
  return list
    .map((row) => {
      const t = Number(row[tsIdx]);
      const price = Number(row[closeIdx]);
      const vol = Number(row[volIdx]);
      if (!Number.isFinite(t) || !Number.isFinite(price)) return null;
      const v = Number.isFinite(vol) && vol > 0 ? vol : 1;
      sumPV += price * v;
      sumV += v;
      return {
        time: beijingHHmm(t),
        t,
        price,
        avg: sumV ? sumPV / sumV : price
      };
    })
    .filter(Boolean);
}

function fetchBinanceKlines(inst) {
  const qs = `symbol=${inst.binanceSymbol}&interval=5m&limit=288`;
  if (inst.kind === 'perp') {
    return requestHosts(BINANCE_FUT, `/fapi/v1/klines?${qs}`).then((rows) =>
      pointsFromOhlcv(rows, 0, 4, 5, false)
    );
  }
  return requestHosts(BINANCE_SPOT, `/api/v3/klines?${qs}`).then((rows) =>
    pointsFromOhlcv(rows, 0, 4, 5, false)
  );
}

function fetchGateKlines(inst) {
  if (inst.kind === 'perp') {
    return requestHosts(
      GATE,
      `/api/v4/futures/usdt/candlesticks?contract=${inst.base}_USDT&interval=5m&limit=288`
    ).then((rows) => {
      const list = Array.isArray(rows) ? rows : [];
      return pointsFromOhlcv(
        list.map((r) => [Number(r.t) * 1000, r.o, r.h, r.l, r.c, r.v]),
        0,
        4,
        5,
        false
      );
    });
  }
  return requestHosts(
    GATE,
    `/api/v4/spot/candlesticks?currency_pair=${inst.base}_USDT&interval=5m&limit=288`
  ).then((rows) => {
    const list = Array.isArray(rows) ? rows : [];
    return pointsFromOhlcv(
      list.map((r) => [Number(r[0]) * 1000, r[5], r[3], r[4], r[2], r[6]]),
      0,
      4,
      5,
      false
    );
  });
}

function fetchOkxKlines(inst) {
  return requestHosts(
    OKX,
    `/api/v5/market/candles?instId=${inst.okxInstId}&bar=5m&limit=288`
  ).then((json) => {
    const rows = json && json.data;
    if (!Array.isArray(rows)) return [];
    return pointsFromOhlcv(rows, 0, 4, 5, true);
  });
}

function fetchKlines(inst) {
  const needPoints = (p) =>
    p.then((points) => {
      if (!Array.isArray(points) || !points.length) throw new Error('empty klines');
      return points;
    });
  if (inst.kind === 'perp') {
    return firstSettled([
      needPoints(fetchGateKlines(inst)),
      needPoints(fetchBinanceKlines(inst)),
      needPoints(fetchOkxKlines(inst))
    ]);
  }
  return firstSettled([
    needPoints(fetchBinanceKlines(inst)),
    needPoints(fetchGateKlines(inst)),
    needPoints(fetchOkxKlines(inst))
  ]);
}

function fetchQuotes({ stocks, indexSpec }) {
  const wanted = (stocks || []).map(parseCryptoInstrument).filter(Boolean);
  const indexInst =
    parseCryptoInstrument((indexSpec && (indexSpec.secId || indexSpec.code)) || 'BTC') ||
    parseCryptoInstrument('BTC');
  const unique = [];
  const seen = new Set();
  [indexInst, ...wanted].forEach((inst) => {
    if (!inst || seen.has(inst.secId)) return;
    seen.add(inst.secId);
    unique.push(inst);
  });
  return Promise.all(
    unique.map((inst) =>
      fetchTicker(inst)
        .then((q) => ({ inst, q }))
        .catch(() => ({ inst, q: null }))
    )
  ).then((rows) => {
    const map = new Map();
    rows.forEach(({ inst, q }) => {
      if (q && Number.isFinite(Number(q.price)) && Number(q.price) > 0) {
        map.set(inst.secId, toQuote(inst, q.price, q.pct));
      }
    });
    return {
      quotes: wanted.map((inst) => {
        const hit = map.get(inst.secId);
        if (hit) return hit;
        return { ...missingQuote(inst.code, inst.secId, inst.name), kind: inst.kind, kindLabel: inst.kindName };
      }),
      index: map.get(indexInst.secId) || {
        code: indexInst.code,
        name: indexInst.name,
        price: '-',
        pct: null,
        secId: indexInst.secId
      }
    };
  });
}

function fetchTrends(secId) {
  const inst = parseCryptoInstrument(secId);
  if (!inst) {
    return Promise.reject(new Error('unknown crypto'));
  }
  return Promise.all([
    fetchTicker(inst).catch(() => null),
    fetchKlines(inst).catch(() => [])
  ]).then(([ticker, points]) => {
    const preClose = ticker && Number.isFinite(Number(ticker.preClose)) ? Number(ticker.preClose) : Number(points[0] && points[0].price);
    return {
      secId: inst.secId,
      name: inst.name,
      code: inst.code,
      preClose,
      points: points || []
    };
  });
}

module.exports = { id: 'crypto', fetchQuotes, fetchTrends };
