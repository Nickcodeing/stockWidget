const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  net,
  screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const QUOTE_TIMEOUT_MS = 4000;
const EASTMONEY_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com'
];
const QUOTE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/'
};

let win;
let tray;
let config;
let refreshTimer;
let marketWasOpen = false;
const CLOSED_WAKE_MS = 60 * 1000;
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
let clickThroughEnabled = true;
let userPrefClickThrough = true;
let pointerOver = false;
let fetching = false;
let lastPayload = null;
let lastTrends = null;
let savePosTimer = null;
let pendingFocusIndex;
let quoteGen = 0;
let fileWatchers = [];

const WINDOW_WIDTH = 328;
const WINDOW_HEIGHT = 292;
const DEFAULT_POSITION = { x: 1569, y: 748 };
const CN_INDEX_SECID = '1.000001';
const US_INDEX_SECID = '100.NDX';
let selectedSecId = CN_INDEX_SECID;

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

function currentMarket() {
  return config && config.market === 'us' ? 'us' : 'cn';
}

function indexSecId() {
  return currentMarket() === 'us' ? US_INDEX_SECID : CN_INDEX_SECID;
}

function currentStocks() {
  const key = currentMarket() === 'us' ? 'usStocks' : 'stocks';
  return Array.isArray(config[key]) ? config[key] : [];
}

function normalizeUsTicker(code) {
  return String(code || '')
    .trim()
    .replace(/^\$/, '')
    .toUpperCase();
}

function loadConfig() {
  config = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  userPrefClickThrough = config.clickThrough !== false;
  if (config.theme !== 'moon') config.theme = 'sun';
  if (config.market !== 'us') config.market = 'cn';
  if (!Array.isArray(config.usStocks)) config.usStocks = [];
  return config;
}

function saveConfig() {
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function stockIndex(code) {
  const list = currentStocks();
  if (currentMarket() === 'us') {
    const ticker = normalizeUsTicker(code);
    return list.findIndex((c) => normalizeUsTicker(c) === ticker);
  }
  const padded = String(code).replace(/\D/g, '').padStart(6, '0');
  return list.findIndex((c) => String(c).replace(/\D/g, '').padStart(6, '0') === padded);
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

function toSecId(code) {
  const c = String(code).replace(/\D/g, '').padStart(6, '0');
  return `${c.startsWith('6') ? '1' : '0'}.${c}`;
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

function isShanghaiIndex(x) {
  return String(x.f12).padStart(6, '0') === '000001' && Number(x.f13) === 1;
}

function isNasdaq100(x) {
  return String(x.f12).toUpperCase() === 'NDX' && Number(x.f13) === 100;
}

function usMarketRank(x) {
  const m = Number(x.f13);
  if (m === 105) return 0;
  if (m === 106) return 1;
  if (m === 107) return 2;
  return 9;
}

function fetchQuotes() {
  return currentMarket() === 'us' ? fetchUsQuotes() : fetchCnQuotes();
}

function fetchCnQuotes() {
  const padded = currentStocks().map((c) => String(c).replace(/\D/g, '').padStart(6, '0'));
  const secids = [CN_INDEX_SECID, ...padded.map(toSecId)].join(',');
  const pathQuery =
    '/api/qt/ulist.np/get?fltt=2' +
    `&fields=f12,f13,f14,f2,f3&secids=${secids}`;

  return requestEastmoney(pathQuery).then((raw) => {
    const json = JSON.parse(raw);
    const list = normalizeDiff(json?.data?.diff);
    const indexItem = list.find(isShanghaiIndex) || list.find((x) => x.f14 === '上证指数');
    const map = new Map(
      list
        .filter((x) => !isShanghaiIndex(x))
        .map((x) => [String(x.f12).padStart(6, '0'), toQuote(x)])
    );
    return {
      quotes: padded.map((c) => map.get(c)).filter(Boolean),
      index: indexItem ? toQuote(indexItem, { name: '上证指数', secId: CN_INDEX_SECID }) : null
    };
  });
}

function fetchUsQuotes() {
  const tickers = [...new Set(currentStocks().map(normalizeUsTicker).filter(Boolean))];
  const secids = [
    US_INDEX_SECID,
    ...tickers.flatMap((t) => [`105.${t}`, `106.${t}`, `107.${t}`])
  ].join(',');
  const pathQuery =
    '/api/qt/ulist.np/get?fltt=2' +
    `&fields=f12,f13,f14,f2,f3&secids=${secids}`;

  return requestEastmoney(pathQuery).then((raw) => {
    const json = JSON.parse(raw);
    const list = normalizeDiff(json?.data?.diff);
    const indexItem = list.find(isNasdaq100);
    const map = new Map();
    list
      .filter((x) => !isNasdaq100(x) && Number.isFinite(Number(x.f2)))
      .forEach((x) => {
        const ticker = String(x.f12 || '').toUpperCase();
        if (!ticker) return;
        const prev = map.get(ticker);
        if (!prev || usMarketRank(x) < usMarketRank(prev)) map.set(ticker, x);
      });
    return {
      quotes: tickers
        .map((t) => {
          const x = map.get(t);
          return x ? toQuote(x, { code: t }) : null;
        })
        .filter(Boolean),
      index: indexItem
        ? toQuote(indexItem, { name: '纳斯达克100', secId: US_INDEX_SECID })
        : { code: 'NDX', name: '纳斯达克100', price: '-', pct: null, secId: US_INDEX_SECID }
    };
  });
}

function parseTrendLine(line) {
  const p = String(line).split(',');
  const time = (p[0] || '').slice(-5);
  return {
    time,
    price: Number(p[1]),
    avg: Number(p[2])
  };
}

function fetchTrends(secid) {
  const pathQuery =
    '/api/qt/stock/trends2/get?' +
    `secid=${encodeURIComponent(secid)}&ndays=1&iscr=0&fltt=2` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
  return requestEastmoney(pathQuery).then((raw) => {
    const json = JSON.parse(raw);
    const d = json?.data || {};
    const points = (d.trends || [])
      .map(parseTrendLine)
      .filter((p) => p.time && Number.isFinite(p.price));
    return {
      secId: secid,
      name: d.name || '',
      code: d.code || '',
      preClose: Number(d.preClose),
      points
    };
  });
}

function requestEastmoney(pathQuery) {
  return Promise.any(EASTMONEY_HOSTS.map((host) => requestText(host + pathQuery))).catch((err) => {
    const first = err && err.errors && err.errors[0] ? err.errors[0] : err;
    throw first;
  });
}

function requestText(url) {
  return requestWithNet(url).catch(() => requestWithHttps(url));
}

function requestWithNet(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET' });
    Object.entries(QUOTE_HEADERS).forEach(([k, v]) => req.setHeader(k, v));
    let raw = '';
    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch (_) {
        /* ignore */
      }
      reject(new Error('quote timeout'));
    }, QUOTE_TIMEOUT_MS);
    req.on('response', (res) => {
      res.on('data', (chunk) => {
        raw += Buffer.from(chunk).toString('utf8');
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(raw);
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function requestWithHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: QUOTE_HEADERS, timeout: QUOTE_TIMEOUT_MS, family: 4 },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve(raw));
      }
    );
    req.on('timeout', () => req.destroy(new Error('quote timeout')));
    req.on('error', reject);
  });
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
      lastTrends = trends;
      sendQuotes({
        quotes: quoteData.quotes,
        index: quoteData.index,
        trends,
        selectedSecId,
        market: currentMarket(),
        opacity: config.opacity ?? 0.88
      });
    })
    .catch((err) => {
      console.error('[stock-widget] fetch error:', err);
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
  win.webContents.send('click-through-changed', clickThroughEnabled);
}

function effectiveClickThrough() {
  if (!userPrefClickThrough) return false;
  return !pointerOver;
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

function reloadAll() {
  loadConfig();
  selectedSecId = indexSecId();
  lastTrends = null;
  refreshQuotes();
  startRefresh();
  syncClickThrough();
  return config;
}

function toggleClickThrough() {
  userPrefClickThrough = !userPrefClickThrough;
  syncClickThrough();
  return clickThroughEnabled;
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
        label: '切换鼠标穿透',
        click: () => toggleClickThrough()
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
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function watchDevReload() {
  if (app.isPackaged) return;
  const reloadRenderer = debounce(() => {
    if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }, 250);
  const relaunchApp = debounce(() => {
    app.relaunch();
    app.exit(0);
  }, 400);
  const reloadCfg = debounce(() => reloadAll(), 250);

  try {
    fileWatchers.push(
      fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, reloadRenderer)
    );
    fileWatchers.push(
      fs.watch(__dirname, (_, filename) => {
        if (!filename) return;
        if (filename === 'stocks.json') {
          reloadCfg();
          return;
        }
        if (filename === 'main.js' || filename === 'preload.js' || filename === 'icon.png') {
          relaunchApp();
        }
      })
    );
    console.log('[stock-widget] 开发热更新已开启：改界面会刷新窗口，改主进程会自动重启');
  } catch (err) {
    console.error('[stock-widget] watch error:', err);
  }
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
    pendingFocusIndex = 0;
  }
  refreshQuotes();
  startRefresh();
  return config.market;
});
ipcMain.handle('reload-config', () => reloadAll());
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
        ...(lastPayload || { quotes: [], index: null }),
        trends,
        selectedSecId,
        market: currentMarket()
      });
    })
    .catch((err) => console.error('[stock-widget] trends error:', err));
});

ipcMain.on('pointer-over', (_, over) => {
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
