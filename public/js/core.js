// Shared front-end plumbing: API calls, formatting, routing, page shell, toasts and dialogs.
import { phoneIn, maskPhones } from './phone.js';
export const state = { me: null, counts: {} };

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const num = (n) => Number(n || 0).toLocaleString('en-PK');
export const rs = (n) => 'Rs ' + num(n);
export const priceText = (o) => (o.exact ? rs(o.price) : `${rs(o.low)} – ${num(o.high)}`);
export const modelName = (m) => (m ? `${m.brand} ${m.name}` : '');
export const catLabel = { panel: 'Solar panel', inverter: 'Inverter', battery: 'Battery', structure: 'Structure', cable: 'Cable', accessory: 'Accessory' };
export const typeLabel = { importer: 'Importer', distributor: 'Distributor', wholesaler: 'Wholesaler' };

export function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
export function until(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return 'closed';
  if (s < 3600) return `closes in ${Math.max(1, Math.round(s / 60))} min`;
  return `closes in ${Math.round(s / 3600)} h`;
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const phoneText = (p) => String(p || '').replace(/^0(\d{3})(\d{7})$/, '+92 $1 $2');
export function day(d) {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
export function freshness(staleDays, iso) {
  if (staleDays === 0) return { text: `confirmed ${ago(iso)}`, cls: '' };
  if (staleDays <= 2) return { text: `confirmed ${ago(iso)}`, cls: '' };
  return { text: `not confirmed for ${staleDays} days`, cls: 'amber' };
}
export const todayISO = () => new Date().toISOString().slice(0, 10);

export async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth')) { state.me = null; location.hash = '#/login'; }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status; err.code = data.code; err.data = data;
    throw err;
  }
  return data;
}

// ---------- phone numbers stay on Kainat ----------
// The warning shown when a message with a phone number is refused. Resolves 'mask' (send it without the number)
// or 'edit' (go back and change it).
export function numberWarning({ role, text, attempts = 1, partner = '' }) {
  const sup = role === 'supplier';
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="nw-title" aria-describedby="nw-body">
      <div class="row" style="gap:12px"><span class="warn-dot" aria-hidden="true">!</span><h2 id="nw-title" style="margin:0">Phone numbers stay off Kainat</h2></div>
      ${text ? `<p class="bubble me" style="margin:0;max-width:none">${esc(maskPhones(text, '•••• •••••••'))}</p>` : ''}
      <div id="nw-body" class="stack" style="gap:8px">
        <p class="small" style="margin:0">When a conversation moves outside Kainat, <strong>the risk goes with it</strong>. There is no order record, no help from our team if something goes wrong, and no protection for the token money.</p>
        <p class="small" style="margin:0">${sup
          ? 'Sharing numbers to take buyers off Kainat <strong>can harm your supplier profile</strong>. It is reviewed by the Kainat team and can lower where you appear in buyer requests.'
          : `Moving deals off Kainat <strong>can also harm ${partner ? esc(partner) + '’s' : 'the supplier’s'} profile</strong>, because off-platform contact is reviewed by the Kainat team.`}</p>
        ${attempts >= 2 ? `<p class="card warn small" style="margin:0">${sup ? `This is attempt ${attempts} in 30 days. The Kainat team has been notified.` : 'Repeated attempts are reviewed by the Kainat team.'}</p>` : ''}
      </div>
      <button type="button" class="btn primary block" data-v="mask">Send without the number</button>
      <button type="button" class="btn block" data-v="edit">Edit message</button>
    </div></div>`;
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    root.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => close(b.dataset.v); });
    $('.modal-backdrop', root).onclick = (e) => { if (e.target.classList.contains('modal-backdrop')) close('edit'); };
    setTimeout(() => root.querySelector('[data-v=mask]')?.focus(), 30);
  });
}

// Sends something the other side will read. If the server refuses it for a phone number, shows the warning and,
// when the person chooses, sends it again without the number. Returns the API result, or null if they chose to edit.
export async function sendGuarded(send, { text = '', partner = '' } = {}) {
  try {
    return await send(false);
  } catch (e) {
    if (e.code !== 'phone_number') throw e;
    const choice = await numberWarning({ role: e.data.role, text, attempts: e.data.attempts, partner });
    return choice === 'mask' ? send(true) : null;
  }
}

// A live hint under a text box: appears as soon as what is typed contains a phone number.
export function watchPhone(input, hint) {
  if (!input || !hint) return;
  const check = () => { const bad = phoneIn(input.value); hint.hidden = !bad; input.classList.toggle('flagged', bad); };
  input.addEventListener('input', check);
  check();
}
export const phoneHintHtml = (id) => `<p class="numhint" id="${id}" hidden role="status">Phone numbers can’t be shared on Kainat. Keep the conversation here so the order stays protected.</p>`;

let toastTimer;
let toastSeq = 0;
export function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.dataset.seq = String(++toastSeq); // lets tests tell a new toast from one still showing
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 5000 : 3000);
}

// Small dialog that asks for one line of text. Resolves to the text, or null on cancel.
export function ask(title, { placeholder = '', okLabel = 'Send', required = true, help = '' } = {}) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><form class="modal" role="dialog" aria-modal="true" aria-labelledby="ask-title">
      <h2 id="ask-title">${esc(title)}</h2>${help ? `<p class="small muted">${esc(help)}</p>` : ''}
      <label class="field"><span class="hidden">${esc(title)}</span><textarea name="v" placeholder="${esc(placeholder)}" ${required ? 'required' : ''}></textarea></label>
      <div class="grid2"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div>
    </form></div>`;
    const form = $('form', root);
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    $('[data-cancel]', root).onclick = () => close(null);
    $('.modal-backdrop', root).onclick = (e) => { if (e.target.classList.contains('modal-backdrop')) close(null); };
    form.onsubmit = (e) => { e.preventDefault(); close(form.v.value.trim()); };
    setTimeout(() => form.v.focus(), 30);
  });
}

export function confirmBox(title, text, okLabel = 'Yes') {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="cf-title">
      <h2 id="cf-title">${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <div class="grid2"><button type="button" class="btn" data-no>Cancel</button><button type="button" class="btn primary" data-yes>${esc(okLabel)}</button></div>
    </div></div>`;
    const close = (v) => { root.innerHTML = ''; resolve(v); };
    $('[data-no]', root).onclick = () => close(false);
    $('[data-yes]', root).onclick = () => close(true);
  });
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---------- icons (inline stroke svg) ----------
const ic = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icons = {
  back: ic('<path d="M12 4l-6 6 6 6"/>'),
  chevron: ic('<path d="M8 4l6 6-6 6"/>', 18),
  inbox: ic('<path d="M3 5h14v10H3z"/><path d="M3 5l7 6 7-6"/>'),
  shop: ic('<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 8v9"/>'),
  deals: ic('<path d="M4 10h12M10 4l6 6-6 6"/>'),
  chat: ic('<path d="M4 15l-1 3 3.5-1.2A7 7 0 1 0 4 15z"/>'),
  user: ic('<circle cx="10" cy="7" r="3.5"/><path d="M3.5 17c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/>'),
  search: ic('<circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/>'),
  list: ic('<path d="M7 5h10M7 10h10M7 15h10M3 5h.01M3 10h.01M3 15h.01"/>'),
  plus: ic('<path d="M10 4v12M4 10h12"/>', 18),
  camera: ic('<rect x="3" y="5" width="14" height="11" rx="2"/><circle cx="10" cy="10.5" r="3"/><path d="M7 5l1.5-2h3L13 5"/>', 22),
  send: ic('<path d="M3 10h13M11 5l5 5-5 5"/>', 18),
  clip: ic('<path d="M14.5 9.5l-5.6 5.6a3.2 3.2 0 0 1-4.5-4.5l6.4-6.4a2.1 2.1 0 0 1 3 3l-6.3 6.3a1 1 0 0 1-1.5-1.5l5.5-5.5"/>', 20),
  bolt: ic('<path d="M11 2L4 11h5l-1 7 7-9h-5l1-7z"/>', 16),
  msg: ic('<path d="M3 5h14v9H8l-4 3v-3H3z"/>', 18),
  bell: ic('<path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13z"/><path d="M8.5 18a1.6 1.6 0 0 0 3 0"/>'),
  lock: ic('<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>', 14),
};

// Stars as text, e.g. "★★★★☆".
export const starText = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
// Rating badge: the score from 3 ratings, a count before that, nothing with none.
export function ratingBadge(r) {
  if (!r || !r.count) return '';
  if (r.avg !== null && r.avg !== undefined) return `<span class="badge brand" title="Average of the latest rating from each partner, last 12 months">★ ${r.avg.toFixed(1)} · ${r.count} rating${r.count === 1 ? '' : 's'}</span>`;
  return `<span class="badge">New · ${r.count} rating${r.count === 1 ? '' : 's'}</span>`;
}

// ---------- shell ----------
export function shell({ title, eyebrow = '', back = '', actions = '', body = '', nav = null, wide = false }) {
  const navHtml = nav ? `<nav class="bottomnav" style="--n:${nav.length}" aria-label="Main">${nav.map((n) =>
    `<a href="${n.href}" class="${n.active ? 'active' : ''}" ${n.active ? 'aria-current="page"' : ''}>${n.icon}${n.dot ? `<span class="dot">${n.dot}</span>` : ''}${esc(n.label)}</a>`).join('')}</nav>` : '';
  // Signed-in buyers and suppliers get the notification bell on their main screens.
  const n = state.counts?.notifications || 0;
  const bell = nav && state.me?.role && !state.me.is_admin
    ? `<a class="icon-btn bell" href="#/notifications" aria-label="Notifications${n ? `, ${n} unread` : ''}">${icons.bell}${n ? `<span class="dot">${n > 99 ? '99+' : n}</span>` : ''}</a>` : '';
  return `<div class="shell ${wide ? 'wide' : ''}">
    <header class="topbar">
      ${back ? `<a class="icon-btn" href="${back}" aria-label="Back">${icons.back}</a>` : ''}
      <div class="titles">${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ''}<h1>${esc(title)}</h1></div>
      ${actions}${bell}
    </header>
    <main class="content">${body}</main>
    ${navHtml}
  </div>`;
}

export function navFor(active) {
  const me = state.me;
  const c = state.counts || {};
  if (me?.role === 'supplier') {
    return [
      { href: '#/s/inbox', label: 'Requests', icon: icons.inbox, active: active === 'inbox', dot: (c.open_requests || 0) + (c.pending_orders || 0) || '' },
      { href: '#/s/shop', label: 'My shop', icon: icons.shop, active: active === 'shop' },
      { href: '#/deals', label: 'Deals', icon: icons.deals, active: active === 'deals' },
      { href: '#/chats', label: 'Chats', icon: icons.chat, active: active === 'chats' || active === 'whatsapp', dot: c.unread_chats || '' },
      { href: '#/profile', label: 'Profile', icon: icons.user, active: active === 'profile' },
    ];
  }
  return [
    { href: '#/b/search', label: 'Search', icon: icons.search, active: active === 'search' },
    { href: '#/b/requests', label: 'Requests', icon: icons.list, active: active === 'requests', dot: c.new_quotes || '' },
    { href: '#/deals', label: 'Deals', icon: icons.deals, active: active === 'deals' },
    { href: '#/chats', label: 'Chats', icon: icons.chat, active: active === 'chats' || active === 'whatsapp', dot: c.unread_chats || '' },
    { href: '#/profile', label: 'Profile', icon: icons.user, active: active === 'profile' },
  ];
}

// Navigation bookkeeping. Every hash change starts a new navigation; a screen that is still loading
// when the user moves on must not draw over the new screen or start live refreshes on it.
let navSeq = 0;
let renderedSeq = 0;
const STALE = Symbol('stale navigation');

// Repeating refresh for live screens (chat, bids). Cleared on every navigation, and only started by
// the screen that is actually showing.
let pollTimer = null;
export function poll(fn, ms = 4000) {
  if (renderedSeq !== navSeq) return;
  const owner = navSeq;
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (owner !== navSeq) { clearInterval(pollTimer); return; }
    if (!document.hidden) fn().catch(() => {});
  }, ms);
}
export function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

export function render(html) {
  $('#app').innerHTML = html;
  window.scrollTo(0, 0);
}

export function emptyState(text, action = '') {
  return `<div class="empty"><p>${esc(text)}</p>${action}</div>`;
}

export function bizBadges(s, { forBuyer = true } = {}) {
  const out = [];
  if (s.with_you > 0) out.push(`<span class="badge green">${forBuyer ? 'You' : 'With you'}: ${s.with_you} deal${s.with_you > 1 ? 's' : ''}</span>`);
  else if (s.deals === 0) out.push(`<span class="badge amber">New · 0 deals</span>`);
  if (s.verified) out.push('<span class="badge blue">Verified</span>');
  const rb = ratingBadge(s.rating);
  if (rb) out.push(rb);
  return out.join(' ');
}

export function statusBadge(status, disputed) {
  const map = { pending: 'amber', accepted: 'green', dispatched: 'blue', delivered: 'dark', declined: 'red', cancelled: '', open: 'green',
    ordered: 'dark', expired: '', quoted: 'blue', passed: '', sent: 'amber' };
  const label = { pending: 'Waiting for supplier', sent: 'New' }[status] || status[0].toUpperCase() + status.slice(1);
  return `<span class="badge ${map[status] ?? ''}">${esc(label)}</span>${disputed ? ' <span class="badge red">Problem flagged</span>' : ''}`;
}

// ---------- router ----------
const routes = [];
export const route = (pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, handler, opts });
};

export async function refreshMe() {
  const r = await api('GET', '/api/me');
  state.me = r.me;
  state.counts = r.counts || {};
  $('#switch-account').hidden = !state.me;
  return state.me;
}

export function homeFor(me) {
  if (!me) return '#/login';
  if (!me.role) return '#/welcome';
  if (me.is_admin) return '#/a';
  if (me.role === 'supplier') return me.claimed ? '#/s/inbox' : '#/claim';
  return '#/b/search';
}

export async function navigate() {
  const seq = ++navSeq;
  stopPoll();
  const raw = location.hash.slice(1) || '/';
  const [pathPart, qs] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  try {
    if (state.me === null || state._stale) { await refreshMe(); state._stale = false; }
  } catch { state.me = null; }
  if (seq !== navSeq) return;
  const me = state.me;
  if (pathPart === '/' ) { location.replace(homeFor(me)); return; }
  const r = routes.find((x) => x.re.test(pathPart));
  if (!r) { location.replace(homeFor(me)); return; }
  const { opts } = r;
  if (!opts.public && !me) { location.replace('#/login'); return; }
  if (opts.role && me) {
    if (opts.role === 'admin' && !me.is_admin) { location.replace(homeFor(me)); return; }
    if (opts.role !== 'admin' && opts.role !== 'any' && me.role !== opts.role) { location.replace(homeFor(me)); return; }
  }
  if (me && !me.role && !opts.public && !opts.onboarding) { location.replace('#/welcome'); return; }
  const m = pathPart.match(r.re);
  const params = {};
  r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  $('#app').innerHTML = '<div class="loading">Loading…</div>';
  // Each screen gets a render that only works while it is still the current navigation. A stale screen's
  // render throws, which also stops it from wiring buttons onto the newer screen.
  const guardedRender = (html) => {
    if (seq !== navSeq) throw STALE;
    renderedSeq = seq;
    render(html);
  };
  try {
    await r.handler({ params, query, render: guardedRender });
  } catch (e) {
    if (e === STALE || seq !== navSeq) return;
    render(shell({ title: 'Something went wrong', back: homeFor(me), body: `<div class="card danger">${esc(e.message)}</div>
      <a class="btn" href="${homeFor(me)}">Go home</a>` }));
  }
}

// Re-fetch the signed-in account on the next navigation (after actions that change counts).
export function markStale() { state._stale = true; }

export async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'error'); return undefined; } finally { if (btn) btn.disabled = false; }
}
