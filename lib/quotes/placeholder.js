function missingQuote(code, secId, name) {
  return {
    code,
    name: name || String(code),
    price: '-',
    pct: null,
    secId,
    missing: true
  };
}

function isMissingQuote(q) {
  if (!q || q.missing) return true;
  if (q.price == null || q.price === '-') return true;
  return !Number.isFinite(Number(q.price));
}

module.exports = { missingQuote, isMissingQuote };
