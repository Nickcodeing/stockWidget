const listEl = document.getElementById('list');
const readAllBtn = document.getElementById('read-all');
let unread = 0;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function formatSpan(ms) {
  const s = Math.max(1, Math.round(Number(ms) / 1000));
  if (s < 90) return `${s}秒`;
  if (s >= 50 * 60) return `${Math.max(1, Math.round(s / 3600))}小时`;
  return `${Math.max(1, Math.round(s / 60))}分钟`;
}

function formatGear(item) {
  const lev = Number(item && item.leverage);
  if (!(lev >= 1) || lev === 1) return '';
  const side = String(item && item.side || '').toLowerCase();
  const sideText = side === 'sell' || side === 'short' ? '空'
    : side === 'buy' || side === 'long' ? '多' : '';
  return `${lev}x${sideText} `;
}

function formatTime(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function render(data) {
  const items = Array.isArray(data && data.items) ? data.items : [];
  unread = Number(data && data.unread) || 0;
  document.documentElement.dataset.theme = data && data.theme === 'moon' ? 'moon' : 'sun';
  if (readAllBtn) readAllBtn.disabled = unread <= 0;
  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = '<div class="empty">暂无提醒</div>';
    return;
  }
  listEl.innerHTML = items.map((item) => {
    const dir = item.dir === 'down' ? 'down' : 'up';
    const action = item.grind
      ? (dir === 'down' ? '持续下挫' : '持续拉升')
      : (dir === 'down' ? '突然下挫' : '突然拉升');
    const span = item.gap ? '跳空' : `约${formatSpan(item.spanMs)}`;
    const price = Number(item.price);
    const priceText = Number.isFinite(price) && price > 0 ? `  ${price.toFixed(2)}` : '';
    const name = [item.marketLabel, item.name || item.code].filter(Boolean).join(' · ');
    return `<button type="button" class="alert-item${item.read ? ' read' : ''}" data-id="${escapeHtml(item.id)}" data-market="${escapeHtml(item.market || 'cn')}">
      <span class="alert-dot"></span>
      <span class="alert-main">
        <span class="alert-top">
          <span class="alert-name">${escapeHtml(name)}</span>
          <span class="alert-time">${escapeHtml(formatTime(item.t))}</span>
        </span>
        <span class="alert-body"><span class="alert-move ${dir}">${action}</span>${escapeHtml(`${span} ${formatGear(item)}${formatPct(item.movePct)}${priceText}`)}</span>
      </span>
    </button>`;
  }).join('');
}

if (readAllBtn) {
  readAllBtn.addEventListener('click', () => {
    if (unread <= 0) return;
    window.alertPopApi.markAllAlertsRead().then(render).catch(() => {});
  });
}

if (listEl) {
  listEl.addEventListener('click', (e) => {
    const itemEl = e.target.closest && e.target.closest('.alert-item');
    if (!itemEl || itemEl.classList.contains('read')) return;
    const id = itemEl.dataset.id;
    if (!id) return;
    window.alertPopApi.markAlertRead(id).then(render).catch(() => {});
  });
}

window.alertPopApi.onAlertsChanged(render);
window.alertPopApi.getAlerts().then(render).catch(() => {});
