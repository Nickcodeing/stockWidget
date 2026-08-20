function padCn(code) {
  return String(code || '')
    .replace(/\D/g, '')
    .padStart(6, '0');
}

function toCnSecId(code) {
  const c = padCn(code);
  return `${c.startsWith('6') ? '1' : '0'}.${c}`;
}

function normalizeUsTicker(code) {
  return String(code || '')
    .trim()
    .replace(/^\$/, '')
    .toUpperCase();
}

function splitSecId(secId) {
  const s = String(secId || '');
  const i = s.indexOf('.');
  if (i < 0) return { marketKey: '', code: s };
  return { marketKey: s.slice(0, i), code: s.slice(i + 1) };
}

function isUsSecId(secId) {
  const { marketKey } = splitSecId(secId);
  return marketKey === 'us' || marketKey === '100' || marketKey === '105' || marketKey === '106' || marketKey === '107';
}

function cnSymbolFromSecId(secId) {
  const { marketKey, code } = splitSecId(secId);
  const c = padCn(code);
  if (marketKey === '1') return `sh${c}`;
  if (marketKey === '0') return `sz${c}`;
  if (marketKey === '2' || c.startsWith('8') || c.startsWith('4')) return `bj${c}`;
  return `${c.startsWith('6') ? 'sh' : 'sz'}${c}`;
}

function cnSymbolFromCode(code) {
  return cnSymbolFromSecId(toCnSecId(code));
}

function usTickerFromSecId(secId) {
  const { code } = splitSecId(secId);
  return normalizeUsTicker(String(code).replace(/^\./, ''));
}

function tencentUsSymbol(ticker) {
  const t = normalizeUsTicker(ticker).replace(/^\./, '');
  return `us${t}`;
}

function sinaUsSymbol(ticker) {
  const t = normalizeUsTicker(ticker).replace(/^\./, '').toLowerCase();
  return `gb_${t}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isNewYorkDst(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short'
  }).formatToParts(date || new Date());
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
  return name.includes('DT');
}

function nyTimeToBeijing(time) {
  const raw = String(time || '').replace(':', '');
  if (raw.length < 3) return String(time || '');
  const hh = Number(raw.length === 3 ? raw.slice(0, 1) : raw.slice(0, 2));
  const mm = Number(raw.slice(-2));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return String(time || '');
  const add = isNewYorkDst() ? 12 : 13;
  let total = (((hh * 60 + mm + add * 60) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function hhmm(raw) {
  const s = String(raw || '').trim();
  const clock = s.match(/(\d{1,2}):(\d{2})/);
  if (clock) return `${pad2(clock[1])}:${clock[2]}`;
  const d = s.replace(/\D/g, '');
  if (d.length >= 6) return `${d.slice(0, 2)}:${d.slice(2, 4)}`;
  if (d.length === 4) return `${d.slice(0, 2)}:${d.slice(2)}`;
  if (d.length === 3) return `${pad2(d.slice(0, 1))}:${d.slice(1)}`;
  return '';
}

module.exports = {
  padCn,
  toCnSecId,
  normalizeUsTicker,
  splitSecId,
  isUsSecId,
  cnSymbolFromSecId,
  cnSymbolFromCode,
  usTickerFromSecId,
  tencentUsSymbol,
  sinaUsSymbol,
  nyTimeToBeijing,
  hhmm
};
