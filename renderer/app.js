const ROW_H = 28;
const VISIBLE = 3;
const DEFAULT_CN_INDEX = { secId: '1.000001', name: '上证指数', code: '000001' };
const DEFAULT_US_INDEX = { secId: '100.NDX100', name: '纳斯达克100', code: 'NDX100' };
const DEFAULT_CRYPTO_INDEX = { secId: 'crypto.BTC.spot', name: '比特币', code: 'BTC' };
const DRAG_THRESHOLD = 5;

let quotes = [];
let scrollIndex = 0;
let dragging = false;
let dragMoved = false;
let hover = false;
let dragStart = { x: 0, y: 0 };
let pendingSecId = null;
let currentMarket = 'cn';
let selectedSecId = DEFAULT_CN_INDEX.secId;
let trends = null;
let savedCfg = null;
let indexSpec = DEFAULT_CN_INDEX;
const flashSecIds = new Set();
let flashTimer = null;

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
  return { secId: fallback.secId, name: fallback.name, code: fallback.code || codeFrom(fallback.secId) };
}

function normalizeMarket(market) {
  if (market === 'us' || market === 'crypto') return market;
  return 'cn';
}

function isGreenUpMarket() {
  return currentMarket === 'us' || currentMarket === 'crypto';
}

function specForMarket(market) {
  const m = normalizeMarket(market);
  if (m === 'us') return parseIndexSpec(savedCfg?.usIndex, DEFAULT_US_INDEX);
  if (m === 'crypto') {
    const spec = parseIndexSpec(savedCfg?.cryptoIndex, DEFAULT_CRYPTO_INDEX);
    if (String(spec.secId || '').startsWith('crypto.')) {
      const parts = String(spec.secId).split('.');
      spec.code = parts[2] === 'perp' ? `${parts[1]}-PERP` : parts[1];
    }
    return spec;
  }
  return parseIndexSpec(savedCfg?.cnIndex, DEFAULT_CN_INDEX);
}

function indexSecId() {
  return indexSpec.secId;
}

function rowSecId(q) {
  if (q?.secId) return q.secId;
  if (currentMarket === 'crypto') {
    const code = String(q?.code || '').toUpperCase();
    if (!code) return '';
    if (code.endsWith('-PERP') || code.endsWith('PERP')) {
      const base = code.replace(/-PERP$/, '').replace(/PERP$/, '');
      return `crypto.${base}.perp`;
    }
    return `crypto.${code}.spot`;
  }
  const c = String(q?.code || '').replace(/\D/g, '').padStart(6, '0');
  return `${c.startsWith('6') ? '1' : '0'}.${c}`;
}

function rowCode(q) {
  if (currentMarket === 'us' || currentMarket === 'crypto') return String(q.code || '').toUpperCase();
  return String(q.code).replace(/\D/g, '').padStart(6, '0');
}

function rowCodeLabel(q) {
  if (currentMarket === 'crypto') return q.kindLabel || (String(q.code || '').endsWith('-PERP') ? '永续' : '现货');
  return q.code;
}

function syncPointerOver() {
  window.stockApi.setPointerOver(hover || dragging);
}

const listEl = document.getElementById('list');
const panelEl = document.getElementById('panel');
const statusEl = document.getElementById('status');
const clockEl = document.getElementById('clock');
const hoverTipEl = document.getElementById('hover-tip');
let hoverTipTimer = null;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function tickClock() {
  const d = new Date();
  clockEl.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

tickClock();
setInterval(tickClock, 1000);

const themeBtn = document.getElementById('theme-btn');
const srcBtn = document.getElementById('src-btn');
const srcMenuEl = document.getElementById('src-menu');
const alertBtn = document.getElementById('alert-btn');
const alertBadgeEl = document.getElementById('alert-badge');
const alertPanelEl = document.getElementById('alert-panel');
const alertListEl = document.getElementById('alert-list');
const alertReadAllBtn = document.getElementById('alert-read-all');
const hintEl = document.getElementById('hint');
const scaleBtn = document.getElementById('scale-btn');
const marketCnBtn = document.getElementById('market-cn');
const marketUsBtn = document.getElementById('market-us');
const marketCryptoBtn = document.getElementById('market-crypto');
const chartMetaEl = document.getElementById('chart-meta');
const indexNameEl = document.querySelector('#index-row .name');
const indexRowEl = document.getElementById('index-row');
const indexPriceEl = document.getElementById('index-price');
const indexPctEl = document.getElementById('index-pct');
const chartEl = document.getElementById('chart');
const chartTitleEl = document.getElementById('chart-title');
const ctx = chartEl.getContext('2d');
let currentTheme = 'sun';
let currentProvider = 'eastmoney';
let clickThroughPref = false;
let alertItems = [];
let alertUnread = 0;
const PROVIDERS = [
  { id: 'eastmoney', label: '东方财富', short: '东财' },
  { id: 'tencent', label: '腾讯财经', short: '腾讯' },
  { id: 'sina', label: '新浪财经', short: '新浪' }
];
const DEFAULT_HINT = '点星关注 · 左键分时 · 右键排序';

function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

function hideSrcMenu() {
  srcMenuEl.hidden = true;
}

function alertPanelOpen() {
  return !!(alertPanelEl && !alertPanelEl.hidden);
}

function hideAlertPanel() {
  if (!alertPanelEl) return;
  alertPanelEl.hidden = true;
  if (alertBtn) alertBtn.classList.remove('open');
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

function formatAlertGear(item) {
  const lev = Number(item && item.leverage);
  if (!(lev >= 1) || lev === 1) return '';
  const side = String(item && item.side || '').toLowerCase();
  const sideText = side === 'sell' || side === 'short' ? '空'
    : side === 'buy' || side === 'long' ? '多' : '';
  return `${lev}x${sideText} `;
}

function formatAlertTime(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function renderAlertBadge() {
  if (!alertBtn || !alertBadgeEl) return;
  alertBtn.classList.toggle('has-unread', alertUnread > 0);
  alertBtn.title = alertUnread > 0 ? `提醒（${alertUnread}条未读）` : '提醒';
  if (alertUnread > 0) {
    alertBadgeEl.hidden = false;
    alertBadgeEl.textContent = alertUnread > 9 ? '9+' : String(alertUnread);
  } else {
    alertBadgeEl.hidden = true;
  }
}

function renderAlertList() {
  if (!alertListEl || !alertReadAllBtn) return;
  alertReadAllBtn.disabled = alertUnread <= 0;
  if (!alertItems.length) {
    alertListEl.innerHTML = '<div class="alert-empty">暂无提醒</div>';
    return;
  }
  alertListEl.innerHTML = alertItems.map((item) => {
    const dir = item.dir === 'down' ? 'down' : 'up';
    const action = item.grind
      ? (dir === 'down' ? '持续下挫' : '持续拉升')
      : (dir === 'down' ? '突然下挫' : '突然拉升');
    const span = item.gap ? '跳空' : `约${formatAlertSpan(item.spanMs)}`;
    const price = Number(item.price);
    const priceText = Number.isFinite(price) && price > 0 ? `  ${price.toFixed(2)}` : '';
    const name = [item.marketLabel, item.name || item.code].filter(Boolean).join(' · ');
    const readCls = item.read ? ' read' : '';
    return `<button type="button" class="alert-item${readCls}" data-id="${escapeHtml(item.id)}" data-market="${escapeHtml(item.market || 'cn')}">
      <span class="alert-dot"></span>
      <span class="alert-main">
        <span class="alert-top">
          <span class="alert-name">${escapeHtml(name)}</span>
          <span class="alert-time">${escapeHtml(formatAlertTime(item.t))}</span>
        </span>
        <span class="alert-body"><span class="alert-move ${dir}">${action}</span>${escapeHtml(`${span} ${formatAlertGear(item)}${formatAlertPct(item.movePct)}${priceText}`)}</span>
      </span>
    </button>`;
  }).join('');
}

function applyAlerts(data) {
  alertItems = Array.isArray(data && data.items) ? data.items : [];
  alertUnread = Number(data && data.unread) || 0;
  renderAlertBadge();
  if (alertPanelOpen()) renderAlertList();
}

function showAlertPanel() {
  hideCtxMenu();
  hideSrcMenu();
  if (!alertPanelEl) return;
  alertPanelEl.hidden = false;
  if (alertBtn) alertBtn.classList.add('open');
  renderAlertList();
}

function toggleAlertPanel() {
  if (alertPanelOpen()) hideAlertPanel();
  else showAlertPanel();
}

function applyProvider(id, label, short) {
  if (id === 'crypto') {
    currentProvider = 'crypto';
    srcBtn.textContent = short || '多源';
    srcBtn.title = `数据来源：${label || '币安 / Gate / OKX'}（谁先成功用谁，加密页不能手动切换）`;
    srcBtn.style.cursor = 'default';
    return;
  }
  const meta = providerMeta(id);
  currentProvider = meta.id;
  srcBtn.textContent = short || meta.short;
  srcBtn.title = `数据来源：${label || meta.label}（点击切换）`;
  srcBtn.style.cursor = 'pointer';
  srcMenuEl.querySelectorAll('button[data-provider]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === currentProvider);
  });
}

const SCALE_HIDE_MS = 3000;
let knownScalePct = null;
let scaleHideTimer = null;

function scalePercent(raw) {
  const n = Number(raw);
  const s = Number.isFinite(n) && n > 0 ? n : 1;
  return Math.round(s * 100);
}

function scaleLabelVisible() {
  return !!(scaleBtn && scaleBtn.classList.contains('on'));
}

function hideScaleLabel() {
  if (!scaleBtn) return;
  clearTimeout(scaleHideTimer);
  scaleHideTimer = null;
  scaleBtn.classList.remove('on');
  hideHoverTip();
}

function scheduleHideScale() {
  if (!scaleLabelVisible()) return;
  clearTimeout(scaleHideTimer);
  scaleHideTimer = setTimeout(() => {
    if (scaleBtn && scaleBtn.matches(':hover')) {
      scheduleHideScale();
      return;
    }
    hideScaleLabel();
  }, SCALE_HIDE_MS);
}

function revealScaleTemporarily() {
  if (!scaleBtn) return;
  scaleBtn.classList.add('on');
  scheduleHideScale();
}

function applyScaleLabel(raw, opts) {
  if (!scaleBtn) return;
  const pct = scalePercent(raw);
  const original = pct === 100;
  const changed = knownScalePct != null && pct !== knownScalePct;
  knownScalePct = pct;
  scaleBtn.textContent = original ? '100% 原始' : `${pct}%`;
  scaleBtn.classList.add('has-tip');
  scaleBtn.dataset.tip = original
    ? '原始大小 100% · Ctrl+滚轮缩放'
    : `当前 ${pct}%（原始 100%）· Ctrl+滚轮缩放 · 点击还原原始大小`;
  if ((opts && opts.reveal) || changed) revealScaleTemporarily();
}

function applyHint(suggestSwitch) {
  if (suggestSwitch) {
    hintEl.textContent = '暂无行情，点击切换数据来源';
    hintEl.classList.add('switch-hint');
    hintEl.title = '当前数据源没有返回行情，可改用腾讯或新浪试试';
  } else {
    hintEl.textContent = DEFAULT_HINT;
    hintEl.classList.remove('switch-hint');
    hintEl.title = '';
  }
}

function showSrcMenu() {
  hideCtxMenu();
  hideAlertPanel();
  srcMenuEl.hidden = false;
  const rect = srcBtn.getBoundingClientRect();
  const pad = 8;
  const x = Math.min(rect.left, window.innerWidth - srcMenuEl.offsetWidth - pad);
  const y = Math.min(rect.bottom + 4, window.innerHeight - srcMenuEl.offsetHeight - pad);
  srcMenuEl.style.left = `${Math.max(pad, x)}px`;
  srcMenuEl.style.top = `${Math.max(pad, y)}px`;
}

function onProviderClick(id) {
  if (!id) return;
  hideSrcMenu();
  if (id === currentProvider) return;
  applyProvider(id);
  applyHint(false);
  quotes = [];
  trends = null;
  render();
  renderIndex(null);
  drawChart();
  window.stockApi.setQuoteProvider(id);
}

function applyTheme(theme) {
  currentTheme = theme === 'moon' ? 'moon' : 'sun';
  document.documentElement.dataset.theme = currentTheme;
  themeBtn.dataset.tip = currentTheme === 'sun' ? '当前浅色，点击切换深色' : '当前深色，点击切换浅色';
  themeBtn.classList.add('has-tip');
  themeBtn.removeAttribute('title');
}

function applyMarket(market) {
  const next = normalizeMarket(market);
  const switched = currentMarket !== next;
  currentMarket = next;
  document.documentElement.dataset.market = currentMarket;
  marketCnBtn.classList.toggle('active', currentMarket === 'cn');
  marketUsBtn.classList.toggle('active', currentMarket === 'us');
  marketCryptoBtn.classList.toggle('active', currentMarket === 'crypto');
  indexSpec = specForMarket(currentMarket);
  indexNameEl.innerHTML = nameCellHtml(indexSpec.name, indexSpec.code);
  indexNameEl.dataset.tip = fullNameText(indexSpec.name, indexSpec.code);
  indexNameEl.classList.remove('has-tip');
  chartMetaEl.textContent =
    currentMarket === 'crypto' ? '24h' : currentMarket === 'us' ? '21:30-04:00' : '9:30-15:00';
  indexRowEl.dataset.secid = indexSecId();
  if (switched) {
    selectedSecId = indexSecId();
    scrollIndex = 0;
    quotes = [];
    trends = null;
  }
}

themeBtn.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

srcBtn.addEventListener('mousedown', (e) => e.stopPropagation());
srcMenuEl.addEventListener('mousedown', (e) => e.stopPropagation());
if (alertBtn) alertBtn.addEventListener('mousedown', (e) => e.stopPropagation());
if (alertPanelEl) alertPanelEl.addEventListener('mousedown', (e) => e.stopPropagation());
hintEl.addEventListener('mousedown', (e) => {
  if (hintEl.classList.contains('switch-hint')) e.stopPropagation();
});

srcBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  hideAlertPanel();
  if (currentMarket === 'crypto') return;
  if (srcMenuEl.hidden) showSrcMenu();
  else hideSrcMenu();
});

if (alertBtn) {
  alertBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAlertPanel();
  });
}

if (alertReadAllBtn) {
  alertReadAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (alertUnread <= 0) return;
    window.stockApi.markAllAlertsRead().then(applyAlerts).catch(() => {});
  });
}

if (alertListEl) {
  alertListEl.addEventListener('click', (e) => {
    const itemEl = e.target.closest && e.target.closest('.alert-item');
    if (!itemEl) return;
    e.stopPropagation();
    const id = itemEl.dataset.id;
    if (!id || itemEl.classList.contains('read')) return;
    window.stockApi.markAlertRead(id).then(applyAlerts).catch(() => {});
  });
}

srcMenuEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-provider]');
  if (!btn) return;
  e.stopPropagation();
  onProviderClick(btn.dataset.provider);
});

hintEl.addEventListener('click', (e) => {
  if (!hintEl.classList.contains('switch-hint')) return;
  e.stopPropagation();
  showSrcMenu();
});

themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const next = currentTheme === 'sun' ? 'moon' : 'sun';
  applyTheme(next);
  window.stockApi.setTheme(next);
});

function onMarketClick(market) {
  hideAlertPanel();
  if (currentMarket === market) return;
  applyMarket(market);
  render();
  renderIndex(null);
  drawChart();
  window.stockApi.setMarket(market);
}

marketCnBtn.addEventListener('mousedown', (e) => e.stopPropagation());
marketUsBtn.addEventListener('mousedown', (e) => e.stopPropagation());
marketCryptoBtn.addEventListener('mousedown', (e) => e.stopPropagation());
marketCnBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  onMarketClick('cn');
});
marketUsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  onMarketClick('us');
});
marketCryptoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  onMarketClick('crypto');
});

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nameCellHtml(name, code) {
  const n = escapeHtml(name || '--');
  const c = escapeHtml(code || '');
  return `<span class="name-text">${n}</span><span class="name-code">${c}</span>`;
}

function watchStarHtml(watched) {
  const on = watched ? ' on' : '';
  const title = watched ? '取消关注' : '关注';
  return `<button type="button" class="watch-star${on}" title="${title}" aria-label="${title}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.72 5.51 6.08.88-4.4 4.29 1.04 6.06L12 16.47 6.56 19.34l1.04-6.06-4.4-4.29 6.08-.88L12 2.6z"></path></svg></button>`;
}

function isBigMove(q) {
  return !!(q && q.watch && q.sudden);
}

function flashAlertRows(alerts) {
  if (!Array.isArray(alerts) || !alerts.length) return;
  alerts.forEach((item) => {
    if (item && item.secId) {
      flashSecIds.add(item.secId);
      return;
    }
    const q = quotes.find((row) => item && rowCode(row) === rowCode(item));
    if (q) flashSecIds.add(rowSecId(q));
  });
  render();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashSecIds.clear();
    render();
  }, 2800);
}

function fullNameText(name, code) {
  return `${name || ''} ${code || ''}`.trim();
}

function isTruncated(el) {
  if (!el) return false;
  return el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1;
}

function setTipIfTruncated(host, parts, tip) {
  if (!host) return;
  if (tip && parts.some(isTruncated)) host.classList.add('has-tip');
  else host.classList.remove('has-tip');
}

function hideHoverTip() {
  clearTimeout(hoverTipTimer);
  hoverTipTimer = null;
  if (hoverTipEl) hoverTipEl.hidden = true;
}

function placeHoverTip(host) {
  if (clickThroughPref) return;
  const text = host && host.dataset.tip;
  if (!text || !host.classList.contains('has-tip') || !hoverTipEl) return;
  hoverTipEl.textContent = text;
  hoverTipEl.hidden = false;
  const r = host.getBoundingClientRect();
  const pad = 6;
  const tw = hoverTipEl.offsetWidth;
  const th = hoverTipEl.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (top + th > window.innerHeight - pad) top = r.top - th - 4;
  if (left + tw > window.innerWidth - pad) left = window.innerWidth - tw - pad;
  hoverTipEl.style.left = `${Math.max(pad, left)}px`;
  hoverTipEl.style.top = `${Math.max(pad, top)}px`;
}

function scheduleHoverTip(host) {
  hideHoverTip();
  if (!host || dragging || clickThroughPref) return;
  hoverTipTimer = setTimeout(() => placeHoverTip(host), 420);
}

function applyTruncationTips() {
  listEl.querySelectorAll('.row:not(.missing-hint)').forEach((row) => {
    const nameEl = row.querySelector('.name');
    if (nameEl) {
      setTipIfTruncated(
        nameEl,
        [nameEl, nameEl.querySelector('.name-text'), nameEl.querySelector('.name-code')],
        nameEl.dataset.tip || ''
      );
    }
    const priceEl = row.querySelector('.price');
    if (priceEl) {
      setTipIfTruncated(
        priceEl,
        [priceEl, priceEl.querySelector('.price-now'), priceEl.querySelector('.price-cost')],
        priceEl.dataset.tip || ''
      );
    }
  });
  setTipIfTruncated(
    indexNameEl,
    [indexNameEl, indexNameEl.querySelector('.name-text'), indexNameEl.querySelector('.name-code')],
    indexNameEl.dataset.tip || ''
  );
}

function scheduleTruncationTips() {
  requestAnimationFrame(applyTruncationTips);
}

function positionPnlPct(q) {
  const cost = Number(q && q.cost);
  const price = Number(q && q.price);
  if (!(cost > 0) || !(price > 0)) return null;
  const move = (price - cost) / cost;
  if (q.kind === 'perp') {
    const dir = q.side === 'sell' ? -1 : 1;
    const lev = Number(q.leverage);
    const mult = Number.isFinite(lev) && lev >= 1 ? lev : 1;
    return move * dir * mult * 100;
  }
  return move * 100;
}

function formatPnlText(pnl) {
  if (!Number.isFinite(pnl)) return '';
  const sign = pnl > 0 ? '+' : '';
  return `${sign}${pnl.toFixed(2)}%`;
}

function priceHoverText(q) {
  const parts = [];
  const price = Number(q && q.price);
  if (Number.isFinite(price) && price > 0) parts.push(`现价 ${price.toFixed(2)}`);
  const cost = Number(q && q.cost);
  if (Number.isFinite(cost) && cost > 0) {
    const pnl = positionPnlPct(q);
    if (q.kind === 'perp') {
      const lev = Number(q.leverage);
      const levText = Number.isFinite(lev) && lev >= 1 ? `${lev}x` : '1x';
      const sideText = q.side === 'sell' ? '空' : '多';
      let s = `开仓 ${cost.toFixed(2)} ${levText}${sideText}`;
      if (Number.isFinite(pnl)) s += `(${formatPnlText(pnl)})`;
      parts.push(s);
    } else {
      let s = `成本 ${cost.toFixed(2)}`;
      if (Number.isFinite(pnl)) s += `(${formatPnlText(pnl)})`;
      parts.push(s);
    }
  }
  return parts.join('  ');
}

function formatQuote(q) {
  const pct = Number(q?.pct);
  const cls = !Number.isFinite(pct) || pct === 0 ? 'flat' : pct > 0 ? 'up' : 'down';
  const sign = Number.isFinite(pct) && pct > 0 ? '+' : '';
  const price = q?.price == null || q.price === '-' ? '--' : Number(q.price).toFixed(2);
  const pctText = Number.isFinite(pct) ? `${sign}${pct.toFixed(2)}%` : '--';
  return { cls, price, pctText };
}

function costCellHtml(q) {
  const cost = Number(q && q.cost);
  if (!Number.isFinite(cost) || cost <= 0) return '';
  const pnl = positionPnlPct(q);
  let pnlHtml = '';
  if (Number.isFinite(pnl)) {
    const cls = Math.abs(pnl) < 0.005 ? 'flat' : pnl > 0 ? 'up' : 'down';
    pnlHtml = `<span class="cost-pnl ${cls}">(${formatPnlText(pnl)})</span>`;
  }
  if (q.kind === 'perp') {
    const lev = Number(q.leverage);
    const levText = Number.isFinite(lev) && lev >= 1 ? `${lev}x` : '1x';
    const sideText = q.side === 'sell' ? '空' : '多';
    return `<span class="price-cost">${levText}${sideText} ${cost.toFixed(2)}${pnlHtml}</span>`;
  }
  return `<span class="price-cost">成本 ${cost.toFixed(2)}${pnlHtml}</span>`;
}

function renderIndex(index) {
  const { cls, price, pctText } = formatQuote(index);
  indexPriceEl.textContent = price;
  indexPctEl.textContent = pctText;
  indexPctEl.className = `pct ${cls}`;
  if (index && (index.name || index.code || index.secId)) {
    indexSpec = {
      secId: index.secId || indexSpec.secId,
      name: index.name || indexSpec.name,
      code: index.code || indexSpec.code
    };
    indexNameEl.innerHTML = nameCellHtml(indexSpec.name, indexSpec.code);
    indexNameEl.dataset.tip = fullNameText(indexSpec.name, indexSpec.code);
    indexNameEl.classList.remove('has-tip');
    indexRowEl.dataset.secid = indexSpec.secId;
  }
  indexRowEl.classList.toggle('active', selectedSecId === indexSecId());
  scheduleTruncationTips();
}

function isMissingQuote(q) {
  return !!(q && q.missing) || q?.price == null || q?.price === '-' || !Number.isFinite(Number(q?.price));
}

function listItemCount() {
  return quotes.length + (quotes.some(isMissingQuote) ? 1 : 0);
}

function render() {
  hideHoverTip();
  listEl.innerHTML = '';
  quotes.forEach((q) => {
    const row = document.createElement('div');
    const secId = rowSecId(q);
    const watched = !!q.watch;
    row.className = 'row'
      + (secId === selectedSecId ? ' active' : '')
      + (watched ? ' watched' : '')
      + (isBigMove(q) ? ' big-move' : '')
      + (flashSecIds.has(secId) ? ' alert-flash' : '');
    row.dataset.secid = secId;
    row.dataset.code = rowCode(q);
    const { cls, price, pctText } = formatQuote(q);
    const costHtml = costCellHtml(q);
    const full = fullNameText(q.name, rowCodeLabel(q));
    const priceTip = priceHoverText(q);
    row.innerHTML = `
      <div class="name" data-tip="${escapeHtml(full)}">${nameCellHtml(q.name, rowCodeLabel(q))}${watchStarHtml(watched)}</div>
      <div class="price${costHtml ? ' has-cost' : ''}"${priceTip ? ` data-tip="${escapeHtml(priceTip)}"` : ''}><span class="price-now">${price}</span>${costHtml}</div>
      <div class="pct ${cls}">${pctText}</div>
    `;
    listEl.appendChild(row);
  });

  if (quotes.some(isMissingQuote)) {
    const hint = document.createElement('div');
    hint.className = 'row missing-hint';
    hint.textContent = '部分数据未查询到';
    listEl.appendChild(hint);
  }

  const maxScroll = Math.max(0, listItemCount() - VISIBLE);
  scrollIndex = Math.min(scrollIndex, maxScroll);
  listEl.style.transform = `translateY(${-scrollIndex * ROW_H}px)`;
  scheduleTruncationTips();
}

function timeToX(time) {
  const parts = String(time).split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  const t = hh * 60 + mm;
  if (currentMarket === 'us') {
    const start = 21 * 60 + 30;
    const span = 6 * 60 + 30;
    const elapsed = t >= start ? t - start : 24 * 60 - start + t;
    return Math.max(0, Math.min(1, elapsed / span));
  }
  const am = 9 * 60 + 30;
  const noon = 11 * 60 + 30;
  const pm = 13 * 60;
  if (t <= noon) return Math.max(0, Math.min(1, (t - am) / 120)) * 0.5;
  return 0.5 + Math.max(0, Math.min(1, (t - pm) / 120)) * 0.5;
}

function cryptoKindLabel(secId, q) {
  if (q && q.kindLabel) return q.kindLabel;
  if (q && q.kind === 'perp') return '永续';
  const s = String(secId || q?.code || '');
  if (s.endsWith('.perp') || s.endsWith('-PERP') || s.endsWith('PERP')) return '永续';
  return '现货';
}

function nameForSecId(secId) {
  if (!secId) return indexSpec.name;
  const q = quotes.find((item) => rowSecId(item) === secId);
  if (q) {
    if (currentMarket === 'crypto') return `${q.name || q.code} ${cryptoKindLabel(secId, q)}`.trim();
    return q.name || q.code;
  }
  if (secId === indexSpec.secId) {
    if (currentMarket === 'crypto') {
      return `${indexSpec.name || '比特币'} ${cryptoKindLabel(secId)}`.trim();
    }
    return indexSpec.name;
  }
  if (trends && trends.secId === secId) {
    if (currentMarket === 'crypto') {
      return `${trends.name || indexSpec.name} ${cryptoKindLabel(secId, trends)}`.trim();
    }
    return trends.name || indexSpec.name;
  }
  return indexSpec.name;
}

function flashChart() {
  const head = document.getElementById('chart-head');
  [head, chartEl].forEach((el) => {
    if (!el) return;
    el.classList.remove('refreshing');
    void el.offsetWidth;
    el.classList.add('refreshing');
  });
}

function selectLocal(secId) {
  selectedSecId = secId;
  if (trends && trends.secId !== secId) trends = null;
  render();
  indexRowEl.classList.toggle('active', selectedSecId === indexSecId());
  drawChart();
  flashChart();
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const width = chartEl.clientWidth || 300;
  const height = chartEl.clientHeight || 78;
  chartEl.width = Math.round(width * dpr);
  chartEl.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const active = trends && trends.secId === selectedSecId ? trends : null;
  const points = active?.points || [];
  const preClose = Number(active?.preClose);
  const trendName = nameForSecId(selectedSecId);
  chartTitleEl.textContent = `分时 · ${trendName || '--'}`;

  if (!points.length || !Number.isFinite(preClose)) {
    ctx.fillStyle = 'rgba(234, 238, 245, 0.45)';
    ctx.font = '11px Microsoft YaHei';
    ctx.textAlign = 'center';
    ctx.fillText('暂无分时数据', width / 2, height / 2 + 4);
    return;
  }

  const prices = points.map((p) => p.price);
  const avgs = points.map((p) => p.avg).filter((n) => Number.isFinite(n));
  let min = Math.min(preClose, ...prices, ...avgs);
  let max = Math.max(preClose, ...prices, ...avgs);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.16;
  min -= pad;
  max += pad;

  const left = 2;
  const right = width - 2;
  const top = 6;
  const bottom = height - 14;
  const plotW = right - left;
  const plotH = bottom - top;

  const xAtPoint = (p) => {
    if (currentMarket === 'crypto' && Number.isFinite(p.t) && points.length) {
      const t0 = points[0].t;
      const t1 = points[points.length - 1].t;
      const span = Math.max(t1 - t0, 1);
      return left + ((p.t - t0) / span) * plotW;
    }
    return left + timeToX(p.time) * plotW;
  };
  const yAt = (price) => top + ((max - price) / (max - min)) * plotH;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const midX = currentMarket === 'us' ? left + plotW * ((3.5 * 60) / (6.5 * 60)) : left + plotW * 0.5;
  ctx.moveTo(midX, top);
  ctx.lineTo(midX, bottom);
  ctx.stroke();

  const preY = yAt(preClose);
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.moveTo(left, preY);
  ctx.lineTo(right, preY);
  ctx.stroke();
  ctx.setLineDash([]);

  const last = points[points.length - 1].price;
  const up = last >= preClose;
  const stroke = isGreenUpMarket()
    ? (up ? '#3ddc84' : '#ff6b6e')
    : (up ? '#ff6b6e' : '#3ddc84');
  const fill = isGreenUpMarket()
    ? (up ? 'rgba(61, 220, 132, 0.18)' : 'rgba(255, 107, 110, 0.22)')
    : (up ? 'rgba(255, 107, 110, 0.22)' : 'rgba(61, 220, 132, 0.18)');

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAtPoint(p);
    const y = yAt(p.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const lastX = xAtPoint(points[points.length - 1]);
  ctx.lineTo(lastX, preY);
  ctx.lineTo(xAtPoint(points[0]), preY);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAtPoint(p);
    const y = yAt(p.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  const avgPoints = points.filter((p) => Number.isFinite(p.avg));
  if (avgPoints.length > 1) {
    ctx.beginPath();
    avgPoints.forEach((p, i) => {
      const x = xAtPoint(p);
      const y = yAt(p.avg);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(255, 196, 90, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(234, 238, 245, 0.45)';
  ctx.font = '10px Microsoft YaHei';
  ctx.textAlign = 'left';
  const startLabel = currentMarket === 'crypto'
    ? (points[0].time || '24h')
    : currentMarket === 'us' ? '21:30' : '9:30';
  const midLabel = currentMarket === 'crypto'
    ? (points[Math.floor(points.length / 2)].time || '')
    : currentMarket === 'us' ? '01:00' : '11:30/13:00';
  const endLabel = currentMarket === 'crypto'
    ? (points[points.length - 1].time || '')
    : currentMarket === 'us' ? '04:00' : '15:00';
  ctx.fillText(startLabel, left, height - 2);
  ctx.textAlign = 'center';
  ctx.fillText(midLabel, left + plotW * 0.5, height - 2);
  ctx.textAlign = 'right';
  ctx.fillText(endLabel, right, height - 2);
}

window.stockApi.onAlertsChanged((data) => applyAlerts(data));

window.stockApi.onQuotesUpdate((data) => {
  if (data.market) applyMarket(data.market);
  if (data.indexSpec) indexSpec = data.indexSpec;
  if (data.quoteProvider) applyProvider(data.quoteProvider, data.quoteProviderLabel, data.quoteProviderShort);
  applyHint(!!data.suggestSwitch);
  quotes = data.quotes || [];
  if (data.selectedSecId) selectedSecId = data.selectedSecId;
  if (data.trends && (!data.trends.secId || data.trends.secId === selectedSecId)) {
    trends = data.trends;
  }
  if (Number.isFinite(data.focusIndex)) {
    const i = data.focusIndex;
    if (i < scrollIndex) scrollIndex = i;
    if (i >= scrollIndex + VISIBLE) scrollIndex = i - VISIBLE + 1;
  }
  render();
  renderIndex(data.index);
  drawChart();
  flashAlertRows(data.alerts);
});

function resetPointerState() {
  hover = false;
  dragging = false;
  dragMoved = false;
  pendingSecId = null;
  hideCtxMenu();
  hideSrcMenu();
  hideAlertPanel();
  panelEl.style.cursor = 'grab';
  window.stockApi.setPointerOver(false);
}

function isOverPanel(target) {
  return !!(panelEl && (target === panelEl || panelEl.contains(target)));
}

function findSecId(target) {
  const row = target && target.closest ? target.closest('.row[data-secid]') : null;
  return row ? row.dataset.secid : null;
}

window.stockApi.onClickThroughChanged((enabled, pref) => {
  statusEl.textContent = enabled ? '穿透' : '可交互';
  clickThroughPref = typeof pref === 'boolean' ? pref : !!enabled;
  if (clickThroughPref) hideHoverTip();
});

window.stockApi.onWidgetReset(() => {
  hideHoverTip();
  resetPointerState();
});

window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    if (window.stockApi && window.stockApi.nudgeScale) {
      window.stockApi.nudgeScale(e.deltaY > 0 ? -1 : 1)
        .then((s) => applyScaleLabel(s, { reveal: true }))
        .catch(() => {});
    }
    return;
  }
  if (alertPanelOpen()) {
    if (alertListEl && alertListEl.contains(e.target)) return;
    e.preventDefault();
    return;
  }
  e.preventDefault();
  const maxScroll = Math.max(0, listItemCount() - VISIBLE);
  if (maxScroll === 0) return;
  scrollIndex += e.deltaY > 0 ? 1 : -1;
  scrollIndex = Math.max(0, Math.min(maxScroll, scrollIndex));
  render();
}, { passive: false });

const ctxMenuEl = document.getElementById('ctx-menu');
let ctxCode = null;

function hideCtxMenu() {
  ctxMenuEl.hidden = true;
  ctxCode = null;
}

async function showCtxMenu(e, code) {
  hideHoverTip();
  hideAlertPanel();
  const info = await window.stockApi.getStockOrder(code);
  if (!info || info.index < 0) return;
  ctxCode = code;
  ctxMenuEl.querySelector('[data-action="top"]').disabled = info.index === 0;
  ctxMenuEl.querySelector('[data-action="up"]').disabled = info.index === 0;
  ctxMenuEl.querySelector('[data-action="down"]').disabled = info.index >= info.total - 1;
  ctxMenuEl.hidden = false;
  const pad = 8;
  const x = Math.min(e.clientX, window.innerWidth - ctxMenuEl.offsetWidth - pad);
  const y = Math.min(e.clientY, window.innerHeight - ctxMenuEl.offsetHeight - pad);
  ctxMenuEl.style.left = `${Math.max(pad, x)}px`;
  ctxMenuEl.style.top = `${Math.max(pad, y)}px`;
}

ctxMenuEl.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

ctxMenuEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled || !ctxCode) return;
  window.stockApi.reorderStock(ctxCode, btn.dataset.action);
  hideCtxMenu();
});

listEl.addEventListener('mousedown', (e) => {
  if (!(e.target.closest && e.target.closest('.watch-star'))) return;
  e.stopPropagation();
}, true);

listEl.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.watch-star');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const row = btn.closest('.row[data-code]');
  const code = row && row.dataset.code;
  if (!code) return;
  window.stockApi.toggleWatch(code).then((res) => {
    const q = quotes.find((item) => rowCode(item) === code);
    if (q) q.watch = !!(res && res.watch);
    render();
  }).catch(() => {});
}, true);

panelEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest ? e.target.closest('#list .row[data-code]') : null;
  if (!row) {
    hideCtxMenu();
    return;
  }
  e.preventDefault();
  showCtxMenu(e, row.dataset.code);
});

ctxMenuEl.addEventListener('mouseenter', () => {
  hover = true;
  syncPointerOver();
});

ctxMenuEl.addEventListener('mouseleave', (e) => {
  if (panelEl.contains(e.relatedTarget)) return;
  hideCtxMenu();
  hover = false;
  if (!dragging) syncPointerOver();
});

srcMenuEl.addEventListener('mouseenter', () => {
  hover = true;
  syncPointerOver();
});

srcMenuEl.addEventListener('mouseleave', (e) => {
  if (panelEl.contains(e.relatedTarget)) return;
  hideSrcMenu();
  hover = false;
  if (!dragging) syncPointerOver();
});

window.addEventListener('mousedown', (e) => {
  if (!ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) hideCtxMenu();
  if (!srcMenuEl.hidden && !srcMenuEl.contains(e.target) && e.target !== srcBtn) hideSrcMenu();
  if (alertPanelOpen() && alertPanelEl && !alertPanelEl.contains(e.target)
    && alertBtn && !alertBtn.contains(e.target)) {
    hideAlertPanel();
  }
}, true);

panelEl.addEventListener('mouseenter', () => {
  hover = true;
  syncPointerOver();
});

panelEl.addEventListener('mouseleave', (e) => {
  if (ctxMenuEl.contains(e.relatedTarget) || srcMenuEl.contains(e.relatedTarget)) return;
  hideHoverTip();
  hover = false;
  if (!dragging && ctxMenuEl.hidden && srcMenuEl.hidden) syncPointerOver();
});

panelEl.addEventListener('mouseover', (e) => {
  const host = e.target.closest && e.target.closest('.has-tip');
  if (!host) return;
  scheduleHoverTip(host);
});

panelEl.addEventListener('mouseout', (e) => {
  const from = e.target.closest && e.target.closest('.has-tip');
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.has-tip');
  if (from && from !== to) hideHoverTip();
});

window.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;
  hover = false;
  if (!dragging) syncPointerOver();
});

panelEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  hideHoverTip();
  if (e.target.closest && (e.target.closest('#theme-btn') || e.target.closest('#market-switch') || e.target.closest('#src-btn') || e.target.closest('#src-menu') || e.target.closest('#alert-btn') || e.target.closest('#alert-panel') || e.target.closest('#scale-btn') || e.target.closest('.watch-star'))) return;
  dragging = true;
  dragMoved = false;
  pendingSecId = findSecId(e.target);
  dragStart = { x: e.screenX, y: e.screenY };
  panelEl.style.cursor = 'grabbing';
  syncPointerOver();
});

window.addEventListener('mousemove', (e) => {
  if (!hover && isOverPanel(e.target)) {
    hover = true;
    syncPointerOver();
  }
  if (!dragging) return;
  const dx = e.screenX - dragStart.x;
  const dy = e.screenY - dragStart.y;
  if (!dragMoved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
    dragMoved = true;
  }
  if (dragMoved && (dx || dy)) {
    window.stockApi.moveWindow(dx, dy);
    dragStart = { x: e.screenX, y: e.screenY };
  }
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  if (!dragMoved && pendingSecId) {
    selectLocal(pendingSecId);
    window.stockApi.selectTrend(pendingSecId);
  }
  dragging = false;
  dragMoved = false;
  pendingSecId = null;
  panelEl.style.cursor = 'grab';
  syncPointerOver();
});

window.addEventListener('resize', () => {
  drawChart();
  if (scaleLabelVisible()) scheduleHideScale();
});
if (scaleBtn) {
  scaleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  scaleBtn.addEventListener('mouseleave', () => {
    if (scaleLabelVisible()) scheduleHideScale();
  });
  scaleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (knownScalePct === 100) return;
    window.stockApi.setScale(1).then((s) => applyScaleLabel(s, { reveal: true })).catch(() => {});
  });
}

window.stockApi.onScaleChanged((scale) => applyScaleLabel(scale));
window.stockApi.getConfig().then((cfg) => {
  savedCfg = cfg || null;
  clickThroughPref = !!(cfg && cfg.clickThrough);
  applyTheme(cfg && cfg.theme);
  applyMarket(cfg && cfg.market);
  applyProvider(cfg && cfg.quoteProvider);
  applyScaleLabel(cfg && cfg.scale);
});
window.stockApi.getAlerts().then(applyAlerts).catch(() => {});
