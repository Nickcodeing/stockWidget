const { requestText, requestJson } = require('../http');
const {
  padCn,
  toCnSecId,
  normalizeUsTicker,
  cnSymbolFromCode,
  cnSymbolFromSecId,
  isUsSecId,
  usTickerFromSecId,
  sinaUsSymbol,
  hhmm
} = require('../symbols');
const { missingQuote } = require('./placeholder');

const HEADERS = { Referer: 'https://finance.sina.com.cn' };

function quoteUrl(symbols) {
  return `https://hq.sinajs.cn/list=${encodeURI(symbols.join(','))}`;
}

function parseSinaBody(raw) {
  const map = new Map();
  String(raw).split(';').forEach((line) => {
    const m = line.match(/hq_str_([^=]+)="([^"]*)"/);
    if (!m || !m[2]) return;
    map.set(m[1], m[2].split(','));
  });
  return map;
}

function emptyIndex(spec) {
  return { code: spec.code, name: spec.name, price: '-', pct: null, secId: spec.secId };
}

function parseCnFields(fields) {
  const prev = Number(fields[2]);
  const price = Number(fields[3]);
  const pct = Number.isFinite(price) && Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : NaN;
  return { name: fields[0] || '', price, prev, pct };
}

function parseUsFields(fields) {
  return {
    name: fields[0] || '',
    price: Number(fields[1]),
    pct: Number(fields[2]),
    prev: Number(fields[1]) - Number(fields[4])
  };
}

function fetchQuotes({ market, stocks, indexSpec }) {
  if (market === 'us') {
    const tickers = [...new Set(stocks.map(normalizeUsTicker).filter(Boolean))];
    const indexSym = sinaUsSymbol(indexSpec.code || usTickerFromSecId(indexSpec.secId));
    const symbols = [indexSym, ...tickers.map(sinaUsSymbol)];
    return requestText(quoteUrl(symbols), HEADERS, 'gbk').then((raw) => {
      const map = parseSinaBody(raw);
      const idx = map.get(indexSym);
      const idxQ = idx ? parseUsFields(idx) : null;
      return {
        quotes: tickers.map((t) => {
          const fields = map.get(sinaUsSymbol(t));
          if (!fields) return missingQuote(t, `105.${t}`);
          const q = parseUsFields(fields);
          if (!Number.isFinite(q.price)) return missingQuote(t, `105.${t}`, q.name);
          return {
            code: t,
            name: q.name,
            price: q.price,
            pct: q.pct,
            secId: `105.${t}`
          };
        }),
        index: idxQ && Number.isFinite(idxQ.price)
          ? {
              code: indexSpec.code,
              name: indexSpec.name || idxQ.name,
              price: idxQ.price,
              pct: idxQ.pct,
              secId: indexSpec.secId
            }
          : emptyIndex(indexSpec)
      };
    });
  }

  const padded = stocks.map(padCn);
  const indexSym = cnSymbolFromSecId(indexSpec.secId);
  const symbols = [indexSym, ...padded.map(cnSymbolFromCode)];
  return requestText(quoteUrl(symbols), HEADERS, 'gbk').then((raw) => {
    const map = parseSinaBody(raw);
    const idx = map.get(indexSym);
    const idxQ = idx ? parseCnFields(idx) : null;
    return {
      quotes: padded.map((c) => {
        const fields = map.get(cnSymbolFromCode(c));
        if (!fields) return missingQuote(c, toCnSecId(c));
        const q = parseCnFields(fields);
        if (!Number.isFinite(q.price)) return missingQuote(c, toCnSecId(c), q.name);
        return {
          code: c,
          name: q.name,
          price: q.price,
          pct: q.pct,
          secId: toCnSecId(c)
        };
      }),
      index: idxQ && Number.isFinite(idxQ.price)
        ? {
            code: indexSpec.code,
            name: indexSpec.name || idxQ.name,
            price: idxQ.price,
            pct: idxQ.pct,
            secId: indexSpec.secId
          }
        : emptyIndex(indexSpec)
    };
  });
}

function fetchCnTrends(secId) {
  const symbol = cnSymbolFromSecId(secId);
  const url = `https://cn.finance.sina.com.cn/minline/getMinlineData?symbol=${encodeURIComponent(symbol)}`;
  return Promise.all([
    requestJson(url, HEADERS),
    requestText(quoteUrl([symbol]), HEADERS, 'gbk')
  ]).then(([json, hq]) => {
    const map = parseSinaBody(hq);
    const q = map.get(symbol) ? parseCnFields(map.get(symbol)) : {};
    const rows = json?.result?.data;
    const points = Array.isArray(rows)
      ? rows
          .map((row) => ({
            time: hhmm(row.m),
            price: Number(row.p),
            avg: Number(row.avg_p)
          }))
          .filter((p) => p.time && Number.isFinite(p.price))
      : [];
    return {
      secId,
      name: q.name || '',
      code: padCn(secId.slice(secId.indexOf('.') + 1)),
      preClose: Number(q.prev),
      points
    };
  });
}

function emptyTrends(secId) {
  return {
    secId,
    name: '',
    code: isUsSecId(secId) ? usTickerFromSecId(secId) : padCn(secId.slice(String(secId).indexOf('.') + 1)),
    preClose: NaN,
    points: []
  };
}

function fetchTrends(secId) {
  if (isUsSecId(secId)) {
    return Promise.resolve(emptyTrends(secId));
  }
  return fetchCnTrends(secId).catch(() => emptyTrends(secId));
}

module.exports = { id: 'sina', fetchQuotes, fetchTrends };
