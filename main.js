const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen
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
const FAIL_SWITCH_HINT = 3;

let win;
let tray;
let config;
let refreshTimer;
let marketWasOpen = false;
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

const WINDOW_WIDTH = 328;
const WINDOW_HEIGHT = 292;
const DEFAULT_POSITION = { x: 1569, y: 748 };
const DEFAULT_CN_INDEX = { secId: '1.000001', name: '上证指数' };
const DEFAULT_US_INDEX = { secId: '100.NDX100', name: '纳斯达克100' };
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
    stocks: [],
    usStocks: [],
    quoteProvider: 'eastmoney'
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

function currentMarket() {
  return config && config.market === 'us' ? 'us' : 'cn';
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

function currentIndex() {
  return currentMarket() === 'us'
    ? parseIndexSpec(config.usIndex, DEFAULT_US_INDEX)
    : parseIndexSpec(config.cnIndex, DEFAULT_CN_INDEX);
}

function indexSecId() {
  return currentIndex().secId;
}

function currentStocks() {
  const key = currentMarket() === 'us' ? 'usStocks' : 'stocks';
  return Array.isArray(config[key]) ? config[key] : [];
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
  return { code, cost: parsed.cost };
}

function serializeStockEntry(item) {
  return {
    code: item && item.code ? item.code : '',
    cost: parseCostNumber(item && item.cost)
  };
}

function normalizeStockLists() {
  config.stocks = (Array.isArray(config.stocks) ? config.stocks : [])
    .map((item) => normalizeStockEntry(item, false))
    .filter(Boolean);
  config.usStocks = (Array.isArray(config.usStocks) ? config.usStocks : [])
    .map((item) => normalizeStockEntry(item, true))
    .filter(Boolean);
}

function quoteCostKey(code) {
  if (currentMarket() === 'us') return normalizeUsTicker(code);
  return String(code || '').replace(/\D/g, '').padStart(6, '0');
}

function attachCosts(quotes) {
  const costs = new Map();
  currentStocks().forEach((item) => {
    if (!item || !(item.cost > 0)) return;
    costs.set(quoteCostKey(item.code), item.cost);
  });
  return (quotes || []).map((q) => {
    const cost = costs.get(quoteCostKey(q && q.code));
    return cost > 0 ? { ...q, cost } : q;
  });
}

function applyLoadedConfig(data) {
  config = { ...defaultConfig(), ...(data && typeof data === 'object' ? data : {}) };
  userPrefClickThrough = config.clickThrough === true;
  if (config.theme !== 'moon') config.theme = 'sun';
  if (config.market !== 'us') config.market = 'cn';
  if (!Array.isArray(config.stocks)) config.stocks = [];
  if (!Array.isArray(config.usStocks)) config.usStocks = [];
  try {
    normalizeStockLists();
  } catch (_) {
    config.stocks = [];
    config.usStocks = [];
  }
  config.quoteProvider = normalizeProviderId(config.quoteProvider);
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
    usStocks: (Array.isArray(config.usStocks) ? config.usStocks : []).map(serializeStockEntry)
  };
  fs.writeFileSync(configPath(), `${JSON.stringify(out, null, 2)}\n`);
}

function stockIndex(code) {
  const list = currentStocks();
  if (currentMarket() === 'us') {
    const ticker = normalizeUsTicker(code);
    return list.findIndex((c) => normalizeUsTicker(c.code) === ticker);
  }
  const padded = String(code || '')
    .replace(/\D/g, '')
    .padStart(6, '0');
  return list.findIndex((c) => String(c.code).replace(/\D/g, '').padStart(6, '0') === padded);
}

function reorderStock(code, action) {
  loadConfig();
  const key = currentMarket() === 'us' ? 'usStocks' : 'stocks';
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

function fetchQuotes() {
  return getQuoteProvider(currentProvider().id).fetchQuotes({
    market: currentMarket(),
    stocks: currentStockCodes(),
    indexSpec: currentIndex()
  });
}

function fetchTrends(secId) {
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
  lastPayload = payload;
  pushQuotesToRenderer();
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
    .then((quoteData) =>
      fetchTrends(selectedSecId)
        .then((trends) => ({ quoteData, trends }))
        .catch((err) => {
          console.error('[stock-widget] trends error:', err.message || err);
          return { quoteData, trends: lastTrends };
        })
    )
    .then(({ quoteData, trends }) => {
      if (gen !== quoteGen) return;
      if (hasQuoteData(quoteData)) failCount = 0;
      else failCount += 1;
      lastTrends = trends;
      sendQuotes({
        quotes: attachCosts(quoteData.quotes),
        index: quoteData.index,
        trends,
        selectedSecId,
        market: currentMarket(),
        indexSpec: currentIndex(),
        opacity: config.opacity ?? 0.88,
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

function isCurrentMarketOpen() {
  const now = new Date();
  return currentMarket() === 'us' ? isUsSession(now) : isCnSession(now);
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
  selectedSecId = indexSecId();
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

function updateTray() {
  if (!tray) return;
  const visible = isWidgetVisible();
  tray.setToolTip(visible ? '悬浮行情（点击隐藏）' : '悬浮行情（点击显示）');
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
  const iconFile = path.join(__dirname, 'icon.png');
  const icon = fs.existsSync(iconFile)
    ? nativeImage.createFromPath(iconFile)
    : nativeImage.createEmpty();
  tray = new Tray(icon);
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
  const next = market === 'us' ? 'us' : 'cn';
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

ipcMain.on('select-trend', (_, secId) => {
  if (!secId || typeof secId !== 'string') return;
  selectedSecId = secId;
  fetchTrends(selectedSecId)
    .then((trends) => {
      lastTrends = trends;
      sendQuotes({
        ...(lastPayload || { quotes: [], index: emptyIndexPayload() }),
        trends,
        selectedSecId,
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWidget();
  });

  app.whenReady().then(() => {
    loadConfig();
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
