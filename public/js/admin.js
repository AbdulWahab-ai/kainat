// Admin console: metrics, building supplier shops, verification, models, orders, WhatsApp log.
import { route, render, api, esc, rs, num, ago, toast, run, $, $$, catLabel, typeLabel, modelName, statusBadge, ask, state, starText } from './core.js';

const TABS = [['', 'Overview'], ['suppliers', 'Suppliers'], ['buyers', 'Buyers'], ['requests', 'Requests'], ['orders', 'Orders'], ['models', 'Models'],
  ['ratings', 'Ratings'], ['notifications', 'Notifications'], ['whatsapp', 'WhatsApp log']];

function adminShell(active, title, body, actions = '') {
  return `<div class="shell wide">
    <header class="topbar"><img src="/icon.svg" alt="" width="32" height="32" style="border-radius:8px"><div class="titles"><span class="eyebrow">Kainat admin</span><h1>${esc(title)}</h1></div>
      ${actions}<a class="btn small" href="#/profile">Account</a></header>
    <nav class="tabs" aria-label="Admin">${TABS.map(([k, v]) => `<a href="#/a${k ? '/' + k : ''}" class="${active === k ? 'active' : ''}">${v}</a>`).join('')}</nav>
    <main class="content">${body}</main></div>`;
}
const yes = (b) => (b ? 'Yes' : 'No');

route('/a', async ({ render }) => {
  const d = await api('GET', '/api/admin/overview');
  const c = d.counts;
  render(adminShell('', 'Overview', `
    <div class="row wrap">
      <button type="button" class="btn primary" id="pc">Send morning price check</button>
      <a class="btn" href="#/a/suppliers/new">Build a supplier shop</a>
    </div>
    <div class="metrics">
      ${[['Suppliers', c.suppliers, `${c.unclaimed} not claimed yet`], ['Buyers', c.buyers, ''], ['Open requests', c.open_requests, ''],
        ['Documents to check', c.docs_to_check, 'suppliers'], ['Models awaiting approval', c.pending_models, ''], ['Problems flagged', c.disputes, 'orders'],
        ['Low ratings to review', c.low_ratings, '2 stars or less, last 30 days'], ['WhatsApp waiting', c.wa_waiting, 'batched or quiet hours']]
        .map(([l, v, s]) => `<div class="metric"><span class="small muted">${l}</span><span class="v">${v}</span><span class="tiny muted">${s}</span></div>`).join('')}
    </div>
    <h2>Success metrics</h2><p class="small muted">From the PRD. Review weekly.</p>
    <div class="table-wrap"><table><thead><tr><th>Measure</th><th>Now</th><th>Target at 3 months</th></tr></thead><tbody>
      ${d.metrics.map((m) => `<tr><td>${esc(m.label)}</td><td class="strong">${esc(m.value)}</td><td class="muted">${esc(m.target)}</td></tr>`).join('')}
    </tbody></table></div>`));
  $('#pc').onclick = (e) => run(e.target, async () => {
    const r = await api('POST', '/api/admin/price-check');
    toast(`Price check sent to ${r.sent} supplier(s) on WhatsApp`);
  });
}, { role: 'admin' });

function bizTable(rows, role) {
  return `<div class="table-wrap"><table><thead><tr><th>Business</th><th>Phone</th><th>City</th>${role === 'supplier' ? '<th>Type</th><th>Setup</th><th>Claimed</th><th>Items</th>' : '<th>Installs</th>'}
    <th>Deals</th><th>Documents</th><th>Verified</th><th>Status</th></tr></thead><tbody>
    ${rows.map((b) => `<tr data-id="${b.id}"><td class="strong">${esc(b.name)}<div class="tiny muted">${esc(b.contact || '')}</div></td><td class="nowrap">${esc(b.phone)}</td><td>${esc(b.city || '')}</td>
      ${role === 'supplier' ? `<td>${esc(typeLabel[b.supplier_type] || '')}</td><td>${esc(b.setup_by)}</td><td>${yes(b.claimed)}</td><td>${b.listings}</td>` : `<td>${esc(b.installs || '')}</td>`}
      <td>${b.deals}</td>
      <td><select data-f="docs_status" aria-label="Documents for ${esc(b.name)}" style="height:34px;width:auto">${['pending', 'received', 'verified', 'failed'].map((s) => `<option ${b.docs_status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>${b.ntn ? `<div class="tiny muted">NTN ${esc(b.ntn)}</div>` : ''}</td>
      <td><label class="check"><input type="checkbox" data-f="verified" ${b.verified ? 'checked' : ''} aria-label="Verified">${b.verified ? 'Yes' : 'No'}</label></td>
      <td><button type="button" class="btn small ${b.status === 'active' ? 'danger' : 'outline'}" data-f="status" data-v="${b.status === 'active' ? 'suspended' : 'active'}">${b.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
function bindBizTable(reload) {
  $$('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const save = (body, el) => run(el, async () => { await api('PUT', `/api/admin/businesses/${id}`, body); toast('Saved'); reload(); });
    $('[data-f=docs_status]', tr).onchange = (e) => save({ docs_status: e.target.value }, e.target);
    $('[data-f=verified]', tr).onchange = (e) => save({ verified: e.target.checked }, e.target);
    $('[data-f=status]', tr).onclick = (e) => save({ status: e.target.dataset.v }, e.target);
  });
}

route('/a/suppliers', async ({ render }) => {
  const rows = await api('GET', '/api/admin/businesses?role=supplier');
  render(adminShell('suppliers', 'Suppliers', `
    <p class="small muted">Build shops for new suppliers from a call or their price list. They claim the shop by signing in with the same number. Mark documents verified after checking NTN and the warehouse.</p>
    ${bizTable(rows, 'supplier')}`, '<a class="btn primary small" href="#/a/suppliers/new">Build a supplier shop</a>'));
  bindBizTable(() => { location.hash = '#/a/suppliers?t=' + Date.now(); });
}, { role: 'admin' });

route('/a/buyers', async ({ render }) => {
  const rows = await api('GET', '/api/admin/businesses?role=buyer');
  render(adminShell('buyers', 'Buyers', `<p class="small muted">Verified buyers see exact prices from every supplier.</p>${bizTable(rows, 'buyer')}`));
  bindBizTable(() => { location.hash = '#/a/buyers?t=' + Date.now(); });
}, { role: 'admin' });

route('/a/suppliers/new', async ({ render }) => {
  const models = await api('GET', '/api/admin/models').then((r) => r.filter((m) => m.status === 'approved'));
  const opts = models.map((m) => `<option value="${m.id}">${esc(catLabel[m.category])} · ${esc(modelName(m))}</option>`).join('');
  const itemRow = () => `<tr><td><select name="model_id" aria-label="Model" style="min-width:260px"><option value="">Choose model</option>${opts}</select></td>
    <td><input name="price" aria-label="Price in rupees" inputmode="numeric" placeholder="Rs" style="width:120px"></td><td><input name="qty" aria-label="Stock" type="number" min="0" value="10" style="width:80px"></td>
    <td><input name="token_pct" aria-label="Token money percent" type="number" min="0" max="100" value="20" style="width:70px"></td>
    <td><select name="visibility" aria-label="Price shown" style="width:auto"><option value="band">Range for others</option><option value="exact">Exact for all</option></select></td>
    <td><button type="button" class="btn small" data-del>Remove</button></td></tr>`;
  render(adminShell('suppliers', 'Build a supplier shop', `
    <p class="small muted">Fill this in from the supplier’s call, visit or price list. They get a WhatsApp message and sign in with this number to claim the shop. Matching open buyer requests are sent to them straight away.</p>
    <form id="f" class="stack" style="gap:14px;max-width:880px">
      <div class="grid2"><label class="field"><span class="flabel">Business name</span><input name="name" required></label>
        <label class="field"><span class="flabel">Mobile / WhatsApp number</span><input name="phone" type="tel" placeholder="0300 1234567" required></label></div>
      <div class="grid3"><label class="field"><span class="flabel">Type</span><select name="supplier_type"><option value="importer">Importer</option><option value="distributor">Distributor</option><option value="wholesaler" selected>Wholesaler</option></select></label>
        <label class="field"><span class="flabel">City</span><input name="city" value="Lahore" required></label>
        <label class="field"><span class="flabel">Contact person</span><input name="contact"></label></div>
      <div class="grid2"><label class="field"><span class="flabel">Address</span><input name="address"></label>
        <label class="field"><span class="flabel">Delivers to</span><input name="delivery_cities" placeholder="Lahore, Kasur"></label></div>
      <div class="grid3"><label class="field"><span class="flabel">NTN</span><input name="ntn"></label>
        <label class="field"><span class="flabel">Years in business</span><input name="years" type="number" min="0"></label>
        <label class="field"><span class="flabel">Documents</span><select name="docs_status"><option>pending</option><option>received</option><option>verified</option></select></label></div>
      <h2>First items</h2>
      <div class="table-wrap"><table><thead><tr><th>Model</th><th>Price</th><th>Stock</th><th>Token %</th><th>Price shown</th><th></th></tr></thead><tbody id="items">${itemRow()}${itemRow()}${itemRow()}</tbody></table></div>
      <div class="row"><button type="button" class="btn small" id="add">Add a row</button></div>
      <button class="btn primary lg">Create shop and send WhatsApp</button>
    </form>`));
  const bindDel = () => $$('[data-del]').forEach((b) => { b.onclick = () => b.closest('tr').remove(); });
  bindDel();
  $('#add').onclick = () => { $('#items').insertAdjacentHTML('beforeend', itemRow()); bindDel(); };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    ['model_id', 'price', 'qty', 'token_pct', 'visibility'].forEach((k) => delete body[k]);
    body.items = $$('#items tr').map((tr) => Object.fromEntries(['model_id', 'price', 'qty', 'token_pct', 'visibility'].map((k) => [k, $(`[name=${k}]`, tr).value])))
      .filter((i) => i.model_id && i.price);
    run(e.submitter, async () => {
      const r = await api('POST', '/api/admin/suppliers', body);
      toast(`Shop created with ${r.items} item(s). ${r.requests_waiting} request(s) sent to them.`);
      location.hash = '#/a/suppliers';
    });
  };
}, { role: 'admin' });

route('/a/requests', async ({ render }) => {
  const rows = await api('GET', '/api/admin/requests');
  render(adminShell('requests', 'Buyer requests', `<div class="table-wrap"><table><thead><tr><th>#</th><th>Buyer</th><th>Item</th><th>Qty</th><th>City</th><th>Sent to</th><th>Quotes</th><th>Status</th><th>Posted</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.buyer_name)}</td><td>${esc(r.model_id ? r.brand + ' ' + r.name : r.description || r.category)}</td><td>${num(r.qty)}</td><td>${esc(r.city)}</td>
      <td>${r.sent_to}${r.sent_to === 0 ? ' <span class="badge red">No match</span>' : ''}</td><td>${r.quotes}</td><td>${statusBadge(r.status)}</td><td class="nowrap">${ago(r.created_at)}</td></tr>`).join('')}
  </tbody></table></div><p class="small muted">A request sent to no supplier means a gap in supply: build a shop for a supplier who sells it.</p>`));
}, { role: 'admin' });

route('/a/orders', async ({ query, render }) => {
  let rows = await api('GET', '/api/orders');
  if (query.f === 'disputed') rows = rows.filter((o) => o.disputed);
  render(adminShell('orders', 'Orders', `
    <div class="chips"><a class="chip ${query.f ? '' : 'on'}" href="#/a/orders">All</a><a class="chip ${query.f === 'disputed' ? 'on' : ''}" href="#/a/orders?f=disputed">Problems flagged</a></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Buyer</th><th>Supplier</th><th>Item</th><th>Total</th><th>Proof</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
    ${rows.map((o) => `<tr><td><a href="#/order/${o.id}">${o.id}</a></td><td>${esc(o.buyer_name)}</td><td>${esc(o.supplier_name)}</td><td>${esc(o.model_name || '')} × ${num(o.qty)}</td>
      <td class="nowrap">${rs(o.total)}</td><td>${o.token_proof ? 'Yes' : 'No'}</td><td>${statusBadge(o.status, o.disputed)}${o.disputed ? `<div class="tiny">${esc(o.dispute_note || '')}</div>` : ''}</td>
      <td class="nowrap">${ago(o.created_at)}</td><td>${o.disputed ? `<button type="button" class="btn small outline" data-resolve="${o.id}">Resolve</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`));
  $$('[data-resolve]').forEach((b) => b.onclick = () => run(b, async () => {
    const note = await ask('Resolution note', { placeholder: 'What was agreed with both sides', okLabel: 'Mark resolved', required: false });
    if (note === null) return;
    await api('POST', `/api/admin/orders/${b.dataset.resolve}/resolve`, { note });
    toast('Marked resolved');
    location.hash = '#/a/orders?t=' + Date.now();
  }));
}, { role: 'admin' });

route('/a/models', async ({ render }) => {
  const rows = await api('GET', '/api/admin/models');
  const approved = rows.filter((m) => m.status === 'approved');
  render(adminShell('models', 'Catalogue', `
    <p class="small muted">Every listing points at one model, which is what makes comparison work. Approve new models suppliers submit, or merge duplicates into an existing one.</p>
    <details class="card" style="max-width:720px"><summary class="strong">Add a model</summary><form id="nm" class="stack" style="gap:10px;margin-top:10px">
      <div class="grid3"><label class="field"><span class="flabel">Category</span><select name="category">${Object.entries(catLabel).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="field"><span class="flabel">Brand</span><input name="brand" required></label><label class="field"><span class="flabel">Model</span><input name="name" required></label></div>
      <label class="field"><span class="flabel">Key specs</span><input name="specs"></label><button class="btn primary">Add model</button></form></details>
    <div class="table-wrap"><table><thead><tr><th>Category</th><th>Brand</th><th>Model</th><th>Specs</th><th>Listings</th><th>Status</th><th>Submitted by</th><th></th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td>${esc(catLabel[m.category])}</td><td>${esc(m.brand)}</td><td class="strong">${esc(m.name)}</td><td class="small">${esc(m.specs || '')}</td><td>${m.listings}</td>
      <td>${m.status === 'pending' ? '<span class="badge amber">Pending</span>' : m.status === 'rejected' ? '<span class="badge">Rejected</span>' : '<span class="badge green">Approved</span>'}</td>
      <td class="small">${esc(m.submitted_name || 'Team')}</td>
      <td class="nowrap">${m.status === 'pending' ? `<button type="button" class="btn small primary" data-a="approve" data-id="${m.id}">Approve</button>
        <select data-merge="${m.id}" style="height:36px;width:auto" aria-label="Merge into"><option value="">Merge into…</option>${approved.filter((x) => x.category === m.category).map((x) => `<option value="${x.id}">${esc(modelName(x))}</option>`).join('')}</select>
        <button type="button" class="btn small" data-a="reject" data-id="${m.id}">Reject</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`));
  const reload = () => { location.hash = '#/a/models?t=' + Date.now(); };
  $$('[data-a]').forEach((b) => b.onclick = () => run(b, async () => { await api('POST', `/api/admin/models/${b.dataset.id}/${b.dataset.a}`); toast('Saved'); reload(); }));
  $$('[data-merge]').forEach((s) => s.onchange = () => s.value && run(s, async () => {
    await api('POST', `/api/admin/models/${s.dataset.merge}/merge`, { into: s.value }); toast('Merged'); reload();
  }));
  $('#nm').onsubmit = (e) => { e.preventDefault(); run(e.submitter, async () => { await api('POST', '/api/models', Object.fromEntries(new FormData(e.target))); toast('Model added'); reload(); }); };
}, { role: 'admin' });

route('/a/ratings', async ({ query, render }) => {
  const rows = await api('GET', `/api/admin/ratings${query.f === 'low' ? '?low=1' : ''}`);
  render(adminShell('ratings', 'Ratings', `
    <p class="small muted">Buyers and suppliers rate each other after a delivered order. Ratings stay hidden until both rate or 14 days pass. You can hide an abusive comment; the stars always count.</p>
    <div class="chips"><a class="chip ${query.f ? '' : 'on'}" href="#/a/ratings">All</a><a class="chip ${query.f === 'low' ? 'on' : ''}" href="#/a/ratings?f=low">2 stars or less</a></div>
    <div class="table-wrap"><table><thead><tr><th>Order</th><th>From</th><th>About</th><th>Stars</th><th>Tags</th><th>Comment</th><th>Shown</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><a href="#/order/${r.order_id}">${r.order_id}</a></td><td>${esc(r.rater_name)}<div class="tiny muted">${r.rater_role}</div></td><td>${esc(r.ratee_name)}</td>
      <td class="nowrap"><span class="star-text">${starText(r.stars)}</span>${r.stars <= 2 ? ' <span class="badge red">Low</span>' : ''}</td><td class="small">${esc(r.tags.join(', '))}</td>
      <td class="small" style="max-width:320px">${r.comment ? esc(r.comment) : '<span class="muted">none</span>'}${r.hidden ? ' <span class="badge">Hidden</span>' : ''}${r.reply ? `<div class="tiny muted">Reply: ${esc(r.reply)}</div>` : ''}</td>
      <td>${r.revealed_at ? ago(r.revealed_at) : '<span class="badge amber">Blind</span>'}</td>
      <td>${r.comment ? `<button type="button" class="btn small" data-hide="${r.id}" data-v="${r.hidden ? '0' : '1'}">${r.hidden ? 'Show comment' : 'Hide comment'}</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="8" class="muted">No ratings yet.</td></tr>'}
    </tbody></table></div>`));
  $$('[data-hide]').forEach((b) => b.onclick = () => run(b, async () => {
    await api('POST', `/api/admin/ratings/${b.dataset.hide}/hide`, { hidden: b.dataset.v === '1' });
    toast('Saved');
    location.hash = `#/a/ratings${query.f ? '?f=' + query.f : ''}${query.f ? '&' : '?'}t=${Date.now()}`;
  }));
}, { role: 'admin' });

route('/a/notifications', async ({ query, render }) => {
  const d = await api('GET', `/api/admin/notifications${query.s ? '?status=' + encodeURIComponent(query.s) : ''}`);
  const label = { sent: 'Sent', batched: 'In a batch', queued: 'Waiting (batch)', held: 'Waiting (quiet hours)', off: 'WhatsApp off', capped: 'Daily limit' };
  render(adminShell('notifications', 'Notifications', `
    <p class="small muted">Every alert, in the app and on WhatsApp. Urgent alerts go out at once. Others are batched every 15 minutes, wait for quiet hours to end, or are app-only when a business switched WhatsApp off. Last 7 days:</p>
    <div class="chips"><a class="chip ${query.s ? '' : 'on'}" href="#/a/notifications">All</a>${Object.entries(label).map(([k, v]) => `<a class="chip ${query.s === k ? 'on' : ''}" href="#/a/notifications?s=${k}">${v} ${d.counts[k] || 0}</a>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Business</th><th>Event</th><th>Message</th><th>WhatsApp</th><th>Read in app</th></tr></thead><tbody>
    ${d.rows.map((n) => `<tr><td class="nowrap">${ago(n.created_at)}</td><td>${esc(n.name)}</td><td class="small">${esc(n.event.replace(/_/g, ' '))}${n.priority === 'urgent' ? ' <span class="badge brand">urgent</span>' : ''}</td>
      <td style="white-space:pre-line;max-width:460px" class="small">${esc(n.body)}</td><td class="small nowrap">${esc(label[n.wa_status] || n.wa_status)}${n.send_after && ['queued', 'held'].includes(n.wa_status) ? `<div class="tiny muted">at ${new Date(n.send_after).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}</td>
      <td>${n.read_at ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing yet.</td></tr>'}
    </tbody></table></div>`));
}, { role: 'admin' });

route('/a/whatsapp', async ({ render }) => {
  const rows = await api('GET', '/api/admin/whatsapp');
  render(adminShell('whatsapp', 'WhatsApp log', `
    <p class="small muted">Every message the Kainat number sent or received. In production these go through the WhatsApp Business Platform; templates need Meta approval.</p>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Business</th><th>Direction</th><th>Message</th><th>Buttons</th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td class="nowrap">${ago(m.at)}</td><td>${esc(m.name)}</td><td>${m.direction === 'out' ? 'Sent' : '<span class="badge green">Reply</span>'}</td>
      <td style="white-space:pre-line;max-width:520px">${esc(m.body)}</td><td class="small">${esc((m.buttons || []).join(' · '))}</td></tr>`).join('')}
    </tbody></table></div>`));
  void state;
}, { role: 'admin' });
