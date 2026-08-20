const ROW_H = 28;
const VISIBLE = 3;
const DEFAULT_CN_INDEX = { secId: '1.000001', name: '上证指数', code: '000001' };
const DEFAULT_US_INDEX = { secId: '100.NDX', name: '纳斯达克100', code: 'NDX' };
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

function specForMarket(market) {
  const us = market === 'us';
  return parseIndexSpec(us ? savedCfg?.usIndex : savedCfg?.cnIndex, us ? DEFAULT_US_INDEX : DEFAULT_CN_INDEX);
}

function indexSecId() {
  return indexSpec.secId;
}

function rowSecId(q) {
  if (q?.secId) return q.secId;
  const c = String(q?.code || '').replace(/\D/g, '').padStart(6, '0');
  return `${c.startsWith('6') ? '1' : '0'}.${c}`;
}

function rowCode(q) {
  if (currentMarket === 'us') return String(q.code || '').toUpperCase();
  return String(q.code).replace(/\D/g, '').padStart(6, '0');
}

function syncPointerOver() {
  window.stockApi.setPointerOver(hover || dragging);
}

const listEl = document.getElementById('list');
const panelEl = document.getElementById('panel');
const statusEl = document.getElementById('status');
const clockEl = document.getElementById('clock');

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
const hintEl = document.getElementById('hint');
const marketCnBtn = document.getElementById('market-cn');
const marketUsBtn = document.getElementById('market-us');
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
const PROVIDERS = [
  { id: 'eastmoney', label: '东方财富', short: '东财' },
  { id: 'tencent', label: '腾讯财经', short: '腾讯' },
  { id: 'sina', label: '新浪财经', short: '新浪' }
];
const DEFAULT_HINT = '左键看分时 · 右键调顺序 · 拖动窗口';

function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

function hideSrcMenu() {
  srcMenuEl.hidden = true;
}

function applyProvider(id, label, short) {
  const meta = providerMeta(id);
  currentProvider = meta.id;
  srcBtn.textContent = short || meta.short;
  srcBtn.title = `数据来源：${label || meta.label}（点击切换）`;
  srcMenuEl.querySelectorAll('button[data-provider]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === currentProvider);
  });
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
  themeBtn.title = currentTheme === 'sun' ? '当前浅色，点击切换深色' : '当前深色，点击切换浅色';
}

function applyMarket(market) {
  const next = market === 'us' ? 'us' : 'cn';
  const switched = currentMarket !== next;
  currentMarket = next;
  document.documentElement.dataset.market = currentMarket;
  marketCnBtn.classList.toggle('active', currentMarket === 'cn');
  marketUsBtn.classList.toggle('active', currentMarket === 'us');
  indexSpec = specForMarket(currentMarket);
  indexNameEl.innerHTML = nameCellHtml(indexSpec.name, indexSpec.code);
  chartMetaEl.textContent = currentMarket === 'us' ? '21:30-04:00' : '9:30-15:00';
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
hintEl.addEventListener('mousedown', (e) => {
  if (hintEl.classList.contains('switch-hint')) e.stopPropagation();
});

srcBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (srcMenuEl.hidden) showSrcMenu();
  else hideSrcMenu();
});

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
  if (currentMarket === market) return;
  applyMarket(market);
  render();
  renderIndex(null);
  drawChart();
  window.stockApi.setMarket(market);
}

marketCnBtn.addEventListener('mousedown', (e) => e.stopPropagation());
marketUsBtn.addEventListener('mousedown', (e) => e.stopPropagation());
marketCnBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  onMarketClick('cn');
});
marketUsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  onMarketClick('us');
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

function formatQuote(q) {
  const pct = Number(q?.pct);
  const cls = !Number.isFinite(pct) || pct === 0 ? 'flat' : pct > 0 ? 'up' : 'down';
  const sign = Number.isFinite(pct) && pct > 0 ? '+' : '';
  const price = q?.price == null || q.price === '-' ? '--' : Number(q.price).toFixed(2);
  const pctText = Number.isFinite(pct) ? `${sign}${pct.toFixed(2)}%` : '--';
  return { cls, price, pctText };
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
    indexRowEl.dataset.secid = indexSpec.secId;
  }
  indexRowEl.classList.toggle('active', selectedSecId === indexSecId());
}

function isMissingQuote(q) {
  return !!(q && q.missing) || q?.price == null || q?.price === '-' || !Number.isFinite(Number(q?.price));
}

function listItemCount() {
  return quotes.length + (quotes.some(isMissingQuote) ? 1 : 0);
}

function render() {
  listEl.innerHTML = '';
  quotes.forEach((q) => {
    const row = document.createElement('div');
    const secId = rowSecId(q);
    row.className = 'row' + (secId === selectedSecId ? ' active' : '');
    row.dataset.secid = secId;
    row.dataset.code = rowCode(q);
    const { cls, price, pctText } = formatQuote(q);
    const full = `${q.name || ''} ${q.code || ''}`.trim();
    row.innerHTML = `
      <div class="name" title="${escapeHtml(full)}">${nameCellHtml(q.name, q.code)}</div>
      <div class="price">${price}</div>
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

function nameForSecId(secId) {
  if (!secId) return indexSpec.name;
  if (secId === indexSpec.secId || secId === indexSpec.code) return indexSpec.name;
  const q = quotes.find((item) => rowSecId(item) === secId);
  if (q) return q.name || q.code;
  if (trends && (trends.secId === secId || trends.code === indexSpec.code)) {
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

  const xAt = (time) => left + timeToX(time) * plotW;
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
  const stroke = currentMarket === 'us'
    ? (up ? '#3ddc84' : '#ff6b6e')
    : (up ? '#ff6b6e' : '#3ddc84');
  const fill = currentMarket === 'us'
    ? (up ? 'rgba(61, 220, 132, 0.18)' : 'rgba(255, 107, 110, 0.22)')
    : (up ? 'rgba(255, 107, 110, 0.22)' : 'rgba(61, 220, 132, 0.18)');

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(p.time);
    const y = yAt(p.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const lastX = xAt(points[points.length - 1].time);
  ctx.lineTo(lastX, preY);
  ctx.lineTo(xAt(points[0].time), preY);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(p.time);
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
      const x = xAt(p.time);
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
  ctx.fillText(currentMarket === 'us' ? '21:30' : '9:30', left, height - 2);
  ctx.textAlign = 'center';
  ctx.fillText(currentMarket === 'us' ? '01:00' : '11:30/13:00', left + plotW * 0.5, height - 2);
  ctx.textAlign = 'right';
  ctx.fillText(currentMarket === 'us' ? '04:00' : '15:00', right, height - 2);
}

window.stockApi.onQuotesUpdate((data) => {
  if (data.market) applyMarket(data.market);
  if (data.indexSpec) indexSpec = data.indexSpec;
  if (data.quoteProvider) applyProvider(data.quoteProvider, data.quoteProviderLabel, data.quoteProviderShort);
  applyHint(!!data.suggestSwitch);
  quotes = data.quotes || [];
  if (data.selectedSecId) selectedSecId = data.selectedSecId;
  trends = data.trends || trends;
  if (Number.isFinite(data.focusIndex)) {
    const i = data.focusIndex;
    if (i < scrollIndex) scrollIndex = i;
    if (i >= scrollIndex + VISIBLE) scrollIndex = i - VISIBLE + 1;
  }
  render();
  renderIndex(data.index);
  drawChart();
});

function resetPointerState() {
  hover = false;
  dragging = false;
  dragMoved = false;
  pendingSecId = null;
  hideCtxMenu();
  hideSrcMenu();
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

window.stockApi.onClickThroughChanged((enabled) => {
  statusEl.textContent = enabled ? '穿透' : '可交互';
});

window.stockApi.onWidgetReset(() => {
  resetPointerState();
});

window.addEventListener('wheel', (e) => {
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
}, true);

panelEl.addEventListener('mouseenter', () => {
  hover = true;
  syncPointerOver();
});

panelEl.addEventListener('mouseleave', (e) => {
  if (ctxMenuEl.contains(e.relatedTarget) || srcMenuEl.contains(e.relatedTarget)) return;
  hover = false;
  if (!dragging && ctxMenuEl.hidden && srcMenuEl.hidden) syncPointerOver();
});

window.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;
  hover = false;
  if (!dragging) syncPointerOver();
});

panelEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest && (e.target.closest('#theme-btn') || e.target.closest('#market-switch') || e.target.closest('#src-btn') || e.target.closest('#src-menu'))) return;
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

window.addEventListener('resize', () => drawChart());
window.stockApi.getConfig().then((cfg) => {
  savedCfg = cfg || null;
  applyTheme(cfg && cfg.theme);
  applyMarket(cfg && cfg.market);
  applyProvider(cfg && cfg.quoteProvider);
});
