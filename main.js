const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen,
  Notification
} = require('electron');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  console.error('[stock-widget] uncaught:', err);
});

const {
  QUOTE_PROVIDERS,
  normalizeProviderId,
  getQuoteProvider,
  providerMeta
} = require('./lib/quotes');
const cryptoQuotes = require('./lib/quotes/crypto');
const { parseCryptoInstrument } = require('./lib/symbols');
const FAIL_SWITCH_HINT = 3;

let win;
let tray;
let trayBlinkTimer = null;
let trayBlinkLit = true;
let trayIdleIcon = null;
let trayFlashIcon = null;
let config;
let refreshTimer;
let watchTimer;
let watchFetching = false;
let marketWasOpen = false;
const ALL_MARKETS = ['cn', 'us', 'crypto'];
const CLOSED_WAKE_MS = 60 * 1000;
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
let clickThroughEnabled = false;
let userPrefClickThrough = false;
let pointerOver = false;
let pointerPoll = null;
let fetching = false;
let lastPayload = null;
let lastTrends = null;
let savePosTimer = null;
let pendingFocusIndex;
let quoteGen = 0;
let failCount = 0;
let fileWatchers = [];
const alertLatch = new Map();
const recentTicks = new Map();
let lastMoveNotice = null;
const ALERT_KEEP = 80;
let alertLog = [];
const TICK_KEEP_MS = 75 * 60 * 1000;
const TICK_MAX = 960;
const ALERT_HOT_MS = 50 * 1000;
const SAME_DIR_COOLDOWN_MS = 4 * 60 * 1000;
const GRIND_COOLDOWN_MS = 12 * 60 * 1000;
const REV_COOLDOWN_MS = 90 * 1000;
const REFIRE_EXTRA = 1.15;
const ALERT_SCORE_MIN = 1.15;
const SESSION_GAP_MAX_MS = 24 * 60 * 60 * 1000;

const WINDOW_WIDTH = 368;
const WINDOW_HEIGHT = 292;
const DEFAULT_POSITION = { x: 1569, y: 748 };
const DEFAULT_CN_INDEX = { secId: '1.000001', name: '上证指数' };
const DEFAULT_US_INDEX = { secId: '100.NDX100', name: '纳斯达克100' };
const DEFAULT_CRYPTO_INDEX = { secId: 'crypto.BTC.spot', name: '比特币', code: 'BTC' };
const DEFAULT_CRYPTO_STOCKS = [
  { code: 'BTC', cost: 0 },
  { code: 'BTC-PERP', cost: 0 },
  { code: 'ETH', cost: 0 },
  { code: 'ETH-PERP', cost: 0 }
];
let selectedSecId = DEFAULT_CN_INDEX.secId;

function positionPath() {
  return path.join(__dirname, 'position.json');
}

function clampPosition(x, y, width, height) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(y, area.y), Math.max(area.y, maxY)))
  };
}

function loadPosition() {
  try {
    const raw = JSON.parse(fs.readFileSync(positionPath(), 'utf-8'));
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return clampPosition(raw.x, raw.y, WINDOW_WIDTH, WINDOW_HEIGHT);
    }
  } catch (_) {
    /* use default */
  }
  return clampPosition(DEFAULT_POSITION.x, DEFAULT_POSITION.y, WINDOW_WIDTH, WINDOW_HEIGHT);
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  try {
    fs.writeFileSync(positionPath(), JSON.stringify({ x, y }, null, 2));
  } catch (err) {
    console.error('[stock-widget] save position error:', err);
  }
}

function scheduleSavePosition() {
  clearTimeout(savePosTimer);
  savePosTimer = setTimeout(savePosition, 200);
}

function configPath() {
  return path.join(__dirname, 'stocks.json');
}

function alertsPath() {
  return path.join(__dirname, 'alerts.json');
}

function exampleConfigPath() {
  return path.join(__dirname, 'stocks.example.json');
}

function defaultConfig() {
  return {
    refreshIntervalMs: 5000,
    opacity: 0.88,
    clickThrough: false,
    theme: 'sun',
    market: 'cn',
    cnIndex: { secId: '1.000001', name: '上证指数' },
    usIndex: { secId: '100.NDX100', name: '纳斯达克100' },
    cryptoIndex: { secId: 'crypto.BTC.spot', name: '比特币' },
    stocks: [],
    usStocks: [],
    cryptoStocks: DEFAULT_CRYPTO_STOCKS.map((item) => ({ ...item })),
    quoteProvider: 'eastmoney',
    alertSensitivity: 1
  };
}

function ensureConfigFile() {
  const dest = configPath();
  if (fs.existsSync(dest)) return;
  const example = exampleConfigPath();
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, dest);
    return;
  }
  fs.writeFileSync(dest, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
}

function normalizeMarket(market) {
  if (market === 'us' || market === 'crypto') return market;
  return 'cn';
}

function currentMarket() {
  return normalizeMarket(config && config.market);
}

function marketListKey(market) {
  const m = normalizeMarket(market);
  if (m === 'us') return 'usStocks';
  if (m === 'crypto') return 'cryptoStocks';
  return 'stocks';
}

function parseIndexSpec(raw, fallback) {
  const codeFrom = (secId) => String(secId).slice(String(secId).indexOf('.') + 1);
  if (typeof raw === 'string' && raw.includes('.')) {
    const secId = raw.trim();
    return {
      secId,
      name: secId === fallback.secId ? fallback.name : '',
      code: codeFrom(secId)
    };
  }
  if (raw && typeof raw === 'object' && raw.secId) {
    const secId = String(raw.secId).trim();
    const custom = raw.name != null && String(raw.name).trim() !== '';
    return {
      secId,
      name: custom ? String(raw.name).trim() : (secId === fallback.secId ? fallback.name : ''),
      code: codeFrom(secId)
    };
  }
  return { secId: fallback.secId, name: fallback.name, code: codeFrom(fallback.secId) };
}

function indexSpecFor(market) {
  const m = normalizeMarket(market);
  if (m === 'us') return parseIndexSpec(config.usIndex, DEFAULT_US_INDEX);
  if (m === 'crypto') {
    const spec = parseIndexSpec(config.cryptoIndex, DEFAULT_CRYPTO_INDEX);
    const inst = parseCryptoInstrument(spec.secId || spec.code || 'BTC');
    if (!inst) return spec;
    return {
      secId: inst.secId,
      name: spec.name || inst.name,
      code: inst.kind === 'perp' ? inst.code : inst.base
    };
  }
  return parseIndexSpec(config.cnIndex, DEFAULT_CN_INDEX);
}

function currentIndex() {
  return indexSpecFor(currentMarket());
}

function marketLabel(market) {
  const m = normalizeMarket(market);
  if (m === 'us') return '美股';
  if (m === 'crypto') return '加密';
  return 'A股';
}

function indexSecId() {
  return currentIndex().secId;
}

function stocksForMarket(market) {
  const key = marketListKey(market);
  return Array.isArray(config[key]) ? config[key] : [];
}

function currentStocks() {
  return stocksForMarket(currentMarket());
}

function watchedItems(market) {
  return stocksForMarket(market).filter((item) => item && item.watch);
}

function currentStockCodes() {
  return currentStocks().map((item) => item.code);
}

function normalizeUsTicker(code) {
  return String(code || '')
    .trim()
    .replace(/^\$/, '')
    .toUpperCase();
}

function parseCostNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseLeverage(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(125, Math.round(n * 10) / 10);
}

function parseSide(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (['sell', 'short', '空', '卖', '卖出', '做空'].includes(s)) return 'sell';
  if (['buy', 'long', '多', '买', '买入', '做多'].includes(s)) return 'buy';
  return '';
}

function quoteAlertGear(q) {
  const lev = parseLeverage(q && q.leverage);
  return {
    lev: lev >= 1 ? lev : 1,
    sign: parseSide(q && q.side) === 'sell' ? -1 : 1,
    side: parseSide(q && q.side)
  };
}

function formatAlertGear(item) {
  const lev = parseLeverage(item && item.leverage);
  if (!(lev >= 1) || lev === 1) return '';
  const side = parseSide(item && item.side);
  const sideText = side === 'sell' ? '空' : side === 'buy' ? '多' : '';
  return `${lev}x${sideText} `;
}

function parseWatch(raw) {
  return raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true';
}

function parseAlertSensitivity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(2.5, Math.max(0.5, Math.round(n * 100) / 100));
}

function sanitizeConfigText(text) {
  let s = String(text || '').replace(/^\uFEFF/, '');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  s = s.replace(/:\s*(-?)0+(\d+(?:\.\d+)?)\b/g, (_, sign, rest) => `: ${sign}${Number(rest)}`);
  return s;
}

function tryParseJson(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function readConfigObject() {
  const text = fs.readFileSync(configPath(), 'utf-8');
  return tryParseJson(text) || tryParseJson(sanitizeConfigText(text));
}

function parseStockEntry(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { code: String(raw.code ?? '').trim(), cost: parseCostNumber(raw.cost) };
  }
  const s = String(raw ?? '').trim();
  const i = s.lastIndexOf(':');
  if (i > 0) {
    return { code: s.slice(0, i).trim(), cost: parseCostNumber(s.slice(i + 1)) };
  }
  return { code: s, cost: 0 };
}

function normalizeStockEntry(item, us) {
  const parsed = parseStockEntry(item);
  const code = us
    ? normalizeUsTicker(parsed.code)
    : String(parsed.code).replace(/\D/g, '').padStart(6, '0');
  if (!code || (!us && code === '000000')) return null;
  const out = { code, cost: parsed.cost };
  if (item && typeof item === 'object' && !Array.isArray(item) && parseWatch(item.watch)) {
    out.watch = true;
  }
  return out;
}

function normalizeCryptoEntry(item) {
  const parsed = parseStockEntry(item);
  const inst = parseCryptoInstrument(parsed.code);
  if (!inst) return null;
  const out = { code: inst.code, cost: parsed.cost };
  if (item && typeof item === 'object' && !Array.isArray(item) && parseWatch(item.watch)) {
    out.watch = true;
  }
  if (inst.kind === 'perp' && item && typeof item === 'object' && !Array.isArray(item)) {
    const lev = parseLeverage(item.leverage);
    const side = parseSide(item.side);
    if (lev > 0) out.leverage = lev;
    if (side) out.side = side;
  }
  return out;
}

function serializeStockEntry(item) {
  const out = {
    code: item && item.code ? item.code : '',
    cost: parseCostNumber(item && item.cost)
  };
  if (item && item.watch) out.watch = true;
  return out;
}

function serializeCryptoEntry(item) {
  const out = serializeStockEntry(item);
  const inst = parseCryptoInstrument(out.code);
  if (inst && inst.kind === 'perp') {
    const lev = parseLeverage(item && item.leverage);
    const side = parseSide(item && item.side);
    if (lev > 0) out.leverage = lev;
    if (side) out.side = side;
  }
  return out;
}

function normalizeStockLists() {
  config.stocks = (Array.isArray(config.stocks) ? config.stocks : [])
    .map((item) => normalizeStockEntry(item, false))
    .filter(Boolean);
  config.usStocks = (Array.isArray(config.usStocks) ? config.usStocks : [])
    .map((item) => normalizeStockEntry(item, true))
    .filter(Boolean);
  if (!Array.isArray(config.cryptoStocks)) {
    config.cryptoStocks = DEFAULT_CRYPTO_STOCKS.map((item) => ({ ...item }));
  } else {
    config.cryptoStocks = config.cryptoStocks.map(normalizeCryptoEntry).filter(Boolean);
  }
}

function quoteCostKey(code, market) {
  const m = normalizeMarket(market || currentMarket());
  if (m === 'us') return normalizeUsTicker(code);
  if (m === 'crypto') {
    const inst = parseCryptoInstrument(code);
    return inst ? inst.code : String(code || '').toUpperCase();
  }
  return String(code || '').replace(/\D/g, '').padStart(6, '0');
}

function attachPositions(quotes, market) {
  const m = normalizeMarket(market || currentMarket());
  const pos = new Map();
  stocksForMarket(m).forEach((item) => {
    if (!item || !item.code) return;
    pos.set(quoteCostKey(item.code, m), item);
  });
  return (quotes || []).map((q) => {
    const next = { ...q };
    delete next.watch;
    delete next.cost;
    delete next.leverage;
    delete next.side;
    const item = pos.get(quoteCostKey(q && q.code, m));
    if (!item) return next;
    if (item.cost > 0) next.cost = item.cost;
    if (item.leverage > 0) next.leverage = item.leverage;
    if (item.side) next.side = item.side;
    if (item.watch) next.watch = true;
    return next;
  });
}

function applyLoadedConfig(data) {
  config = { ...defaultConfig(), ...(data && typeof data === 'object' ? data : {}) };
  userPrefClickThrough = config.clickThrough === true;
  if (config.theme !== 'moon') config.theme = 'sun';
  config.market = normalizeMarket(config.market);
  if (!Array.isArray(config.stocks)) config.stocks = [];
  if (!Array.isArray(config.usStocks)) config.usStocks = [];
  try {
    normalizeStockLists();
  } catch (_) {
    config.stocks = [];
    config.usStocks = [];
    config.cryptoStocks = DEFAULT_CRYPTO_STOCKS.map((item) => ({ ...item }));
  }
  config.quoteProvider = normalizeProviderId(config.quoteProvider);
  config.alertSensitivity = parseAlertSensitivity(config.alertSensitivity);
  return config;
}

function loadConfig() {
  try {
    ensureConfigFile();
    const data = readConfigObject();
    if (data) return applyLoadedConfig(data);
  } catch (err) {
    console.error('[stock-widget] config error:', err.message || err);
  }
  return applyLoadedConfig(defaultConfig());
}

function saveConfig() {
  const out = {
    ...config,
    stocks: (Array.isArray(config.stocks) ? config.stocks : []).map(serializeStockEntry),
    usStocks: (Array.isArray(config.usStocks) ? config.usStocks : []).map(serializeStockEntry),
    cryptoStocks: (Array.isArray(config.cryptoStocks) ? config.cryptoStocks : []).map(serializeCryptoEntry)
  };
  fs.writeFileSync(configPath(), `${JSON.stringify(out, null, 2)}\n`);
}

function stockIndex(code) {
  const list = currentStocks();
  const market = currentMarket();
  if (market === 'us') {
    const ticker = normalizeUsTicker(code);
    return list.findIndex((c) => normalizeUsTicker(c.code) === ticker);
  }
  if (market === 'crypto') {
    const want = quoteCostKey(code);
    return list.findIndex((c) => quoteCostKey(c.code) === want);
  }
  const padded = String(code || '')
    .replace(/\D/g, '')
    .padStart(6, '0');
  return list.findIndex((c) => String(c.code).replace(/\D/g, '').padStart(6, '0') === padded);
}

function reorderStock(code, action) {
  loadConfig();
  const key = marketListKey(currentMarket());
  const list = currentStocks();
  const i = stockIndex(code);
  if (i < 0 || !Array.isArray(list)) return;
  const item = list[i];
  if (action === 'top' && i > 0) {
    list.splice(i, 1);
    list.unshift(item);
  } else if (action === 'up' && i > 0) {
    const prev = list[i - 1];
    list[i - 1] = item;
    list[i] = prev;
  } else if (action === 'down' && i < list.length - 1) {
    const next = list[i + 1];
    list[i + 1] = item;
    list[i] = next;
  } else {
    return;
  }
  config[key] = list;
  saveConfig();
  pendingFocusIndex = stockIndex(code);
  refreshQuotes();
}

function currentProvider() {
  return providerMeta(config && config.quoteProvider);
}

function fetchQuotesForMarket(market, codes) {
  const m = normalizeMarket(market);
  const args = {
    market: m,
    stocks: codes || [],
    indexSpec: indexSpecFor(m)
  };
  if (m === 'crypto') return cryptoQuotes.fetchQuotes(args);
  return getQuoteProvider(currentProvider().id).fetchQuotes(args);
}

function fetchQuotes() {
  return fetchQuotesForMarket(currentMarket(), currentStockCodes());
}

function fetchTrends(secId) {
  if (currentMarket() === 'crypto') return cryptoQuotes.fetchTrends(secId);
  return getQuoteProvider(currentProvider().id).fetchTrends(secId);
}

function hasQuoteData(data) {
  if (!data) return false;
  const price = Number(data.index && data.index.price);
  const indexOk = Number.isFinite(price) && price > 0;
  const quotesOk =
    Array.isArray(data.quotes) && data.quotes.some((q) => Number.isFinite(Number(q.price)) && Number(q.price) > 0);
  return indexOk || quotesOk;
}

function emptyIndexPayload() {
  const spec = currentIndex();
  return { code: spec.code, name: spec.name, price: '-', pct: null, secId: spec.secId };
}

function quoteMeta(suggestSwitch) {
  if (currentMarket() === 'crypto') {
    return {
      quoteProvider: 'crypto',
      quoteProviderLabel: '币安 / Gate / OKX',
      quoteProviderShort: '多源',
      suggestSwitch: false
    };
  }
  const provider = currentProvider();
  return {
    quoteProvider: provider.id,
    quoteProviderLabel: provider.label,
    quoteProviderShort: provider.short,
    suggestSwitch: !!suggestSwitch
  };
}

function pushQuotesToRenderer() {
  if (!lastPayload || !win || win.isDestroyed()) return;
  win.webContents.send('quotes-update', lastPayload);
}

function sendQuotes(payload) {
  if (Number.isFinite(pendingFocusIndex)) {
    payload.focusIndex = pendingFocusIndex;
    pendingFocusIndex = undefined;
  }
  lastPayload = { ...payload };
  delete lastPayload.alerts;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('quotes-update', payload);
}

function alertKey(code, market) {
  const m = normalizeMarket(market || currentMarket());
  return `${m}:${quoteCostKey(code, m)}`;
}

function formatAlertPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '--';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function formatAlertSpan(ms) {
  const s = Math.max(1, Math.round(Number(ms) / 1000));
  if (s < 90) return `${s}秒`;
  if (s >= 50 * 60) {
    const h = Math.max(1, Math.round(s / 3600));
    return `${h}小时`;
  }
  const m = Math.max(1, Math.round(s / 60));
  return `${m}分钟`;
}

function alertDirLabel(dir, grind) {
  if (grind) return dir === 'down' ? '持续下挫' : '持续拉升';
  return dir === 'down' ? '突然下挫' : '突然拉升';
}

function medianNum(nums) {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function marketAlertProfile(market) {
  const scale = parseAlertSensitivity(config && config.alertSensitivity);
  if (normalizeMarket(market || currentMarket()) === 'crypto') {
    return {
      windows: [
        { ms: 60 * 1000, minPct: 2.4 * scale },
        { ms: 3 * 60 * 1000, minPct: 4 * scale },
        { ms: 8 * 60 * 1000, minPct: 6 * scale }
      ],
      grinds: [
        { ms: 15 * 60 * 1000, minPct: 5.5 * scale },
        { ms: 30 * 60 * 1000, minPct: 8 * scale },
        { ms: 60 * 60 * 1000, minPct: 12 * scale }
      ],
      floorPct: 1.6 * scale,
      gapMs: 90 * 1000,
      gapMinPct: 4 * scale,
      typicalPct: 0.12
    };
  }
  return {
    windows: [
      { ms: 60 * 1000, minPct: 1 * scale },
      { ms: 3 * 60 * 1000, minPct: 1.8 * scale },
      { ms: 8 * 60 * 1000, minPct: 2.8 * scale }
    ],
    grinds: [
      { ms: 20 * 60 * 1000, minPct: 2.4 * scale },
      { ms: 45 * 60 * 1000, minPct: 3.8 * scale }
    ],
    floorPct: 0.8 * scale,
    gapMs: 90 * 1000,
    gapMinPct: 2.5 * scale,
    typicalPct: 0.08
  };
}

function pushTick(key, price) {
  const now = Date.now();
  const arr = recentTicks.get(key) || [];
  const last = arr[arr.length - 1];
  if (last && now - last.t < 900 && Math.abs(last.price - price) / last.price < 0.00008) {
    last.t = now;
    recentTicks.set(key, arr);
    return arr;
  }
  arr.push({ t: now, price });
  const cutoff = now - TICK_KEEP_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
  if (arr.length > TICK_MAX) arr.splice(0, arr.length - TICK_MAX);
  recentTicks.set(key, arr);
  return arr;
}

function typicalTickPct(ticks) {
  const rets = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const dt = ticks[i].t - ticks[i - 1].t;
    if (dt < 400 || dt > 20000) continue;
    const prev = ticks[i - 1].price;
    if (!(prev > 0)) continue;
    rets.push(Math.abs((ticks[i].price - prev) / prev) * 100);
  }
  if (rets.length < 3) return null;
  return medianNum(rets);
}

function windowMove(ticks, windowMs, now) {
  if (!ticks || ticks.length < 2) return null;
  const last = ticks[ticks.length - 1];
  const from = now - windowMs;
  let then = null;
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    if (ticks[i].t <= from) {
      then = ticks[i];
      break;
    }
  }
  if (!then) {
    then = ticks[0];
    if (last.t - then.t < Math.min(8000, windowMs * 0.4)) return null;
  }
  if (last.t - then.t < 2500) return null;
  if (last.t - then.t > windowMs + 20000) return null;
  if (!(then.price > 0) || !(last.price > 0)) return null;
  return {
    movePct: ((last.price - then.price) / then.price) * 100,
    spanMs: last.t - then.t,
    fromPrice: then.price
  };
}

function detectSuddenMove(ticks, profile, lev) {
  if (!ticks || ticks.length < 2) return null;
  const scale = Number(lev);
  const gear = Number.isFinite(scale) && scale >= 1 ? scale : 1;
  const now = Date.now();
  const last = ticks[ticks.length - 1];
  const prev = ticks[ticks.length - 2];
  const gap = last.t - prev.t;
  if (
    gap > profile.gapMs &&
    gap < SESSION_GAP_MAX_MS &&
    prev.price > 0 &&
    last.price > 0
  ) {
    const movePct = ((last.price - prev.price) / prev.price) * 100 * gear;
    if (Math.abs(movePct) >= profile.gapMinPct) {
      return {
        movePct,
        spanMs: gap,
        needPct: profile.gapMinPct,
        gap: true
      };
    }
  }

  const typical = typicalTickPct(ticks);
  const typicalPrice = typical != null ? typical : (Number(profile.typicalPct) || 0.1);
  const typicalAcc = typicalPrice * gear;
  let best = null;
  profile.windows.forEach((winCfg) => {
    const found = windowMove(ticks, winCfg.ms, now);
    if (!found) return;
    const dyn = typicalAcc * 4.2 * Math.sqrt(Math.max(1, winCfg.ms / 5000));
    const needPct = Math.max(winCfg.minPct, dyn, profile.floorPct);
    const movePct = found.movePct * gear;
    const abs = Math.abs(movePct);
    if (abs < needPct) return;
    const score = abs / needPct;
    if (score < ALERT_SCORE_MIN) return;
    if (!best || score > best.score || (score === best.score && found.spanMs < best.spanMs)) {
      best = { ...found, movePct, needPct, score };
    }
  });
  return best;
}

function ticksInWindow(ticks, windowMs, now) {
  if (!ticks || ticks.length < 8) return null;
  const last = ticks[ticks.length - 1];
  const from = (Number.isFinite(now) ? now : last.t) - windowMs;
  let startIdx = -1;
  for (let i = 0; i < ticks.length; i += 1) {
    if (ticks[i].t >= from) {
      startIdx = i > 0 ? i - 1 : i;
      break;
    }
  }
  if (startIdx < 0) return null;
  if (ticks[startIdx].t > from + windowMs * 0.28) return null;
  const slice = ticks.slice(startIdx);
  const span = last.t - slice[0].t;
  if (span < windowMs * 0.72) return null;
  return slice;
}

function grindQuality(slice) {
  if (!slice || slice.length < 8) return null;
  const start = slice[0].price;
  const end = slice[slice.length - 1].price;
  if (!(start > 0) || !(end > 0)) return null;
  const net = ((end - start) / start) * 100;
  if (!Number.isFinite(net) || Math.abs(net) < 1e-8) return null;
  let aligned = 0;
  let withNet = 0;
  let steps = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const price = slice[i].price;
    if (!(price > 0)) continue;
    const d = price - start;
    if ((net > 0 && d >= 0) || (net < 0 && d <= 0)) aligned += 1;
    const step = price - slice[i - 1].price;
    if (!step) continue;
    steps += 1;
    if ((net > 0 && step > 0) || (net < 0 && step < 0)) withNet += 1;
  }
  const alignRatio = aligned / Math.max(1, slice.length - 1);
  const stepRatio = steps ? withNet / steps : 0;
  if (alignRatio < 0.68 || stepRatio < 0.55) return null;
  return {
    movePct: net,
    spanMs: slice[slice.length - 1].t - slice[0].t
  };
}

function detectGrindMove(ticks, profile, lev) {
  const grinds = profile && profile.grinds;
  if (!ticks || ticks.length < 8 || !Array.isArray(grinds) || !grinds.length) return null;
  const scale = Number(lev);
  const gear = Number.isFinite(scale) && scale >= 1 ? scale : 1;
  const now = Date.now();
  const typical = typicalTickPct(ticks);
  const typicalPrice = typical != null ? typical : (Number(profile.typicalPct) || 0.1);
  const typicalAcc = typicalPrice * gear;
  let best = null;
  grinds.forEach((winCfg) => {
    const slice = ticksInWindow(ticks, winCfg.ms, now);
    if (!slice) return;
    const found = grindQuality(slice);
    if (!found) return;
    const dyn = typicalAcc * 2.8;
    const needPct = Math.max(winCfg.minPct, dyn, profile.floorPct);
    const movePct = found.movePct * gear;
    const abs = Math.abs(movePct);
    if (abs < needPct) return;
    const score = abs / needPct;
    if (score < ALERT_SCORE_MIN) return;
    if (!best || score > best.score || (score === best.score && found.spanMs < best.spanMs)) {
      best = { ...found, movePct, needPct, score, grind: true };
    }
  });
  return best;
}

function canFireAlert(key, dir, price, needPct, lev, grind) {
  const prev = alertLatch.get(key);
  if (!prev) return true;
  const dt = Date.now() - prev.t;
  if (prev.dir !== dir) return dt >= REV_COOLDOWN_MS;
  const cool = grind ? GRIND_COOLDOWN_MS : SAME_DIR_COOLDOWN_MS;
  if (dt < cool) return false;
  if (!(prev.price > 0) || !(price > 0)) return dt >= cool;
  const scale = Number(lev);
  const gear = Number.isFinite(scale) && scale >= 1 ? scale : 1;
  const extra = Math.abs((price - prev.price) / prev.price) * 100 * gear;
  return extra >= needPct * REFIRE_EXTRA;
}

function showMoveNotification(items) {
  if (!Notification.isSupported() || !items.length) return;
  const iconFile = path.join(__dirname, 'icon.png');
  const icon = fs.existsSync(iconFile) ? iconFile : undefined;
  const first = items[0];
  const named = (item) => {
    const name = item.name || item.code;
    return item.marketLabel ? `${item.marketLabel} · ${name}` : name;
  };
  const title = items.length === 1
    ? `${named(first)} ${alertDirLabel(first.dir, first.grind)}`
    : `关注标的突变（${items.length}）`;
  const body = items
    .slice(0, 4)
    .map((item) => {
      const price = Number(item.price);
      const priceText = Number.isFinite(price) && price > 0 ? `  ${price.toFixed(2)}` : '';
      const action = items.length === 1 ? '' : `${alertDirLabel(item.dir, item.grind)}  `;
      const span = item.gap ? '跳空' : `约${formatAlertSpan(item.spanMs)}`;
      return `${named(item)}  ${action}${span} ${formatAlertGear(item)}${formatAlertPct(item.movePct)}${priceText}`;
    })
    .join('\n');
  try {
    const notice = new Notification({
      title,
      body,
      icon,
      silent: false
    });
    notice.on('click', () => showWidget());
    notice.show();
    lastMoveNotice = notice;
  } catch (err) {
    console.error('[stock-widget] notify error:', err.message || err);
  }
}

function normalizeAlertItem(item) {
  if (!item || typeof item !== 'object') return null;
  const t = Number(item.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const code = String(item.code || '').trim();
  if (!code) return null;
  const market = normalizeMarket(item.market);
  return {
    id: String(item.id || `${market}:${code}:${t}`),
    t,
    market,
    marketLabel: item.marketLabel || marketLabel(market),
    code,
    name: String(item.name || code),
    secId: String(item.secId || ''),
    dir: item.dir === 'down' ? 'down' : 'up',
    movePct: Number(item.movePct),
    spanMs: Number(item.spanMs) || 0,
    gap: !!item.gap,
    grind: !!item.grind,
    price: Number(item.price),
    leverage: parseLeverage(item.leverage) || undefined,
    side: parseSide(item.side) || undefined,
    read: !!item.read
  };
}

function loadAlertLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(alertsPath(), 'utf-8'));
    const items = Array.isArray(raw) ? raw : raw && raw.items;
    if (!Array.isArray(items)) return [];
    return items.map(normalizeAlertItem).filter(Boolean).slice(0, ALERT_KEEP);
  } catch (_) {
    return [];
  }
}

function persistAlertLog() {
  try {
    fs.writeFileSync(alertsPath(), `${JSON.stringify({ items: alertLog }, null, 2)}\n`);
  } catch (err) {
    console.error('[stock-widget] save alerts error:', err.message || err);
  }
}

function unreadAlertCount() {
  return alertLog.reduce((n, item) => n + (item && !item.read ? 1 : 0), 0);
}

function alertListPayload() {
  return { items: alertLog, unread: unreadAlertCount() };
}

function sendAlertList() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('alerts-changed', alertListPayload());
  }
  updateTray();
}

function pushAlertLog(fired) {
  if (!Array.isArray(fired) || !fired.length) return;
  const now = Date.now();
  fired.forEach((item, i) => {
    const next = normalizeAlertItem({
      ...item,
      id: `${item.market}:${item.code}:${now}:${i}`,
      t: now,
      read: false
    });
    if (next) alertLog.unshift(next);
  });
  if (alertLog.length > ALERT_KEEP) alertLog.length = ALERT_KEEP;
  persistAlertLog();
  sendAlertList();
}

function markAlertRead(id) {
  const want = String(id || '');
  if (!want) return alertListPayload();
  let changed = false;
  alertLog.forEach((item) => {
    if (item.id === want && !item.read) {
      item.read = true;
      changed = true;
    }
  });
  if (changed) persistAlertLog();
  if (changed) sendAlertList();
  return alertListPayload();
}

function markAllAlertsRead() {
  let changed = false;
  alertLog.forEach((item) => {
    if (!item.read) {
      item.read = true;
      changed = true;
    }
  });
  if (changed) persistAlertLog();
  if (changed) sendAlertList();
  return alertListPayload();
}

function decorateSudden(quotes) {
  const now = Date.now();
  return (quotes || []).map((q) => {
    if (!q || !q.code || !q.watch) {
      const next = { ...q };
      delete next.sudden;
      delete next.suddenPct;
      return next;
    }
    const latch = alertLatch.get(alertKey(q.code, currentMarket()));
    if (!latch || now - latch.t > ALERT_HOT_MS) {
      const next = { ...q };
      delete next.sudden;
      delete next.suddenPct;
      return next;
    }
    return { ...q, sudden: latch.dir, suddenPct: latch.movePct };
  });
}

function maybeAlert(quotes, market) {
  const m = normalizeMarket(market || currentMarket());
  const profile = marketAlertProfile(m);
  const prefix = `${m}:`;
  const watched = new Set();
  const fired = [];
  (quotes || []).forEach((q) => {
    if (!q || !q.code) return;
    const key = alertKey(q.code, m);
    if (!q.watch) {
      alertLatch.delete(key);
      recentTicks.delete(key);
      return;
    }
    watched.add(key);
    const price = Number(q.price);
    if (!(price > 0)) return;
    const ticks = pushTick(key, price);
    const gear = quoteAlertGear(q);
    const found = detectSuddenMove(ticks, profile, gear.lev)
      || detectGrindMove(ticks, profile, gear.lev);
    if (!found) return;
    const movePct = found.movePct * gear.sign;
    const dir = movePct < 0 ? 'down' : 'up';
    if (!canFireAlert(key, dir, price, found.needPct, gear.lev, found.grind)) return;
    alertLatch.set(key, {
      t: Date.now(),
      price,
      dir,
      movePct
    });
    fired.push({
      secId: q.secId || '',
      code: q.code,
      name: q.name || q.code,
      price,
      dir,
      movePct,
      pct: movePct,
      spanMs: found.spanMs,
      gap: !!found.gap,
      grind: !!found.grind,
      market: m,
      marketLabel: marketLabel(m),
      leverage: gear.lev > 1 ? gear.lev : undefined,
      side: gear.side || undefined
    });
  });
  [...recentTicks.keys()].forEach((key) => {
    if (!watched.has(key) && key.startsWith(prefix)) recentTicks.delete(key);
  });
  if (fired.length) {
    pushAlertLog(fired);
    showMoveNotification(fired);
  }
  return fired;
}

function toggleWatch(code) {
  loadConfig();
  const i = stockIndex(code);
  if (i < 0) return { watch: false };
  const list = currentStocks();
  const item = list[i];
  const next = !item.watch;
  if (next) item.watch = true;
  else delete item.watch;
  config[marketListKey(currentMarket())] = list;
  saveConfig();
  const key = alertKey(item.code, currentMarket());
  if (!next) {
    alertLatch.delete(key);
    recentTicks.delete(key);
  }
  if (lastPayload && Array.isArray(lastPayload.quotes)) {
    const quotes = attachPositions(lastPayload.quotes, currentMarket());
    const alerts = maybeAlert(quotes, currentMarket());
    sendQuotes({
      ...lastPayload,
      quotes: decorateSudden(quotes),
      alerts,
      selectedSecId,
      market: currentMarket(),
      indexSpec: currentIndex(),
      ...quoteMeta(failCount >= FAIL_SWITCH_HINT)
    });
  }
  return { watch: next };
}

function refreshQuotes() {
  const gen = ++quoteGen;
  fetching = true;
  try {
    loadConfig();
  } catch (err) {
    fetching = false;
    console.error('[stock-widget] config error:', err);
    return;
  }
  fetchQuotes()
    .catch((err) => {
      console.error('[stock-widget] fetch retry:', err.message || err);
      return fetchQuotes();
    })
    .then((quoteData) => {
      const trendSecId = selectedSecId;
      return fetchTrends(trendSecId)
        .then((trends) => ({ quoteData, trends, trendSecId }))
        .catch((err) => {
          console.error('[stock-widget] trends error:', err.message || err);
          return { quoteData, trends: lastTrends, trendSecId };
        });
    })
    .then(({ quoteData, trends, trendSecId }) => {
      if (gen !== quoteGen) return;
      if (hasQuoteData(quoteData)) failCount = 0;
      else failCount += 1;
      const chart =
        trends && trends.secId === selectedSecId
          ? trends
          : lastTrends && lastTrends.secId === selectedSecId
            ? lastTrends
            : null;
      if (chart) lastTrends = chart;
      const quotes = attachPositions(quoteData.quotes, currentMarket());
      const alerts = maybeAlert(quotes, currentMarket());
      sendQuotes({
        quotes: decorateSudden(quotes),
        index: quoteData.index,
        trends: chart,
        selectedSecId,
        market: currentMarket(),
        indexSpec: currentIndex(),
        opacity: config.opacity ?? 0.88,
        alerts,
        ...quoteMeta(failCount >= FAIL_SWITCH_HINT)
      });
    })
    .catch((err) => {
      console.error('[stock-widget] fetch error:', err);
      failCount += 1;
      const suggestSwitch = failCount >= FAIL_SWITCH_HINT;
      if (lastPayload) {
        lastPayload = { ...lastPayload, ...quoteMeta(suggestSwitch) };
        pushQuotesToRenderer();
      } else if (suggestSwitch && win && !win.isDestroyed()) {
        win.webContents.send('quotes-update', {
          quotes: [],
          index: emptyIndexPayload(),
          trends: null,
          selectedSecId,
          market: currentMarket(),
          indexSpec: currentIndex(),
          opacity: config.opacity ?? 0.88,
          ...quoteMeta(true)
        });
      }
      if (!lastPayload) {
        setTimeout(() => refreshQuotes(), 3000);
      }
    })
    .finally(() => {
      if (gen === quoteGen) fetching = false;
    });
}

function applyClickThrough(enable) {
  if (!win || win.isDestroyed()) return;
  clickThroughEnabled = enable;
  // Windows 上 hide/show 后，必须先关掉穿透再打开，forward 才会重新生效
  win.setIgnoreMouseEvents(false);
  if (enable) {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
  win.webContents.send('click-through-changed', clickThroughEnabled, userPrefClickThrough);
}

function effectiveClickThrough() {
  if (!userPrefClickThrough) return false;
  return !pointerOver;
}

function cursorOverWidget() {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function startPointerPoll() {
  if (pointerPoll) return;
  pointerPoll = setInterval(() => {
    if (!pointerOver) return;
    if (cursorOverWidget()) return;
    pointerOver = false;
    syncClickThrough();
  }, 200);
}

function stopPointerPoll() {
  if (!pointerPoll) return;
  clearInterval(pointerPoll);
  pointerPoll = null;
}

function syncClickThrough() {
  applyClickThrough(effectiveClickThrough());
}

function zonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    weekday: get('weekday'),
    minutes: hour * 60 + Number(get('minute'))
  };
}

function isCnSession(date) {
  const { weekday, minutes } = zonedClock(date, 'Asia/Shanghai');
  if (!WEEKDAYS.has(weekday)) return false;
  const morning = minutes >= 9 * 60 + 15 && minutes < 11 * 60 + 30;
  const afternoon = minutes >= 13 * 60 && minutes <= 15 * 60;
  return morning || afternoon;
}

function isUsSession(date) {
  const { weekday, minutes } = zonedClock(date, 'America/New_York');
  if (!WEEKDAYS.has(weekday)) return false;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function isMarketOpen(market) {
  const now = new Date();
  const m = normalizeMarket(market);
  if (m === 'crypto') return true;
  return m === 'us' ? isUsSession(now) : isCnSession(now);
}

function isCurrentMarketOpen() {
  return isMarketOpen(currentMarket());
}

function pruneMarketWatchState(market) {
  const prefix = `${normalizeMarket(market)}:`;
  [...recentTicks.keys()].forEach((key) => {
    if (key.startsWith(prefix)) recentTicks.delete(key);
  });
  [...alertLatch.keys()].forEach((key) => {
    if (key.startsWith(prefix)) alertLatch.delete(key);
  });
}

function pollWatchedMarkets() {
  if (watchFetching) return Promise.resolve();
  try {
    loadConfig();
  } catch (err) {
    console.error('[stock-widget] watch config error:', err.message || err);
    return Promise.resolve();
  }
  const current = currentMarket();
  const jobs = [];
  ALL_MARKETS.forEach((m) => {
    const items = watchedItems(m);
    if (!items.length) {
      pruneMarketWatchState(m);
      return;
    }
    if (m === current) return;
    if (!isMarketOpen(m)) return;
    jobs.push(
      fetchQuotesForMarket(m, items.map((item) => item.code))
        .then((data) => maybeAlert(attachPositions(data.quotes || [], m), m))
        .catch((err) => {
          console.error(`[stock-widget] watch ${m} error:`, err.message || err);
          return [];
        })
    );
  });
  if (!jobs.length) return Promise.resolve();
  watchFetching = true;
  return Promise.all(jobs).finally(() => {
    watchFetching = false;
  });
}

function stopWatchPoll() {
  if (!watchTimer) return;
  clearTimeout(watchTimer);
  watchTimer = null;
}

function watchPollLoop() {
  pollWatchedMarkets().finally(() => {
    watchTimer = setTimeout(watchPollLoop, (config && config.refreshIntervalMs) || 5000);
  });
}

function startWatchPoll() {
  stopWatchPoll();
  watchTimer = setTimeout(watchPollLoop, 400);
}

function stopRefresh() {
  if (!refreshTimer) return;
  clearTimeout(refreshTimer);
  clearInterval(refreshTimer);
  refreshTimer = null;
}

function refreshLoop() {
  const open = isCurrentMarketOpen();
  if (open || !lastPayload) {
    refreshQuotes();
    marketWasOpen = open;
    refreshTimer = setTimeout(
      refreshLoop,
      open ? config.refreshIntervalMs || 5000 : 3000
    );
    return;
  }
  if (marketWasOpen) {
    refreshQuotes();
    marketWasOpen = false;
  }
  refreshTimer = setTimeout(refreshLoop, CLOSED_WAKE_MS);
}

function startRefresh() {
  stopRefresh();
  if (!config) loadConfig();
  marketWasOpen = isCurrentMarketOpen();
  const delay = marketWasOpen ? config.refreshIntervalMs || 5000 : CLOSED_WAKE_MS;
  refreshTimer = setTimeout(refreshLoop, delay);
  startWatchPoll();
}

function setQuoteProvider(id) {
  loadConfig();
  const next = normalizeProviderId(id);
  if (config.quoteProvider !== next) {
    config.quoteProvider = next;
    saveConfig();
    lastTrends = null;
    lastPayload = null;
    failCount = 0;
  }
  refreshQuotes();
  startRefresh();
  updateTray();
  return currentProvider();
}

function reloadAll() {
  loadConfig();
  lastTrends = null;
  failCount = 0;
  refreshQuotes();
  startRefresh();
  syncClickThrough();
  updateTray();
  return config;
}

function setClickThroughPref(enabled) {
  userPrefClickThrough = !!enabled;
  pointerOver = false;
  if (config) {
    config.clickThrough = userPrefClickThrough;
    saveConfig();
  }
  syncClickThrough();
  updateTray();
  return userPrefClickThrough;
}

function toggleClickThrough() {
  return setClickThroughPref(!userPrefClickThrough);
}

function isWidgetVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible());
}

function showWidget() {
  if (!win || win.isDestroyed()) return;
  pointerOver = false;
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.send('widget-reset');
  setTimeout(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    syncClickThrough();
  }, 30);
  updateTray();
}

function hideWidget() {
  if (!win || win.isDestroyed()) return;
  savePosition();
  pointerOver = false;
  win.webContents.send('widget-reset');
  win.hide();
  updateTray();
}

function toggleWidget() {
  if (isWidgetVisible()) hideWidget();
  else showWidget();
}

function makeSolidCircleIcon(rgb, size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      let a = 0;
      if (d <= r) a = 255;
      else if (d <= r + 1) a = Math.round(255 * (r + 1 - d));
      buf[i] = rgb[0];
      buf[i + 1] = rgb[1];
      buf[i + 2] = rgb[2];
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function loadTrayIcons() {
  const iconFile = path.join(__dirname, 'icon.png');
  trayIdleIcon = fs.existsSync(iconFile)
    ? nativeImage.createFromPath(iconFile)
    : makeSolidCircleIcon([186, 214, 255]);
  trayFlashIcon = makeSolidCircleIcon([245, 197, 24]);
}

function shouldBlinkTray() {
  return !isWidgetVisible() && unreadAlertCount() > 0;
}

function stopTrayBlink() {
  if (trayBlinkTimer) {
    clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
  }
  trayBlinkLit = true;
  if (tray && !tray.isDestroyed() && trayIdleIcon) {
    tray.setImage(trayIdleIcon);
  }
}

function startTrayBlink() {
  if (!tray || tray.isDestroyed()) return;
  if (trayBlinkTimer) return;
  trayBlinkLit = true;
  if (trayFlashIcon) tray.setImage(trayFlashIcon);
  trayBlinkTimer = setInterval(() => {
    if (!tray || tray.isDestroyed()) return;
    trayBlinkLit = !trayBlinkLit;
    tray.setImage(trayBlinkLit ? trayFlashIcon : trayIdleIcon);
  }, 480);
}

function syncTrayBlink() {
  if (!tray || tray.isDestroyed()) return;
  if (shouldBlinkTray()) startTrayBlink();
  else stopTrayBlink();
}

function updateTray() {
  if (!tray) return;
  const visible = isWidgetVisible();
  const unread = unreadAlertCount();
  if (!visible && unread > 0) {
    tray.setToolTip(`有 ${unread} 条未读提醒（点击显示）`);
  } else {
    tray.setToolTip(visible ? '悬浮行情（点击隐藏）' : '悬浮行情（点击显示）');
  }
  syncTrayBlink();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? '隐藏插件' : '显示插件',
        click: () => toggleWidget()
      },
      { type: 'separator' },
      {
        label: '重新加载配置',
        click: () => reloadAll()
      },
      {
        label: '数据来源',
        submenu: QUOTE_PROVIDERS.map((p) => ({
          label: p.label,
          type: 'radio',
          checked: currentProvider().id === p.id,
          click: () => setQuoteProvider(p.id)
        }))
      },
      {
        label: '鼠标穿透',
        type: 'checkbox',
        checked: userPrefClickThrough,
        click: (item) => setClickThroughPref(!!item.checked)
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  );
}

function createTray() {
  loadTrayIcons();
  tray = new Tray(trayIdleIcon);
  updateTray();
  tray.on('click', () => toggleWidget());
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function listFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  entries.forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, acc);
      return;
    }
    acc.push(full);
  });
  return acc;
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function watchDevReload() {
  if (app.isPackaged) return;
  const reloadRenderer = debounce(() => {
    if (win && !win.isDestroyed()) {
      console.log('[stock-widget] 热更新：刷新界面');
      win.webContents.reloadIgnoringCache();
    }
  }, 250);
  const relaunchApp = debounce(() => {
    console.log('[stock-widget] 热更新：重启主进程');
    try {
      app.releaseSingleInstanceLock();
    } catch (_) {
      /* ignore */
    }
    app.relaunch();
    app.exit(0);
  }, 500);
  const reloadCfg = debounce(() => {
    console.log('[stock-widget] 热更新：重载配置');
    reloadAll();
  }, 250);

  const watched = [
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, 'icon.png'),
    path.join(__dirname, 'stocks.json'),
    ...listFiles(path.join(__dirname, 'renderer')),
    ...listFiles(path.join(__dirname, 'lib'))
  ];
  const mtimes = new Map();
  watched.forEach((file) => mtimes.set(file, fileMtime(file)));

  const timer = setInterval(() => {
    const latest = [
      path.join(__dirname, 'main.js'),
      path.join(__dirname, 'preload.js'),
      path.join(__dirname, 'icon.png'),
      path.join(__dirname, 'stocks.json'),
      ...listFiles(path.join(__dirname, 'renderer')),
      ...listFiles(path.join(__dirname, 'lib'))
    ];
    latest.forEach((file) => {
      const next = fileMtime(file);
      const prev = mtimes.get(file);
      if (prev == null) {
        mtimes.set(file, next);
        return;
      }
      if (next === prev) return;
      mtimes.set(file, next);
      const rel = path.relative(__dirname, file).replace(/\\/g, '/');
      if (rel === 'stocks.json') {
        reloadCfg();
        return;
      }
      if (rel.startsWith('renderer/')) {
        reloadRenderer();
        return;
      }
      relaunchApp();
    });
    [...mtimes.keys()].forEach((file) => {
      if (!latest.includes(file)) mtimes.delete(file);
    });
  }, 400);

  fileWatchers.push({
    close() {
      clearInterval(timer);
    }
  });
  console.log('[stock-widget] 开发热更新已开启：改界面会刷新窗口，改主进程会自动重启');
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    toggleClickThrough();
  });
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    reloadAll();
  });
}

function createWindow() {
  loadConfig();
  const pos = loadPosition();

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setAlwaysOnTop(true, 'screen-saver');

  win.webContents.on('did-finish-load', () => {
    syncClickThrough();
    pushQuotesToRenderer();
    sendAlertList();
  });
}

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('set-theme', (_, theme) => {
  loadConfig();
  config.theme = theme === 'moon' ? 'moon' : 'sun';
  saveConfig();
  return config.theme;
});
ipcMain.handle('set-market', (_, market) => {
  loadConfig();
  const next = normalizeMarket(market);
  if (config.market !== next) {
    config.market = next;
    saveConfig();
    selectedSecId = indexSecId();
    lastTrends = null;
    lastPayload = null;
    failCount = 0;
    pendingFocusIndex = 0;
  }
  refreshQuotes();
  startRefresh();
  return config.market;
});
ipcMain.handle('reload-config', () => reloadAll());
ipcMain.handle('set-quote-provider', (_, id) => setQuoteProvider(id));
ipcMain.handle('toggle-click-through', () => toggleClickThrough());

ipcMain.handle('stock-order-info', (_, code) => {
  loadConfig();
  const list = currentStocks();
  const i = stockIndex(code);
  return {
    index: i,
    total: list.length
  };
});

ipcMain.on('reorder-stock', (_, payload) => {
  if (!payload || !payload.code || !payload.action) return;
  reorderStock(payload.code, payload.action);
});

ipcMain.handle('toggle-watch', (_, code) => {
  if (!code || typeof code !== 'string') return { watch: false };
  return toggleWatch(code);
});

ipcMain.handle('get-alerts', () => alertListPayload());
ipcMain.handle('mark-alert-read', (_, id) => markAlertRead(id));
ipcMain.handle('mark-all-alerts-read', () => markAllAlertsRead());

ipcMain.on('select-trend', (_, secId) => {
  if (!secId || typeof secId !== 'string') return;
  selectedSecId = secId;
  const want = secId;
  fetchTrends(want)
    .then((trends) => {
      if (selectedSecId !== want) return;
      lastTrends = trends;
      sendQuotes({
        ...(lastPayload || { quotes: [], index: emptyIndexPayload() }),
        trends,
        selectedSecId: want,
        market: currentMarket(),
        indexSpec: currentIndex(),
        ...quoteMeta(failCount >= FAIL_SWITCH_HINT)
      });
    })
    .catch((err) => console.error('[stock-widget] trends error:', err));
});

ipcMain.on('pointer-over', (_, over) => {
  if (over && !cursorOverWidget()) over = false;
  pointerOver = !!over;
  syncClickThrough();
});

ipcMain.on('move-window', (_, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
  scheduleSavePosition();
});

if (process.platform === 'win32') {
  app.setAppUserModelId('com.local.stockwidget');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWidget();
  });

  app.whenReady().then(() => {
    loadConfig();
    alertLog = loadAlertLog();
    selectedSecId = indexSecId();
    createWindow();
    createTray();
    startPointerPoll();
    registerShortcuts();
    refreshQuotes();
    startRefresh();
    watchDevReload();
  });
}

app.on('window-all-closed', () => {
  // 隐藏窗口时仍留在托盘，不退出
});

app.on('will-quit', () => {
  stopPointerPoll();
  stopRefresh();
  stopWatchPoll();
  stopTrayBlink();
  fileWatchers.forEach((w) => {
    try {
      w.close();
    } catch (_) {
      /* ignore */
    }
  });
  fileWatchers = [];
  clearTimeout(savePosTimer);
  savePosition();
  globalShortcut.unregisterAll();
});
