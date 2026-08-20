const { requestText, firstSettled } = require('../http');
const { toCnSecId, normalizeUsTicker } = require('../symbols');
const { missingQuote, isMissingQuote } = require('./placeholder');

const HOSTS = ['https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
const HEADERS = { Referer: 'https://quote.eastmoney.com/' };

function requestEastmoney(pathQuery) {
  return firstSettled(HOSTS.map((host) => requestText(host + pathQuery, HEADERS)));
}

function normalizeDiff(diff) {
  if (!diff) return [];
  if (Array.isArray(diff)) return diff;
  return Object.values(diff);
}

function toQuote(x, extras) {
  const market = Number(x.f13);
  const code = x.f12;
  const secId = Number.isFinite(market) ? `${market}.${code}` : String(code);
  return {
    code,
    name: x.f14,
    price: x.f2,
    pct: x.f3,
    secId,
    ...(extras || {})
  };
}

function isConfiguredIndex(x, spec) {
  const secId = spec && spec.secId;
  if (!secId || !x) return false;
  const i = String(secId).indexOf('.');
  if (i < 0) return false;
  const market = String(secId).slice(0, i);
  const code = String(secId).slice(i + 1);
  return String(x.f13) === market && String(x.f12).toUpperCase() === code.toUpperCase();
}

function indexQuote(item, spec) {
  if (!item) {
    return { code: spec.code, name: spec.name, price: '-', pct: null, secId: spec.secId };
  }
  return toQuote(item, { name: spec.name || item.f14, secId: spec.secId, code: spec.code });
}

function usMarketRank(x) {
  const m = Number(x.f13);
  if (m === 105) return 0;
  if (m === 106) return 1;
  if (m === 107) return 2;
  return 9;
}

function fetchCnQuotes(stocks, indexSpec) {
  const padded = stocks.map((c) => String(c).replace(/\D/g, '').padStart(6, '0'));
  const secids = [indexSpec.secId, ...padded.map(toCnSecId)].join(',');
  const pathQuery =
    '/api/qt/ulist.np/get?fltt=2' + `&fields=f12,f13,f14,f2,f3&secids=${secids}`;

  return requestEastmoney(pathQuery).then((raw) => {
    const json = JSON.parse(raw);
    const list = normalizeDiff(json?.data?.diff);
    const indexItem = list.find((x) => isConfiguredIndex(x, indexSpec));
    const map = new Map(
      list
        .filter((x) => !isConfiguredIndex(x, indexSpec))
        .map((x) => [String(x.f12).padStart(6, '0'), toQuote(x)])
    );
    return {
      quotes: padded.map((c) => {
        const q = map.get(c);
        if (!q || isMissingQuote(q)) return missingQuote(c, toCnSecId(c), q && q.name);
        return q;
      }),
      index: indexQuote(indexItem, indexSpec)
    };
  });
}

function fetchUsQuotes(stocks, indexSpec) {
  const tickers = [...new Set(stocks.map(normalizeUsTicker).filter(Boolean))];
  const secids = [
    indexSpec.secId,
    ...tickers.flatMap((t) => [`105.${t}`, `106.${t}`, `107.${t}`])
  ].join(',');
  const pathQuery =
    '/api/qt/ulist.np/get?fltt=2' + `&fields=f12,f13,f14,f2,f3&secids=${secids}`;

  return requestEastmoney(pathQuery).then((raw) => {
    const json = JSON.parse(raw);
    const list = normalizeDiff(json?.data?.diff);
    const indexItem = list.find((x) => isConfiguredIndex(x, indexSpec));
    const map = new Map();
    list
      .filter((x) => !isConfiguredIndex(x, indexSpec) && Number.isFinite(Number(x.f2)))
      .forEach((x) => {
        const ticker = String(x.f12 || '').toUpperCase();
        if (!ticker) return;
        const prev = map.get(ticker);
        if (!prev || usMarketRank(x) < usMarketRank(prev)) map.set(ticker, x);
      });
    return {
      quotes: tickers.map((t) => {
        const x = map.get(t);
        return x && Number.isFinite(Number(x.f2))
          ? toQuote(x, { code: t })
          : missingQuote(t, `105.${t}`);
      }),
      index: indexQuote(indexItem, indexSpec)
    };
  });
}

function parseTrendLine(line) {
  const p = String(line).split(',');
  return {
    time: (p[0] || '').slice(-5),
    price: Number(p[1]),
    avgHint: Number(p[7]),
    volume: Number(p[5])
  };
}

function parseTrends(lines) {
  const rows = (lines || [])
    .map(parseTrendLine)
    .filter((p) => p.time && Number.isFinite(p.price));
  if (!rows.length) return [];
  const first = rows[0];
  const useApiAvg =
    Number.isFinite(first.avgHint) &&
    Math.abs(first.avgHint - first.price) / Math.max(Math.abs(first.price), 1) < 0.001;
  let sumPV = 0;
  let sumV = 0;
  return rows.map((row) => {
    let avg;
    if (useApiAvg && Number.isFinite(row.avgHint)) {
      avg = row.avgHint;
    } else {
      const vol = Number.isFinite(row.volume) && row.volume > 0 ? row.volume : 1;
      sumPV += row.price * vol;
      sumV += vol;
      avg = sumV ? sumPV / sumV : row.price;
    }
    return { time: row.time, price: row.price, avg };
  });
}

function fetchQuotes({ market, stocks, indexSpec }) {
  return market === 'us' ? fetchUsQuotes(stocks, indexSpec) : fetchCnQuotes(stocks, indexSpec);
}

function fetchTrends(secId) {
  const pathQuery =
    '/api/qt/stock/trends2/get?' +
    `secid=${encodeURIComponent(secId)}&ndays=1&iscr=0&fltt=2` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
  return requestEastmoney(pathQuery).then((raw) => {
    const json = JSON.parse(raw);
    const d = json?.data || {};
    const points = parseTrends(d.trends);
    return {
      secId,
      name: d.name || '',
      code: d.code || '',
      preClose: Number(d.preClose),
      points
    };
  });
}

module.exports = { id: 'eastmoney', fetchQuotes, fetchTrends };
