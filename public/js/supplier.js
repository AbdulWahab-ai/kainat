// Supplier side: request inbox, quoting, shop, item editing.
import { route, render, shell, navFor, api, esc, rs, num, ago, day, toast, state, run, $, $$, catLabel, modelName,
  emptyState, statusBadge, refreshMe, freshness, icons, poll } from './core.js';

function buyerLine(b) {
  if (!b) return '';
  return b.with_you > 0 ? `<span class="badge green">Traded ${b.with_you}×</span>`
    : `<span class="badge">New buyer · ${b.deals} deal${b.deals === 1 ? '' : 's'}</span>`;
}

route('/s/inbox', async ({ query, render }) => {
  await refreshMe();
  const tab = query.tab || 'open';
  const [reqs, orders] = await Promise.all([api('GET', '/api/requests'), api('GET', '/api/orders')]);
  const me = state.me;
  const c = state.counts;
  const open = reqs.filter((r) => r.status === 'open' && r.target_status === 'sent');
  const quoted = reqs.filter((r) => r.target_status === 'quoted' || r.target_status === 'passed' || r.status !== 'open');
  const pending = orders.filter((o) => o.supplier_id === me.id && o.status === 'pending');
  const list = tab === 'open' ? open : tab === 'quoted' ? quoted : [];

  const reqCard = (r) => {
    const what = r.model_id ? `${r.brand} ${r.name}` : r.description || catLabel[r.category];
    const q = r.my_quote;
    const b = r.board || {};
    const stock = r.in_stock && r.in_stock.in_stock ? r.in_stock : null;
    const open = r.status === 'open' && r.target_status !== 'passed';
    return `<article class="card ${stock && !q && open ? 'accent' : ''}">
      <div class="row between"><span class="strong small">${esc(r.buyer_name)}</span>${buyerLine(r.buyer)}</div>
      ${stock && open ? `<span class="badge brand" style="align-self:flex-start">${icons.bolt} In stock in your shop: ${num(stock.stock_qty)} at ${rs(stock.stock_price)}</span>` : ''}
      <span class="big">${esc(what)} × ${num(r.qty)}</span>
      <span class="small muted">${esc(r.city)}${r.needed_by ? ' · needed by ' + esc(day(r.needed_by)) : ''} · ${b.count ? `${b.count} bid${b.count > 1 ? 's' : ''}${b.mode === 'open' && b.lowest ? ', lowest ' + rs(b.lowest) : ''}` : 'no bids yet'}${b.mode === 'sealed' ? ' · sealed bidding' : ''} · ${ago(r.created_at)}</span>
      ${q ? `<div class="row between small"><span>Your bid: <strong>${rs(q.price)}</strong> × ${num(q.qty)}${b.my_rank ? ` · <strong>#${b.my_rank}</strong> of ${b.count}` : ''}</span>${statusBadge(q.status === 'chosen' ? 'ordered' : q.status === 'lost' ? 'expired' : b.my_rank === 1 ? 'open' : 'quoted')}</div>` : ''}
      ${r.target_status === 'passed' ? '<span class="small muted">You said not in stock</span>' : ''}
      ${open ? (stock && !q ? `<button type="button" class="btn primary block" data-instant="${r.id}">${icons.bolt} Bid ${rs(stock.stock_price)} now</button>
        <div class="grid3"><button type="button" class="btn small" data-pass="${r.id}">Not in stock</button><a class="btn small outline" href="#/s/quote/${r.id}">Bid lower</a><a class="btn small" href="#/chat/new?with=${r.buyer_id}&request=${r.id}">Ask</a></div>`
        : `<div class="grid3"><button type="button" class="btn small" data-pass="${r.id}">Not in stock</button>
        <a class="btn small ${q ? 'outline' : 'primary'}" href="#/s/quote/${r.id}">${q ? 'Change bid' : 'Send bid'}</a><a class="btn small" href="#/chat/new?with=${r.buyer_id}&request=${r.id}">Ask</a></div>`)
        : r.status !== 'open' ? `<span class="small muted">Request ${esc(r.status)}</span>` : ''}
    </article>`;
  };

  render(shell({
    title: 'Buyer requests', eyebrow: `${me.name} · ${me.city}`, nav: navFor('inbox'),
    body: `
      <div class="chips">
        <a class="chip ${tab === 'open' ? 'on' : ''}" href="#/s/inbox?tab=open">Open ${open.length}</a>
        <a class="chip ${tab === 'quoted' ? 'on' : ''}" href="#/s/inbox?tab=quoted">Quoted ${quoted.length}</a>
        <a class="chip ${tab === 'orders' ? 'on' : ''}" href="#/s/inbox?tab=orders">Orders ${pending.length}</a>
      </div>
      ${c.unconfirmed_today ? `<section class="card tint" aria-label="Daily price check">
        <span><strong>Same prices as yesterday?</strong> ${c.unconfirmed_today} item${c.unconfirmed_today > 1 ? 's' : ''} not confirmed today</span>
        <div class="grid2"><button type="button" class="btn primary small" id="keep">Yes, keep</button><a class="btn outline small" href="#/s/shop">Change some</a></div>
      </section>` : ''}
      ${tab !== 'orders' ? pending.map((o) => `<a class="card accent" href="#/order/${o.id}">
        <span class="label-caps" style="color:var(--brand-dark)">Order to confirm</span>
        <span class="strong">${esc(o.buyer_name)} ordered ${esc(o.model_name)} × ${num(o.qty)}</span>
        <span class="small muted">${rs(o.price)} each · ${o.token_proof ? 'token proof attached' : 'no token proof yet'} · ${ago(o.created_at)}</span></a>`).join('') : ''}
      ${tab === 'orders' ? (pending.length ? pending.map((o) => `<a class="card" href="#/order/${o.id}"><span class="strong">${esc(o.buyer_name)}: ${esc(o.model_name)} × ${num(o.qty)}</span>
          <span class="small muted">${rs(o.total)} total · ${ago(o.created_at)}</span></a>`).join('') : emptyState('No orders waiting for you. All orders are under Deals.', '<a class="btn" href="#/deals">Open deals</a>'))
        : list.length ? list.map(reqCard).join('')
          : emptyState(tab === 'open' ? 'No open requests right now. When an installer asks for something you sell, it appears here and on your WhatsApp.' : 'Requests you have answered appear here.')}
    `,
  }));
  $('#keep')?.addEventListener('click', (e) => run(e.target, async () => {
    const r = await api('POST', '/api/listings/confirm-all');
    toast(`${r.confirmed} prices confirmed for today`);
    location.hash = '#/s/inbox?tab=' + tab + '&t=' + Date.now();
  }));
  $$('[data-pass]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api('POST', `/api/requests/${b.dataset.pass}/pass`);
    toast('Marked as not in stock');
    location.hash = '#/s/inbox?tab=' + tab + '&t=' + Date.now();
  })));
  $$('[data-instant]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    const x = await api('POST', `/api/requests/${b.dataset.instant}/instant-bid`);
    toast(x.board.mode === 'open' ? `Bid placed. You are #${x.board.my_rank} of ${x.board.count}.` : 'Bid placed.');
    location.hash = '#/s/inbox?tab=' + tab + '&t=' + Date.now();
  })));
  // New requests and new bids arrive without a refresh.
  const sig = JSON.stringify(reqs.map((r) => [r.id, r.board?.count, r.board?.lowest, r.target_status])) + pending.length;
  poll(async () => {
    const [r2, o2] = await Promise.all([api('GET', '/api/requests'), api('GET', '/api/orders')]);
    const s2 = JSON.stringify(r2.map((r) => [r.id, r.board?.count, r.board?.lowest, r.target_status])) + o2.filter((o) => o.supplier_id === me.id && o.status === 'pending').length;
    if (s2 !== sig) location.hash = '#/s/inbox?tab=' + tab + '&t=' + Date.now();
  }, 6000);
}, { role: 'supplier' });

route('/s/quote/:id', async ({ params, render }) => {
  const d = await api('GET', `/api/requests/${params.id}`);
  const r = d.request;
  const base = d.my_quote || d.my_listing || {};
  const what = d.model ? modelName(d.model) : r.description || catLabel[r.category];
  const boardHtml = (b) => `<div class="row between"><span class="label-caps">${b.mode === 'open' ? 'Live bids' : 'Sealed bidding'}</span><span class="tiny muted">updates live</span></div>
      ${b.count ? `<div class="grid3">
        <div class="stack" style="gap:0"><span class="big">${b.count}</span><span class="tiny muted">bids</span></div>
        <div class="stack" style="gap:0"><span class="big">${b.mode === 'open' ? rs(b.lowest) : 'hidden'}</span><span class="tiny muted">lowest bid</span></div>
        <div class="stack" style="gap:0"><span class="big" style="color:${b.my_rank === 1 ? 'var(--ok)' : 'var(--brand-dark)'}">${b.my_rank ? '#' + b.my_rank : '–'}</span><span class="tiny muted">your place</span></div></div>`
        : '<span class="small">No bids yet. The first good bid sets the price to beat.</span>'}
      ${b.mode === 'open' && b.lowest && b.my_rank !== 1 ? `<button type="button" class="btn outline small" id="beat" data-price="${b.lowest - 1000}">Beat the lowest: bid ${rs(b.lowest - 1000)}</button>` : ''}
      ${b.mode === 'sealed' ? '<span class="tiny muted">The buyer chose sealed bidding: suppliers see only their own bid.</span>' : ''}`;
  render(shell({
    title: d.my_quote ? 'Your bid' : 'Send a bid', eyebrow: `to ${d.buyer.name}${d.buyer.with_you ? ` · traded ${d.buyer.with_you}×` : ''}`, back: '#/s/inbox',
    actions: `<a class="btn small" href="#/chat/new?with=${d.buyer.id}&request=${r.id}">${icons.msg} Chat</a>`,
    body: `
      <section class="card"><span class="label-caps">They need</span><span class="big">${esc(what)} × ${num(r.qty)}</span>
        <span class="small muted">${esc(r.city)}${r.needed_by ? ' · by ' + esc(day(r.needed_by)) : ''}</span>
        ${d.my_listing ? `<span class="small">${d.my_listing.qty > 0 ? `<span class="badge brand">${icons.bolt} In stock</span> ` : ''}Your shop price: <strong>${rs(d.my_listing.price)}</strong> · ${num(d.my_listing.qty)} in stock</span>` : ''}</section>
      <section class="card ${d.board.my_rank === 1 ? '' : 'tint'}" id="board">${boardHtml(d.board)}</section>
      ${d.bid_history.length > 1 ? `<details class="card"><summary class="strong small">Your bid history</summary>${d.bid_history.map((h) => `<div class="row between small"><span>${rs(h.price)} × ${num(h.qty)}</span><span class="muted">${ago(h.at)}</span></div>`).join('')}</details>` : ''}
      ${r.status !== 'open' ? `<div class="card warn">This request is ${esc(r.status)}. You can no longer bid.</div>` : ''}
      <form id="f" class="stack" style="gap:14px">
        ${!d.model ? `<div class="field"><span class="flabel">Which model are you offering?</span>
          <div class="searchbox">${icons.search}<input type="search" id="mq" placeholder="Search brand or model" aria-label="Search model"></div>
          <div class="result-list" id="mres"></div><input type="hidden" name="model_id">
          <span class="hint">Pick a model so the quote can also go into your shop.</span></div>` : ''}
        <div class="grid2">
          <label class="field"><span class="flabel">Price per ${esc(d.model?.unit || 'unit')} (Rs)</span><input class="big-input" name="price" inputmode="numeric" value="${base.price || ''}" required></label>
          <label class="field"><span class="flabel">You have in stock</span><input name="qty" type="number" min="1" value="${base.qty || r.qty}" required></label>
          <label class="field"><span class="flabel">Token money %</span><input name="token_pct" type="number" min="0" max="100" value="${base.token_pct ?? 20}"></label>
          <label class="field"><span class="flabel">Delivery in (days)</span><input name="lead_days" type="number" min="0" value="${base.lead_days ?? 2}"></label>
        </div>
        <section class="card">
          <label class="check"><input type="checkbox" name="share" ${base.share === 0 ? '' : 'checked'}><span class="stack" style="gap:2px"><span class="strong">Also show to other buyers</span>
            <span class="small muted">Adds this item to your shop at this price</span></span></label>
          <fieldset><legend>Who sees the exact price in your shop</legend>
            <label class="radio-card"><input type="radio" name="visibility" value="band" ${base.visibility !== 'exact' ? 'checked' : ''}><span class="small">Verified buyers and past partners. Others see a range.</span></label>
            <label class="radio-card"><input type="radio" name="visibility" value="exact" ${base.visibility === 'exact' ? 'checked' : ''}><span class="small">Everyone</span></label>
          </fieldset>
        </section>
        <button class="btn primary lg block" ${r.status !== 'open' ? 'disabled' : ''}>${d.my_quote ? 'Update my bid' : 'Place bid'}</button>
        <p class="small muted center">You can revise your bid until the buyer orders. You can also reply on WhatsApp with just the price.</p>
      </form>`,
  }));
  const bindBeat = () => $('#beat')?.addEventListener('click', (e) => { $('#f').price.value = e.target.dataset.price; $('#f').price.focus(); });
  bindBeat();
  let lastBoard = JSON.stringify(d.board);
  poll(async () => {
    const b = await api('GET', `/api/requests/${r.id}/board`);
    const s = JSON.stringify({ count: b.count, mode: b.mode, my_rank: b.my_rank, my_price: b.my_price, lowest: b.lowest });
    if (s !== lastBoard) {
      lastBoard = s;
      $('#board').innerHTML = boardHtml(b);
      $('#board').classList.toggle('tint', b.my_rank !== 1);
      bindBeat();
    }
  }, 4000);
  if (!d.model) {
    const mq = $('#mq');
    const show = async () => {
      const rows = await api('GET', `/api/catalog?category=${r.category}&q=${encodeURIComponent(mq.value)}`);
      $('#mres').innerHTML = rows.slice(0, 8).map((m) => `<button type="button" data-id="${m.id}">${esc(modelName(m))} <span class="small muted">${esc(m.specs || '')}</span></button>`).join('')
        || '<button type="button" disabled>No match. Send the quote without a model.</button>';
      $$('#mres [data-id]').forEach((b) => b.onclick = () => {
        $('#f').model_id.value = b.dataset.id;
        $$('#mres button').forEach((x) => x.classList.toggle('on', x === b));
      });
    };
    mq.oninput = show;
    show();
  }
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { price: f.price.value, qty: f.qty.value, token_pct: f.token_pct.value, lead_days: f.lead_days.value,
      share: f.share.checked, visibility: f.visibility.value, model_id: f.model_id?.value || undefined };
    run(e.submitter, async () => {
      await api('POST', `/api/requests/${params.id}/quote`, body);
      toast(body.share && (d.model || body.model_id) ? 'Bid placed and added to your shop' : 'Bid placed');
      location.hash = `#/s/quote/${params.id}?t=${Date.now()}`;
    });
  };
}, { role: 'supplier' });

route('/s/shop', async ({ render }) => {
  await refreshMe();
  const items = await api('GET', '/api/shop');
  const src = { team: ['Set up by team', ''], quote: ['From your quote', 'green'], manual: ['Added by you', ''] };
  const fromTeam = items.filter((i) => i.source === 'team').length;
  const fromQuote = items.filter((i) => i.source === 'quote').length;
  render(shell({
    title: 'My shop', eyebrow: `${state.me.name} · ${state.me.city}`, nav: navFor('shop'),
    body: `
      <p class="small muted">${items.length} items. ${fromTeam} set up by our team, ${fromQuote} added from your quotes. You never need to type a catalogue: answering requests fills your shop.</p>
      ${state.counts.unconfirmed_today ? `<section class="card tint"><span><strong>Same prices as yesterday?</strong> ${state.counts.unconfirmed_today} item(s) not confirmed today</span>
        <button type="button" class="btn primary small" id="keep">Yes, confirm all</button></section>` : ''}
      ${items.map((l) => {
        const f = freshness(l.stale_days, l.confirmed_at);
        return `<a class="card" href="#/s/listing/${l.id}" style="${l.visible ? '' : 'opacity:.7'}">
          <div class="row between top"><span class="stack" style="gap:2px"><span class="small muted">${esc(catLabel[l.category])} · ${esc(l.brand)}</span>
            <span class="strong">${esc(l.name)}</span></span><span class="badge ${src[l.source][1]}">${src[l.source][0]}</span></div>
          <div class="row between"><span class="price">${rs(l.price)} <span class="small muted" style="font-weight:400">/ ${esc(l.unit)}</span></span>
            ${l.visible ? (l.qty > 0 ? `<span class="small">${num(l.qty)} in stock</span>` : '<span class="badge amber">Out of stock</span>') : '<span class="badge">Hidden</span>'}</div>
          <div class="row wrap small muted"><span class="${f.cls ? 'badge amber' : ''}">${esc(f.text)}</span><span>·</span>
            <span>${l.visibility === 'exact' ? 'exact price for everyone' : 'others see a range'}</span>${l.model_status === 'pending' ? '<span class="badge amber">Model awaiting approval</span>' : ''}</div>
        </a>`;
      }).join('') || emptyState('Your shop is empty. Answer a buyer request and the item is added here.')}
      <a class="btn block" href="#/s/add" style="border-style:dashed">Add an item by hand</a>`,
  }));
  $('#keep')?.addEventListener('click', (e) => run(e.target, async () => {
    const r = await api('POST', '/api/listings/confirm-all');
    toast(`${r.confirmed} prices confirmed for today`);
    location.hash = '#/s/shop?t=' + Date.now();
  }));
}, { role: 'supplier' });

route('/s/listing/:id', async ({ params, render }) => {
  const items = await api('GET', '/api/shop');
  const l = items.find((x) => String(x.id) === params.id);
  if (!l) throw new Error('Item not found in your shop');
  const hist = await api('GET', `/api/listings/${l.id}/history`);
  render(shell({
    title: `${l.brand} ${l.name}`, eyebrow: catLabel[l.category], back: '#/s/shop',
    body: `
      <form id="f" class="stack" style="gap:14px">
        <div class="grid2">
          <label class="field"><span class="flabel">Price per ${esc(l.unit)} (Rs)</span><input class="big-input" name="price" inputmode="numeric" value="${l.price}" required></label>
          <label class="field"><span class="flabel">In stock</span><input name="qty" type="number" min="0" value="${l.qty}"></label>
          <label class="field"><span class="flabel">Minimum order</span><input name="min_order" type="number" min="1" value="${l.min_order}"></label>
          <label class="field"><span class="flabel">Token money %</span><input name="token_pct" type="number" min="0" max="100" value="${l.token_pct}"></label>
          <label class="field"><span class="flabel">Delivery in (days)</span><input name="lead_days" type="number" min="0" value="${l.lead_days}"></label>
        </div>
        <fieldset><legend>Who sees the exact price</legend>
          <label class="radio-card"><input type="radio" name="visibility" value="band" ${l.visibility !== 'exact' ? 'checked' : ''}><span class="small">Verified buyers and past partners. Others see ${rs(l.band[0])} – ${num(l.band[1])}.</span></label>
          <label class="radio-card"><input type="radio" name="visibility" value="exact" ${l.visibility === 'exact' ? 'checked' : ''}><span class="small">Everyone</span></label>
        </fieldset>
        <label class="check"><input type="checkbox" name="visible" ${l.visible ? 'checked' : ''}><span>Show this item to buyers</span></label>
        <button class="btn primary lg block">Save and confirm today</button>
      </form>
      <section class="card"><span class="label-caps">Price history</span>
        ${hist.map((h) => `<div class="row between small"><span>${rs(h.price)}</span><span class="muted">${esc(h.source)} · ${new Date(h.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>`).join('')}</section>`,
  }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    run(e.submitter, async () => {
      await api('PUT', `/api/listings/${l.id}`, { price: f.price.value, qty: f.qty.value, min_order: f.min_order.value, token_pct: f.token_pct.value,
        lead_days: f.lead_days.value, visibility: f.visibility.value, visible: f.visible.checked });
      toast('Saved');
      location.hash = '#/s/shop';
    });
  };
}, { role: 'supplier' });

route('/s/add', async ({ render }) => {
  render(shell({
    title: 'Add an item', back: '#/s/shop',
    body: `
      <p class="small muted">Most items get added when you answer buyer requests. Use this for stock you want buyers to find before anyone asks.</p>
      <div class="field"><span class="flabel">Model</span><div class="searchbox">${icons.search}<input type="search" id="mq" placeholder="Search brand or model, e.g. Growatt 6000" aria-label="Search model"></div>
        <div class="result-list" id="mres"></div></div>
      <details class="card"><summary class="strong">Can’t find it? Submit a new model</summary>
        <form id="nm" class="stack" style="gap:10px;margin-top:10px">
          <label class="field"><span class="flabel">Category</span><select name="category">${Object.entries(catLabel).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <div class="grid2"><label class="field"><span class="flabel">Brand</span><input name="brand" required></label><label class="field"><span class="flabel">Model name</span><input name="name" required></label></div>
          <label class="field"><span class="flabel">One key spec</span><input name="specs" placeholder="e.g. 6 kW hybrid, single phase"></label>
          <button class="btn outline">Submit model</button><p class="tiny muted">You can list it straight away; our team checks the name so buyers find it.</p></form></details>
      <form id="f" class="stack hidden" style="gap:14px">
        <div class="card tint"><span class="small">Selected</span><span class="strong" id="sel"></span></div>
        <input type="hidden" name="model_id">
        <div class="grid2">
          <label class="field"><span class="flabel">Price (Rs)</span><input class="big-input" name="price" inputmode="numeric" required></label>
          <label class="field"><span class="flabel">In stock</span><input name="qty" type="number" min="0" value="1"></label>
          <label class="field"><span class="flabel">Minimum order</span><input name="min_order" type="number" min="1" value="1"></label>
          <label class="field"><span class="flabel">Token money %</span><input name="token_pct" type="number" min="0" max="100" value="20"></label>
        </div>
        <fieldset><legend>Who sees the exact price</legend>
          <label class="radio-card"><input type="radio" name="visibility" value="band" checked><span class="small">Verified buyers and past partners. Others see a range.</span></label>
          <label class="radio-card"><input type="radio" name="visibility" value="exact"><span class="small">Everyone</span></label></fieldset>
        <button class="btn primary lg block">Add to my shop</button>
      </form>`,
  }));
  const pick = (m) => {
    $('#f').classList.remove('hidden');
    $('#f').model_id.value = m.id;
    $('#sel').textContent = `${modelName(m)}${m.status === 'pending' ? ' (awaiting approval)' : ''}`;
    $('#f').price.focus();
  };
  const show = async () => {
    const rows = await api('GET', `/api/catalog?q=${encodeURIComponent($('#mq').value)}`);
    $('#mres').innerHTML = rows.slice(0, 8).map((m) => `<button type="button" data-id="${m.id}"><span class="strong">${esc(modelName(m))}</span> <span class="small muted">${esc(catLabel[m.category])} · ${esc(m.specs || '')}</span></button>`).join('')
      || '<button type="button" disabled>No match. Submit it as a new model below.</button>';
    $$('#mres [data-id]').forEach((b) => b.onclick = () => pick(rows.find((x) => String(x.id) === b.dataset.id)));
  };
  $('#mq').oninput = show;
  show();
  $('#nm').onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      const m = await api('POST', '/api/models', Object.fromEntries(new FormData(e.target)));
      e.target.closest('details').open = false;
      pick(m);
    });
  };
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      await api('POST', '/api/listings', Object.fromEntries(new FormData(e.target)));
      toast('Added to your shop');
      location.hash = '#/s/shop';
    });
  };
}, { role: 'supplier' });
