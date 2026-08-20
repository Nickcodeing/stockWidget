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
const QUOTE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/'
};

let win;
let tray;
let config;
let refreshTimer;
let clickThroughEnabled = true;
let userPrefClickThrough = true;
let pointerOver = false;
let fetching = false;
let lastPayload = null;
let lastTrends = null;
let savePosTimer = null;
let pendingFocusIndex;
let quoteGen = 0;

const WINDOW_WIDTH = 328;
const WINDOW_HEIGHT = 292;
const DEFAULT_POSITION = { x: 1569, y: 748 };
const INDEX_SECID = '1.000001';
let selectedSecId = INDEX_SECID;

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

function loadConfig() {
  config = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  userPrefClickThrough = config.clickThrough !== false;
  if (config.theme !== 'moon') config.theme = 'sun';
  return config;
}

function saveConfig() {
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function stockIndex(code) {
  const padded = String(code).replace(/\D/g, '').padStart(6, '0');
  return (config.stocks || []).findIndex(
    (c) => String(c).replace(/\D/g, '').padStart(6, '0') === padded
  );
}

function reorderStock(code, action) {
  loadConfig();
  const i = stockIndex(code);
  if (i < 0 || !Array.isArray(config.stocks)) return;
  const item = config.stocks[i];
  if (action === 'top' && i > 0) {
    config.stocks.splice(i, 1);
    config.stocks.unshift(item);
  } else if (action === 'up' && i > 0) {
    const prev = config.stocks[i - 1];
    config.stocks[i - 1] = item;
    config.stocks[i] = prev;
  } else if (action === 'down' && i < config.stocks.length - 1) {
    const next = config.stocks[i + 1];
    config.stocks[i + 1] = item;
    config.stocks[i] = next;
  } else {
    return;
  }
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

function toQuote(x) {
  return { code: x.f12, name: x.f14, price: x.f2, pct: x.f3 };
}

function isShanghaiIndex(x) {
  return String(x.f12).padStart(6, '0') === '000001' && Number(x.f13) === 1;
}

function fetchQuotes(codes) {
  const padded = (codes || []).map((c) => String(c).replace(/\D/g, '').padStart(6, '0'));
  const secids = ['1.000001', ...padded.map(toSecId)].join(',');
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2' +
    `&fields=f12,f13,f14,f2,f3&secids=${secids}`;

  return requestText(url).then((raw) => {
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
      index: indexItem ? toQuote(indexItem) : null
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
  const url =
    'https://push2.eastmoney.com/api/qt/stock/trends2/get?' +
    `secid=${encodeURIComponent(secid)}&ndays=1&iscr=0&fltt=2` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
  return requestText(url).then((raw) => {
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

function sendQuotes(payload) {
  if (Number.isFinite(pendingFocusIndex)) {
    payload.focusIndex = pendingFocusIndex;
    pendingFocusIndex = undefined;
  }
  lastPayload = payload;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('quotes-update', payload);
  }
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
  fetchQuotes(config.stocks)
    .catch((err) => {
      console.error('[stock-widget] fetch retry:', err.message || err);
      return fetchQuotes(config.stocks);
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
        opacity: config.opacity ?? 0.88
      });
    })
    .catch((err) => console.error('[stock-widget] fetch error:', err))
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

function startRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshQuotes, config.refreshIntervalMs || 5000);
}

function reloadAll() {
  loadConfig();
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
  tray.setToolTip(visible ? 'A股悬浮行情（点击隐藏）' : 'A股悬浮行情（点击显示）');
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
    if (lastPayload) {
      win.webContents.send('quotes-update', lastPayload);
    }
  });
}

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('set-theme', (_, theme) => {
  loadConfig();
  config.theme = theme === 'moon' ? 'moon' : 'sun';
  saveConfig();
  return config.theme;
});
ipcMain.handle('reload-config', () => reloadAll());
ipcMain.handle('toggle-click-through', () => toggleClickThrough());

ipcMain.handle('stock-order-info', (_, code) => {
  loadConfig();
  const i = stockIndex(code);
  return {
    index: i,
    total: Array.isArray(config.stocks) ? config.stocks.length : 0
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
        selectedSecId
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
    createWindow();
    createTray();
    registerShortcuts();
    refreshQuotes();
    startRefresh();
  });
}

app.on('window-all-closed', () => {
  // 隐藏窗口时仍留在托盘，不退出
});

app.on('will-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  clearTimeout(savePosTimer);
  savePosition();
  globalShortcut.unregisterAll();
});
