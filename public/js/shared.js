// Screens both sides use: deals list, order page, notifications, simulated WhatsApp, profile.
import { route, render, shell, navFor, api, esc, rs, num, ago, day, toast, state, run, $, $$, typeLabel, emptyState, statusBadge,
  refreshMe, ask, confirmBox, fileToDataUrl, icons, homeFor, starText } from './core.js';

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// The rating section of the order page: a form while the viewer can rate, then both ratings once revealed.
function ratingCard(o, me) {
  const r = o.rating;
  if (!r || o.status !== 'delivered') return '';
  const other = o.buyer_id === me.id ? o.supplier : o.buyer;
  const shown = (x, who) => `<div class="review"><span class="small strong">${esc(who)}</span><span class="star-text" aria-label="${x.stars} of 5 stars">${starText(x.stars)}</span>
    ${x.tags.length ? `<span class="row wrap" style="gap:4px">${x.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</span>` : ''}
    ${x.comment ? `<span class="small">“${esc(x.comment)}”</span>` : x.hidden ? '<span class="tiny muted">Comment hidden by the Kainat team</span>' : ''}
    ${x.reply ? `<div class="reply small"><span class="strong">Reply:</span> ${esc(x.reply)}</div>` : ''}</div>`;
  let body = '';
  if (r.can_rate) {
    const m = r.mine || { stars: 0, tags: [], comment: '' };
    body = `<form id="rate" class="stack" style="gap:10px">
      <fieldset><legend class="small">${r.mine ? 'Change your rating' : `How was dealing with ${esc(other.name)}?`}</legend>
        <div class="stars">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="stars" id="st${n}" value="${n}" ${m.stars === n ? 'checked' : ''}><label for="st${n}" title="${n} star${n > 1 ? 's' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</label>`).join('')}</div></fieldset>
      <div class="row wrap" style="gap:6px">${r.tags.map((t) => `<label class="chip"><input type="checkbox" name="tags" value="${esc(t)}" ${m.tags.includes(t) ? 'checked' : ''} style="margin-right:6px;accent-color:var(--brand)">${esc(t)}</label>`).join('')}</div>
      <label class="field"><span class="flabel">Comment (optional)</span><textarea name="comment" maxlength="500" placeholder="What went well, or what could be better">${esc(m.comment || '')}</textarea></label>
      <button class="btn primary">${r.mine ? 'Update rating' : 'Submit rating'}</button>
      <span class="tiny muted">Hidden until ${esc(other.name)} rates too, or for 14 days. Rating closes ${shortDate(r.window_ends)}.</span></form>`;
    if (r.waiting_for_other) body = `<div class="card tint small">${r.held_for_problem ? 'Your rating is saved. It stays hidden while the problem on this order is being resolved.' : `Your ${r.mine.stars} ★ rating is saved. Both ratings show once ${esc(other.name)} rates, or on ${shortDate(r.reveal_by)}.`}</div>` + body;
  } else if (r.mine) {
    body = shown(r.mine, 'You rated them');
    if (r.waiting_for_other) body += `<span class="tiny muted">Shown once ${esc(other.name)} rates, or on ${shortDate(r.reveal_by)}.</span>`;
  } else if (!r.window_open) {
    body = '<span class="small muted">Rating closed 30 days after delivery.</span>';
  }
  if (r.theirs) {
    body += shown(r.theirs, `${other.name} rated you`);
    if (!r.theirs.reply) body += `<button type="button" class="btn small outline" data-reply="${r.theirs.id}">Reply publicly</button>`;
  }
  if (!body) return '';
  return `<section class="card" id="rating"><span class="label-caps">Rating</span>${body}</section>`;
}

route('/deals', async ({ query, render }) => {
  await refreshMe();
  const me = state.me;
  const tab = query.tab || 'active';
  const orders = await api('GET', '/api/orders');
  const groups = {
    active: orders.filter((o) => ['pending', 'accepted', 'dispatched'].includes(o.status) || o.disputed),
    done: orders.filter((o) => o.status === 'delivered'),
    closed: orders.filter((o) => ['declined', 'cancelled'].includes(o.status)),
  };
  const list = groups[tab] || [];
  render(shell({
    title: 'Deals', eyebrow: `${groups.done.length} completed · trade history`, nav: navFor('deals'),
    body: `<div class="chips"><a class="chip ${tab === 'active' ? 'on' : ''}" href="#/deals?tab=active">Active ${groups.active.length}</a>
      <a class="chip ${tab === 'done' ? 'on' : ''}" href="#/deals?tab=done">Delivered ${groups.done.length}</a>
      <a class="chip ${tab === 'closed' ? 'on' : ''}" href="#/deals?tab=closed">Closed ${groups.closed.length}</a></div>
      ${list.map((o) => `<a class="card" href="#/order/${o.id}${o.can_rate ? '?rate=1' : ''}"><div class="row between"><span class="strong">${esc(o.model_name || 'Item')} × ${num(o.qty)}</span><span class="row" style="gap:4px">${o.can_rate ? '<span class="badge brand">Rate this deal</span>' : ''}${statusBadge(o.status, o.disputed)}</span></div>
        <span class="small muted">${me.role === 'buyer' ? 'from ' + esc(o.supplier_name) : 'to ' + esc(o.buyer_name)} · ${rs(o.total)} · #${o.id} · ${ago(o.delivered_at || o.created_at)}</span></a>`).join('')
        || emptyState(tab === 'active' ? 'No active deals.' : tab === 'done' ? 'Delivered deals build your trade history.' : 'Nothing here.')}`,
  }));
});

route('/order/:id', async ({ params, query, render }) => {
  const me = state.me;
  const o = await api('GET', `/api/orders/${params.id}`);
  const isBuyer = o.buyer_id === me.id;
  const isSupplier = o.supplier_id === me.id;
  const other = isBuyer ? o.supplier : o.buyer;
  const steps = [
    ['Order sent', o.created_at, true],
    [o.status === 'declined' ? 'Declined by supplier' : o.status === 'cancelled' ? 'Cancelled by buyer' : 'Accepted by supplier', o.accepted_at || (['declined', 'cancelled'].includes(o.status) ? o.created_at : null), !!o.accepted_at || ['declined', 'cancelled'].includes(o.status)],
    ['Dispatched', o.dispatched_at, !!o.dispatched_at],
    ['Delivered', o.delivered_at, !!o.delivered_at],
  ];
  const back = me.is_admin ? '#/a/orders' : isSupplier && o.status === 'pending' ? '#/s/inbox' : '#/deals';
  const actions = [];
  if (isSupplier && o.status === 'pending') actions.push('<button type="button" class="btn" data-act="decline">Decline</button>', '<button type="button" class="btn primary" data-act="accept">Accept</button>');
  if (isSupplier && o.status === 'accepted') actions.push('<button type="button" class="btn primary" data-act="dispatch" style="grid-column:span 2">Mark dispatched</button>');
  if (isBuyer && o.status === 'pending') actions.push('<button type="button" class="btn danger" data-act="cancel" style="grid-column:span 2">Cancel order</button>');
  if (isBuyer && ['accepted', 'dispatched'].includes(o.status)) actions.push('<button type="button" class="btn primary" data-act="deliver" style="grid-column:span 2">Mark delivered</button>');
  render(shell({
    title: `Order #${o.id}`, eyebrow: `${isBuyer ? 'from' : 'to'} ${other.name}`, back,
    body: `
      <div class="row wrap">${statusBadge(o.status, o.disputed)}${o.status === 'declined' && o.decline_reason ? `<span class="small muted">Reason: ${esc(o.decline_reason)}</span>` : ''}</div>
      ${o.disputed ? `<div class="card danger small"><strong>Problem flagged</strong>${esc(o.dispute_note || '')}<span>The Kainat team will review it.</span></div>` : ''}
      <section class="card"><div class="row between top"><a class="strong" style="color:var(--ink)" href="${isBuyer ? '#/b/supplier/' + other.id : 'javascript:void 0'}">${esc(other.name)}</a>
        ${other.with_you > 0 ? `<span class="badge green">Traded ${other.with_you}×</span>` : `<span class="badge">${other.deals} deal${other.deals === 1 ? '' : 's'} on app</span>`}</div>
        <span class="small muted">${esc(typeLabel[other.supplier_type] || (other.role === 'buyer' ? 'Installer' : ''))} · ${esc(other.city || '')}</span>
        ${other.phone ? `<span class="small">${esc(other.contact || '')} · <a href="tel:${esc(other.phone)}">${esc(other.phone)}</a></span>` : ''}</section>
      <section class="card"><span class="label-caps">Order</span>
        <div class="row between"><span class="strong">${esc(o.model_name || 'Item')}</span><span>× ${num(o.qty)}</span></div>
        <div class="row between small muted"><span>Locked price</span><span>${rs(o.price)} each</span></div>
        <div class="sep"></div>
        <div class="row between strong"><span>Total</span><span>${rs(o.total)}</span></div>
        <div class="row between small muted"><span>Token money (${o.token_pct}%)</span><span>${rs(o.token_amount)}</span></div></section>
      <section class="card"><span class="label-caps">Delivery</span><span class="small">${esc(o.address)}</span>
        <span class="small muted">${o.needed_by ? 'Needed by ' + esc(day(o.needed_by)) : 'No date given'}${o.note ? ' · ' + esc(o.note) : ''}</span></section>
      <section class="card"><span class="label-caps">Token money proof</span>
        ${o.token_proof ? `<div class="row"><a href="/api/orders/${o.id}/proof" target="_blank" rel="noopener"><img class="proof-thumb" src="/api/orders/${o.id}/proof" alt="Token money screenshot" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'PDF attached',className:'badge'}))"></a>
          <span class="stack small" style="gap:2px"><span class="strong">Proof attached</span>${isSupplier ? '<span class="muted">Check your bank before accepting</span>' : ''}<a href="/api/orders/${o.id}/proof" target="_blank" rel="noopener">View full size</a></span></div>`
          : isBuyer ? `<label class="btn block" style="border-style:dashed">${icons.camera} Upload screenshot<input type="file" id="proof" accept="image/*,application/pdf" class="hidden"></label>` : '<span class="small muted">Not uploaded yet</span>'}</section>
      <section class="card"><span class="label-caps">Status</span><div class="timeline">
        ${steps.map(([label, at, done]) => `<div class="tl-step ${done ? 'done' : ''}"><div class="tl-rail"><span class="tl-dot"></span><span class="tl-line"></span></div>
          <div class="stack" style="gap:1px;padding-bottom:10px"><span class="small ${done ? 'strong' : 'muted'}">${esc(label)}</span><span class="tiny muted">${at && done ? new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span></div></div>`).join('')}</div></section>
      ${actions.length ? `<div class="grid2">${actions.join('')}</div>` : ''}
      ${isBuyer || isSupplier ? ratingCard(o, me) : ''}
      ${me.is_admin && o.rating?.all?.length ? `<section class="card"><span class="label-caps">Ratings (admin view)</span>${o.rating.all.map((x) => `<span class="small">${x.rater_role === 'buyer' ? 'Buyer' : 'Supplier'}: <span class="star-text">${starText(x.stars)}</span> ${x.revealed_at ? '' : '<span class="badge">hidden</span>'} ${esc(x.comment || '')}</span>`).join('')}</section>` : ''}
      <section class="card"><span class="label-caps">Messages</span>
        <div class="stack">${o.messages.map((m) => `<div class="bubble ${m.sender_id === me.id ? 'me' : 'them'}"><span class="tiny strong">${esc(m.sender_name || 'Kainat')}</span><br>${esc(m.body)}<div class="meta">${ago(m.at)}</div></div>`).join('') || '<span class="small muted">No messages yet.</span>'}</div>
        ${isBuyer || isSupplier ? `<form id="msg" class="composer"><input name="body" placeholder="Message ${esc(other.name)}" aria-label="Message"><button class="btn primary" aria-label="Send">${icons.send}</button></form>` : ''}</section>
      ${(isBuyer || isSupplier) && !o.disputed && !['cancelled'].includes(o.status) ? '<button type="button" class="btn danger block" data-act="flag">Flag a problem</button>' : ''}`,
  }));
  const reload = () => { location.hash = `#/order/${o.id}?t=${Date.now()}`; };
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    const act = b.dataset.act;
    if (act === 'decline') {
      const reason = await ask('Why are you declining?', { placeholder: 'Out of stock, price changed, city not served…', okLabel: 'Decline order' });
      if (reason === null) return;
      await api('POST', `/api/orders/${o.id}/decline`, { reason });
    } else if (act === 'flag') {
      const note = await ask('What went wrong?', { placeholder: 'Wrong item, short quantity, token not acknowledged…', okLabel: 'Flag problem', help: 'The Kainat team sees this and contacts both sides.' });
      if (note === null) return;
      await api('POST', `/api/orders/${o.id}/flag`, { note });
    } else if (act === 'cancel') {
      if (!(await confirmBox('Cancel this order?', 'The supplier has not accepted it yet.', 'Cancel order'))) return;
      await api('POST', `/api/orders/${o.id}/cancel`);
    } else if (act === 'deliver') {
      if (!(await confirmBox('Mark as delivered?', 'Only confirm once the goods have arrived and match the order. This adds the deal to both trade histories.', 'Yes, delivered'))) return;
      await api('POST', `/api/orders/${o.id}/deliver`);
    } else {
      await api('POST', `/api/orders/${o.id}/${act}`);
    }
    toast({ accept: 'Order accepted', decline: 'Order declined', dispatch: 'Marked dispatched', deliver: 'Delivery confirmed', cancel: 'Order cancelled', flag: 'Problem flagged' }[act]);
    reload();
  })));
  $('#msg')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    run(e.submitter, async () => { await api('POST', `/api/orders/${o.id}/messages`, { body }); reload(); });
  });
  $('#rate')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const stars = Number(new FormData(f).get('stars'));
    if (!stars) { toast('Choose 1 to 5 stars', 'error'); return; }
    run(e.submitter, async () => {
      const r = await api('POST', `/api/orders/${o.id}/rating`, { stars, tags: $$('input[name=tags]:checked', f).map((x) => x.value), comment: f.comment.value });
      toast(r.theirs ? 'Rating saved. Both ratings are now shown.' : 'Rating saved');
      reload();
    });
  });
  $$('[data-reply]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    const text = await ask('Reply to this rating', { placeholder: 'Thank them, or explain what happened', okLabel: 'Post reply', help: 'Your reply shows under their rating on your profile. You can reply once.' });
    if (text === null) return;
    await api('POST', `/api/ratings/${b.dataset.reply}/reply`, { reply: text });
    toast('Reply posted');
    reload();
  })));
  if (query.rate) document.getElementById('rating')?.scrollIntoView({ block: 'start' });
  $('#proof')?.addEventListener('change', (e) => run(null, async () => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) throw new Error('Screenshot is larger than 6 MB');
    await api('POST', `/api/orders/${o.id}/proof`, { token_proof: await fileToDataUrl(file) });
    toast('Proof uploaded');
    reload();
  }));
});

const reqLink = (c) => (state.me?.role === 'supplier' ? `#/s/quote/${c.request_id}` : `#/b/request/${c.request_id}`);
const NAV_BUTTONS = { 'Open order': (c) => `#/order/${c.order_id}`, 'Open my shop': () => '#/s/shop', 'See quotes': reqLink, 'See bids': reqLink,
  'Open request': reqLink, 'Open chat': (c) => `#/chat/${c.conversation_id}`, 'Open notifications': () => '#/notifications' };

route('/notifications', async ({ render }) => {
  const d = await api('GET', '/api/notifications');
  // Opening the list counts as reading it.
  if (d.unread) await api('POST', '/api/notifications/read', {});
  await refreshMe();
  const waNote = (n) => ({ queued: 'WhatsApp: sent in the next batch', held: 'WhatsApp: after quiet hours', off: 'WhatsApp: off for this type', capped: 'WhatsApp: daily limit reached' })[n.wa_status] || '';
  render(shell({
    title: 'Notifications', eyebrow: d.unread ? `${d.unread} new` : 'All caught up', nav: navFor('notifications'),
    actions: '<a class="btn small" href="#/profile?tab=alerts">Settings</a>',
    body: d.items.map((n) => `<a class="card notif ${n.read_at ? '' : 'unread'}" href="${esc(n.link || '#/notifications')}">
        <span class="stack" style="gap:4px;flex:1;min-width:0"><span class="body">${esc(n.body)}</span>
        <span class="tiny muted">${ago(n.created_at)}${waNote(n) ? ' · ' + waNote(n) : ''}</span></span>${n.link ? icons.chevron : ''}</a>`).join('')
      || emptyState('Nothing yet. New requests, bids, orders and messages show up here, and on WhatsApp.'),
  }));
});

route('/whatsapp', async ({ render }) => {
  await refreshMe();
  const me = state.me;
  const msgs = await api('GET', '/api/whatsapp');
  const lastWithButtons = [...msgs].reverse().find((m) => m.direction === 'out');
  render(shell({
    title: 'WhatsApp', eyebrow: 'Simulated chat with the Kainat number', nav: navFor('whatsapp'),
    body: `
      <div class="card tint small">In the real product these messages arrive in ${esc(me.name)}’s own WhatsApp. ${me.role === 'supplier' ? 'Reply to a request with a price, for example <strong>305000 8 20</strong> (price, quantity, token %), or “2.5 lakh 10”.' : 'Quotes and order updates arrive here.'}</div>
      <div class="wa-wall" id="wall">
        ${msgs.map((m) => `<div class="bubble ${m.direction === 'in' ? 'me' : 'them'}">${esc(m.body)}<div class="meta">${new Date(m.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>
          ${m.buttons && m.direction === 'out' ? `<div class="wa-buttons">${m.buttons.map((b) => `<button type="button" data-btn="${esc(b)}" data-ctx='${esc(JSON.stringify(m.context || {}))}' ${m !== lastWithButtons && !NAV_BUTTONS[b] ? 'data-old="1"' : ''}>${esc(b)}</button>`).join('')}</div>` : ''}`).join('')
          || '<div class="empty">No messages yet.</div>'}
      </div>
      <form id="send" class="composer"><input name="text" placeholder="${me.role === 'supplier' ? 'Type a price, e.g. 305000 8 20' : 'Type a message'}" aria-label="Message" autocomplete="off"><button class="btn primary" aria-label="Send">${icons.send}</button></form>`,
  }));
  const wall = $('#wall');
  wall.lastElementChild?.scrollIntoView({ block: 'end' });
  const reload = () => { location.hash = `#/whatsapp?t=${Date.now()}`; };
  $$('[data-btn]').forEach((b) => b.addEventListener('click', () => {
    const label = b.dataset.btn;
    const ctx = JSON.parse(b.dataset.ctx || '{}');
    if (NAV_BUTTONS[label]) { location.hash = NAV_BUTTONS[label](ctx); return; }
    run(b, async () => { await api('POST', '/api/whatsapp', { button: label, context: ctx }); reload(); });
  }));
  $('#send').onsubmit = (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    run(e.submitter, async () => { await api('POST', '/api/whatsapp', { text }); reload(); });
  };
});

const HOURS = Array.from({ length: 24 }, (_, h) => [h, `${h === 0 ? 12 : h > 12 ? h - 12 : h}:00 ${h < 12 ? 'am' : 'pm'}`]);

function prefsForm(p, supplier) {
  const groups = [
    ['wa_requests', supplier ? 'New buyer requests' : 'Request updates (closing, expired, no bids)'],
    ['wa_bidding', supplier ? 'Outbid alerts' : 'New and revised bids'],
    ['wa_chat', 'Chat messages'],
    ...(supplier ? [['wa_shop', 'Morning price check']] : []),
    ['wa_ratings', 'Rating requests and new ratings'],
  ];
  const sel = (name, v) => `<select name="${name}" aria-label="${name === 'quiet_start' ? 'Quiet from' : 'Quiet until'}">${HOURS.map(([h, l]) => `<option value="${h}" ${v === h ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const quiet = p.quiet_start !== null && p.quiet_start !== undefined;
  return `<form id="np" class="card stack" style="gap:10px"><span class="label-caps">WhatsApp alerts</span>
    <span class="small muted">Everything always shows under the bell in the app. Choose what also comes to WhatsApp. Orders always do.</span>
    ${groups.map(([k, l]) => `<label class="check"><input type="checkbox" name="${k}" ${p[k] ? 'checked' : ''}>${esc(l)}</label>`).join('')}
    <label class="check"><input type="checkbox" name="quiet_on" ${quiet ? 'checked' : ''}>Quiet hours (Pakistan time)</label>
    <div class="grid2" id="qh" ${quiet ? '' : 'hidden'}><label class="field"><span class="flabel">From</span>${sel('quiet_start', quiet ? p.quiet_start : 22)}</label>
      <label class="field"><span class="flabel">Until</span>${sel('quiet_end', quiet ? p.quiet_end : 8)}</label></div>
    <span class="tiny muted">During quiet hours WhatsApp alerts wait until the morning. New orders still come through.</span>
    <button class="btn outline">Save alert settings</button></form>`;
}

route('/profile', async ({ query, render }) => {
  await refreshMe();
  const me = state.me;
  const supplier = me.role === 'supplier';
  const prefs = me.is_admin ? null : await api('GET', '/api/notify-prefs');
  const reviews = me.is_admin ? null : await api('GET', `/api/businesses/${me.id}/reviews`);
  render(shell({
    title: 'Profile', eyebrow: me.phone, nav: me.is_admin ? null : navFor('profile'), back: me.is_admin ? '#/a' : '',
    body: `
      <section class="card"><div class="row wrap">${me.verified ? '<span class="badge blue">Verified</span>' : '<span class="badge">Not verified yet</span>'}
        ${supplier ? `<span class="badge ${me.docs_status === 'verified' ? 'green' : me.docs_status === 'failed' ? 'red' : 'amber'}">Documents: ${esc(me.docs_status)}</span>` : ''}
        <span class="badge">${me.deals} completed deal${me.deals === 1 ? '' : 's'}</span>
        ${reviews ? (reviews.summary.avg !== null ? `<span class="badge brand">★ ${reviews.summary.avg.toFixed(1)} · ${reviews.summary.count} ratings</span>`
          : `<span class="badge">${reviews.summary.count ? `${reviews.summary.count} rating${reviews.summary.count === 1 ? '' : 's'}; score shows from 3` : 'No ratings yet'}</span>`) : ''}</div>
        <span class="small muted">${supplier ? (me.setup_by === 'team' ? 'Shop set up by the Kainat team.' : 'Shop created by you.') + ' Verified suppliers get a badge buyers trust before paying token money.' : 'Verified buyers see exact prices from every supplier.'}</span></section>
      <form id="f" class="stack" style="gap:14px">
        <label class="field"><span class="flabel">${supplier ? 'Business name' : 'Company name'}</span><input name="name" value="${esc(me.name)}" required></label>
        ${supplier ? `<label class="field"><span class="flabel">Business type</span><select name="supplier_type">${['importer', 'distributor', 'wholesaler'].map((t) => `<option value="${t}" ${me.supplier_type === t ? 'selected' : ''}>${typeLabel[t]}</option>`).join('')}</select></label>` : ''}
        <div class="grid2"><label class="field"><span class="flabel">City</span><input name="city" value="${esc(me.city || '')}"></label>
          ${supplier ? `<label class="field"><span class="flabel">Years in business</span><input name="years" type="number" value="${esc(me.years ?? '')}"></label>`
            : `<label class="field"><span class="flabel">Installs a month</span><select name="installs">${['Under 5', '5 to 20', 'Over 20'].map((x) => `<option ${me.installs === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`}</div>
        <label class="field"><span class="flabel">Contact person</span><input name="contact" value="${esc(me.contact || '')}"></label>
        <label class="field"><span class="flabel">Address</span><input name="address" value="${esc(me.address || '')}"></label>
        ${supplier ? `<label class="field"><span class="flabel">Cities you deliver to</span><input name="delivery_cities" value="${esc(me.delivery_cities || '')}"></label>
          <label class="field"><span class="flabel">NTN or registration number</span><input name="ntn" value="${esc(me.ntn || '')}"></label>`
          : `<label class="field"><span class="flabel">What you buy most</span><input name="buys" value="${esc(me.buys || '')}"></label>`}
        <button class="btn primary block">Save</button>
      </form>
      ${prefs ? prefsForm(prefs, supplier) : ''}
      ${reviews?.reviews.length ? `<section class="card"><span class="label-caps">What partners say about you</span>${reviews.reviews.slice(0, 5).map((x) => `<div class="review">
        <span class="small"><span class="star-text" aria-label="${x.stars} of 5 stars">${starText(x.stars)}</span> · ${esc(x.rater_name)} · ${shortDate(x.created_at)}</span>
        ${x.comment ? `<span class="small">“${esc(x.comment)}”</span>` : ''}${x.reply ? `<div class="reply small"><span class="strong">Your reply:</span> ${esc(x.reply)}</div>` : ''}</div>`).join('')}</section>` : ''}
      <a class="btn block" href="#/whatsapp">Open simulated WhatsApp</a>
      <button type="button" id="out" class="btn block">Sign out</button>`,
  }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => { await api('PUT', '/api/me', Object.fromEntries(new FormData(e.target))); toast('Saved'); await refreshMe(); });
  };
  const np = $('#np');
  if (np) {
    np.quiet_on.onchange = () => { $('#qh').hidden = !np.quiet_on.checked; };
    np.onsubmit = (e) => {
      e.preventDefault();
      const body = Object.fromEntries(['wa_requests', 'wa_bidding', 'wa_chat', 'wa_shop', 'wa_ratings'].filter((k) => np[k]).map((k) => [k, np[k].checked]));
      body.quiet_start = np.quiet_on.checked ? np.quiet_start.value : 'off';
      body.quiet_end = np.quiet_on.checked ? np.quiet_end.value : 'off';
      run(e.submitter, async () => { await api('PUT', '/api/notify-prefs', body); toast('Alert settings saved'); });
    };
    if (query.tab === 'alerts') np.scrollIntoView({ block: 'start' });
  }
  $('#out').onclick = async () => { await api('POST', '/api/auth/logout'); state.me = null; location.hash = '#/login'; };
  void homeFor;
});
