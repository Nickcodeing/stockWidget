const { requestText, requestJson } = require('../http');
const {
  padCn,
  toCnSecId,
  normalizeUsTicker,
  cnSymbolFromCode,
  cnSymbolFromSecId,
  isUsSecId,
  usTickerFromSecId,
  tencentUsSymbol,
  nyTimeToBeijing,
  hhmm
} = require('../symbols');

const { missingQuote } = require('./placeholder');

const HEADERS = { Referer: 'https://gu.qq.com/' };

function quoteUrl(symbols) {
  return `https://qt.gtimg.cn/utf8/q=${encodeURI(symbols.join(','))}`;
}

function displayUsCode(raw) {
  return String(raw || '')
    .replace(/^\./, '')
    .split('.')[0]
    .toUpperCase();
}

function parseTencentBody(raw) {
  const map = new Map();
  String(raw)
    .split(';')
    .forEach((line) => {
      const m = line.match(/v_([^=]+)="([^"]*)"/);
      if (!m || !m[2]) return;
      const parts = m[2].split('~');
      map.set(m[1], {
        symbol: m[1],
        name: parts[1] || '',
        code: parts[2] || '',
        price: Number(parts[3]),
        prevClose: Number(parts[4]),
        pct: Number(parts[32])
      });
    });
  return map;
}

function emptyIndex(spec) {
  return { code: spec.code, name: spec.name, price: '-', pct: null, secId: spec.secId };
}

function fetchQuotes({ market, stocks, indexSpec }) {
  if (market === 'us') {
    const tickers = [...new Set(stocks.map(normalizeUsTicker).filter(Boolean))];
    const indexSym = tencentUsSymbol(indexSpec.code || usTickerFromSecId(indexSpec.secId));
    const symbols = [indexSym, ...tickers.map(tencentUsSymbol)];
    return requestText(quoteUrl(symbols), HEADERS).then((raw) => {
      const map = parseTencentBody(raw);
      const idx = map.get(indexSym);
      return {
        quotes: tickers.map((t) => {
          const q = map.get(tencentUsSymbol(t));
          if (!q || !Number.isFinite(q.price)) return missingQuote(t, `105.${t}`);
          return {
            code: t,
            name: q.name,
            price: q.price,
            pct: q.pct,
            secId: `105.${t}`
          };
        }),
        index: idx && Number.isFinite(idx.price)
          ? {
              code: indexSpec.code || displayUsCode(idx.code),
              name: indexSpec.name || idx.name,
              price: idx.price,
              pct: idx.pct,
              secId: indexSpec.secId
            }
          : emptyIndex(indexSpec)
      };
    });
  }

  const padded = stocks.map(padCn);
  const indexSym = cnSymbolFromSecId(indexSpec.secId);
  const symbols = [indexSym, ...padded.map(cnSymbolFromCode)];
  return requestText(quoteUrl(symbols), HEADERS).then((raw) => {
    const map = parseTencentBody(raw);
    const idx = map.get(indexSym);
    return {
      quotes: padded.map((c) => {
        const q = map.get(cnSymbolFromCode(c));
        if (!q || !Number.isFinite(q.price)) return missingQuote(c, toCnSecId(c));
        return {
          code: c,
          name: q.name,
          price: q.price,
          pct: q.pct,
          secId: toCnSecId(c)
        };
      }),
      index: idx && Number.isFinite(idx.price)
        ? {
            code: indexSpec.code || padCn(idx.code),
            name: indexSpec.name || idx.name,
            price: idx.price,
            pct: idx.pct,
            secId: indexSpec.secId
          }
        : emptyIndex(indexSpec)
    };
  });
}

function parseMinutePoints(rows, us) {
  return (rows || [])
    .map((line) => {
      const p = String(line).trim().split(/\s+/);
      const clock = us ? nyTimeToBeijing(p[0]) : hhmm(p[0]);
      return { time: clock, price: Number(p[1]), avg: NaN };
    })
    .filter((p) => p.time && Number.isFinite(p.price));
}

function minutePreClose(payload, symbol) {
  const qt = payload && payload.qt;
  if (!qt) return NaN;
  const row = qt[symbol] || qt[`v_${symbol}`];
  const prev = Number(Array.isArray(row) ? row[4] : NaN);
  return prev;
}

function fetchTrends(secId) {
  const us = isUsSecId(secId);
  const symbol = us
    ? tencentUsSymbol(usTickerFromSecId(secId))
    : cnSymbolFromSecId(secId);
  const url = us
    ? `https://web.ifzq.gtimg.cn/appstock/app/UsMinute/query?code=${encodeURIComponent(symbol)}`
    : `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(symbol)}`;

  return requestJson(url, HEADERS).then((json) => {
    const payload = json?.data?.[symbol] || {};
    const rows = payload?.data?.data || [];
    const name = Array.isArray(payload?.qt?.[symbol]) ? payload.qt[symbol][1] : '';
    const code = us ? usTickerFromSecId(secId) : padCn(splitCode(secId));
    return {
      secId,
      name: name || '',
      code,
      preClose: minutePreClose(payload, symbol),
      points: parseMinutePoints(rows, us)
    };
  });
}

function splitCode(secId) {
  const i = String(secId).indexOf('.');
  return i < 0 ? secId : String(secId).slice(i + 1);
}

module.exports = { id: 'tencent', fetchQuotes, fetchTrends };
