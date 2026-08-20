const ROW_H = 28;
const VISIBLE = 3;
const INDEX_SECID = '1.000001';
const DRAG_THRESHOLD = 5;

let quotes = [];
let scrollIndex = 0;
let dragging = false;
let dragMoved = false;
let hover = false;
let dragStart = { x: 0, y: 0 };
let pendingSecId = null;
let selectedSecId = INDEX_SECID;
let trends = null;

function toSecId(code) {
  const c = String(code).replace(/\D/g, '').padStart(6, '0');
  return `${c.startsWith('6') ? '1' : '0'}.${c}`;
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
let currentTheme = 'sun';

function applyTheme(theme) {
  currentTheme = theme === 'moon' ? 'moon' : 'sun';
  document.documentElement.dataset.theme = currentTheme;
  themeBtn.title = currentTheme === 'sun' ? '当前浅色，点击切换深色' : '当前深色，点击切换浅色';
}

themeBtn.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const next = currentTheme === 'sun' ? 'moon' : 'sun';
  applyTheme(next);
  window.stockApi.setTheme(next);
});
const indexRowEl = document.getElementById('index-row');
const indexPriceEl = document.getElementById('index-price');
const indexPctEl = document.getElementById('index-pct');
const chartEl = document.getElementById('chart');
const chartTitleEl = document.getElementById('chart-title');
const ctx = chartEl.getContext('2d');

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
  indexRowEl.classList.toggle('active', selectedSecId === INDEX_SECID);
}

function render() {
  listEl.innerHTML = '';
  quotes.forEach((q) => {
    const row = document.createElement('div');
    const secId = toSecId(q.code);
    row.className = 'row' + (secId === selectedSecId ? ' active' : '');
    row.dataset.secid = secId;
    row.dataset.code = String(q.code).padStart(6, '0');
    const { cls, price, pctText } = formatQuote(q);
    row.innerHTML = `
      <div class="name" title="${q.name} (${q.code})">${q.name}</div>
      <div class="price">${price}</div>
      <div class="pct ${cls}">${pctText}</div>
    `;
    listEl.appendChild(row);
  });

  const maxScroll = Math.max(0, quotes.length - VISIBLE);
  scrollIndex = Math.min(scrollIndex, maxScroll);
  listEl.style.transform = `translateY(${-scrollIndex * ROW_H}px)`;
}

function timeToX(time) {
  const parts = String(time).split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
  const t = hh * 60 + mm;
  const am = 9 * 60 + 30;
  const noon = 11 * 60 + 30;
  const pm = 13 * 60;
  if (t <= noon) return Math.max(0, Math.min(1, (t - am) / 120)) * 0.5;
  return 0.5 + Math.max(0, Math.min(1, (t - pm) / 120)) * 0.5;
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const width = chartEl.clientWidth || 300;
  const height = chartEl.clientHeight || 78;
  chartEl.width = Math.round(width * dpr);
  chartEl.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = trends?.points || [];
  const preClose = Number(trends?.preClose);
  chartTitleEl.textContent = `分时 · ${trends?.name || '上证指数'}`;

  if (!points.length || !Number.isFinite(preClose)) {
    ctx.fillStyle = 'rgba(234, 238, 245, 0.45)';
    ctx.font = '11px Microsoft YaHei';
    ctx.textAlign = 'center';
    ctx.fillText('暂无分时数据', width / 2, height / 2 + 4);
    return;
  }

  const prices = points.map((p) => p.price);
  let min = Math.min(preClose, ...prices);
  let max = Math.max(preClose, ...prices);
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
  ctx.moveTo(left + plotW * 0.5, top);
  ctx.lineTo(left + plotW * 0.5, bottom);
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
  const stroke = up ? '#ff6b6e' : '#3ddc84';
  const fill = up ? 'rgba(255, 107, 110, 0.22)' : 'rgba(61, 220, 132, 0.18)';

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
  ctx.fillText('9:30', left, height - 2);
  ctx.textAlign = 'center';
  ctx.fillText('11:30/13:00', left + plotW * 0.5, height - 2);
  ctx.textAlign = 'right';
  ctx.fillText('15:00', right, height - 2);
}

window.stockApi.onQuotesUpdate((data) => {
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
  const maxScroll = Math.max(0, quotes.length - VISIBLE);
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

window.addEventListener('mousedown', (e) => {
  if (!ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) hideCtxMenu();
}, true);

panelEl.addEventListener('mouseenter', () => {
  hover = true;
  syncPointerOver();
});

panelEl.addEventListener('mouseleave', (e) => {
  if (ctxMenuEl.contains(e.relatedTarget)) return;
  hover = false;
  if (!dragging && ctxMenuEl.hidden) syncPointerOver();
});

panelEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('#theme-btn')) return;
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
  applyTheme(cfg && cfg.theme);
});
