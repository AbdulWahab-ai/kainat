// Buyer side: search, compare, supplier profile, requests, ordering.
import { route, render, shell, navFor, api, esc, rs, num, ago, day, toast, state, run, $, $$, catLabel, typeLabel, modelName,
  emptyState, statusBadge, refreshMe, priceText, bizBadges, fileToDataUrl, icons, todayISO, until, plural, poll, starText, sendGuarded } from './core.js';

const CATS = [['', 'All'], ['panel', 'Panels'], ['inverter', 'Inverters'], ['battery', 'Batteries'], ['structure', 'Structures'], ['cable', 'Cables']];

route('/b/search', async ({ query, render }) => {
  await refreshMe();
  const me = state.me;
  const q = query.q || '';
  const cat = query.cat || '';
  const instock = query.instock !== '0';
  const city = query.city ?? me.city ?? '';
  const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}&category=${cat}&instock=${instock ? 1 : 0}&city=${encodeURIComponent(city)}`);
  const link = (o) => {
    const p = new URLSearchParams({ q, cat, instock: instock ? '1' : '0', city, ...o });
    return '#/b/search?' + p.toString();
  };
  render(shell({
    title: 'Find equipment', eyebrow: `${me.name} · delivering to ${city || 'any city'}`, nav: navFor('search'),
    body: `
      <form id="sf" class="searchbox" role="search">${icons.search}<input type="search" name="q" value="${esc(q)}" placeholder="Model or brand, e.g. Growatt 10" aria-label="Search model or brand"></form>
      <div class="chips">${CATS.map(([k, v]) => `<a class="chip ${cat === k ? 'on' : ''}" href="${link({ cat: k })}">${v}</a>`).join('')}</div>
      <div class="chips"><a class="chip green ${instock ? 'on' : ''}" href="${link({ instock: instock ? '0' : '1' })}">In stock only</a>
        <a class="chip ${city ? 'on' : ''}" href="${link({ city: city ? '' : me.city || 'Lahore' })}">${city ? esc(city) : 'Any city'}</a></div>
      ${state.counts.new_quotes ? `<a class="card tint" href="#/b/requests"><span class="strong">${state.counts.new_quotes} quote${state.counts.new_quotes > 1 ? 's' : ''} waiting on your requests</span><span class="small">Compare and order</span></a>` : ''}
      <span class="label-caps">${results.length} model${results.length === 1 ? '' : 's'}${q ? ' match' : ' with live offers'}</span>
      ${results.map((r) => `<a class="card" href="#/b/model/${r.model.id}?city=${encodeURIComponent(city)}">
        <div class="row between"><span class="stack" style="gap:3px"><span class="small muted">${esc(catLabel[r.model.category])} · ${esc(r.model.specs || '')}</span>
          <span class="strong">${esc(modelName(r.model))}</span>
          <span class="small muted">${r.suppliers ? `${r.suppliers} supplier${r.suppliers > 1 ? 's' : ''} · from <strong style="color:var(--ink)">${r.from_exact ? '' : 'about '}${rs(r.from)}</strong>` : 'No live offers. Post a request.'}</span></span>
          ${icons.chevron}</div></a>`).join('') || emptyState('Nothing matches. Post a request and suppliers will quote you.')}
      <a class="card tint" href="#/b/request/new?q=${encodeURIComponent(q)}${cat ? '&cat=' + cat : ''}">
        <div class="row between"><span class="stack" style="gap:3px"><span class="strong">Not here, or want fresh prices?</span><span class="small">Post a request and suppliers quote you</span></span>${icons.chevron}</div></a>`,
  }));
  $('#sf').onsubmit = (e) => { e.preventDefault(); location.hash = link({ q: e.target.q.value.trim() }); };
}, { role: 'buyer' });

function offerCard(o, model) {
  const s = o.supplier;
  const stale = o.stale_days > 3;
  const action = o.kind === 'quote' ? `<a class="btn primary small" href="#/b/order/new?quote=${o.id}">Order</a>`
    : o.exact ? (o.qty > 0 ? `<a class="btn primary small" href="#/b/order/new?listing=${o.id}">Order</a>` : '<span class="badge amber">Out of stock</span>')
      : `<a class="btn outline small" href="#/b/request/new?listing=${o.id}">Get exact price</a>`;
  return `<article class="card ${o.kind === 'quote' ? 'accent' : ''}">
    <div class="row between top"><span class="stack" style="gap:3px"><a href="#/b/supplier/${s.id}" class="strong" style="color:var(--ink)">${esc(s.name)}</a>
      <span class="small muted">${esc(typeLabel[s.supplier_type] || '')} · ${s.deals} deal${s.deals === 1 ? '' : 's'}${o.kind === 'quote' ? ` · quoted ${ago(o.confirmed_at)} via ${o.channel === 'whatsapp' ? 'WhatsApp' : 'app'}` : ` · ${stale ? 'not confirmed for ' + o.stale_days + ' days' : 'confirmed ' + ago(o.confirmed_at)}`}</span></span>
      <span class="row wrap" style="justify-content:flex-end;gap:4px">${o.kind === 'quote' ? '<span class="badge dark">Your quote</span>' : ''}${bizBadges(s)}</span></div>
    <div class="row between"><span class="stack" style="gap:2px"><span class="price">${priceText(o)}</span>
      <span class="small muted">${o.qty > 0 ? num(o.qty) + ' available' : 'out of stock'}${o.min_order > 1 ? ` · min ${o.min_order}` : ''} · ${o.token_pct}% token · ${o.lead_days ? o.lead_days + ' day' + (o.lead_days > 1 ? 's' : '') : 'same day'}</span>
      ${!o.exact ? '<span class="tiny muted">Price range. The exact price comes with a quote.</span>' : ''}</span>${action}</div>
    <div class="row between">${stale ? '<span class="tiny" style="color:var(--amber)">Price may be out of date</span>' : '<span></span>'}
      <a class="small strong" href="#/chat/new?with=${s.id}${o.request_id ? '&request=' + o.request_id : ''}">${icons.msg} Chat</a></div>
  </article>`;
}

route('/b/model/:id', async ({ params, query, render }) => {
  const sort = query.sort || 'price';
  const d = await api('GET', `/api/models/${params.id}/offers?city=${encodeURIComponent(query.city || '')}`);
  const offers = [...d.offers];
  const mid = (o) => (o.exact ? o.price : (o.low + o.high) / 2);
  if (sort === 'deals') offers.sort((a, b) => b.supplier.deals - a.supplier.deals);
  if (sort === 'fast') offers.sort((a, b) => a.lead_days - b.lead_days || mid(a) - mid(b));
  // Suppliers without a score yet (fewer than 3 ratings) go after those with one.
  if (sort === 'rated') offers.sort((a, b) => (b.supplier.rating?.avg ?? -1) - (a.supplier.rating?.avg ?? -1) || mid(a) - mid(b));
  const l = (s) => `#/b/model/${params.id}?city=${encodeURIComponent(query.city || '')}&sort=${s}`;
  render(shell({
    title: modelName(d.model), eyebrow: `${catLabel[d.model.category]} · ${d.model.specs || ''} · ${offers.length} offer${offers.length === 1 ? '' : 's'}${query.city ? ' in ' + query.city : ''}`,
    back: '#/b/search',
    body: `
      <div class="chips"><a class="chip ${sort === 'price' ? 'on' : ''}" href="${l('price')}">Lowest price</a>
        <a class="chip ${sort === 'deals' ? 'on' : ''}" href="${l('deals')}">Most deals</a><a class="chip ${sort === 'rated' ? 'on' : ''}" href="${l('rated')}">Best rated</a><a class="chip ${sort === 'fast' ? 'on' : ''}" href="${l('fast')}">Fastest</a></div>
      ${offers.map((o) => offerCard(o, d.model)).join('') || emptyState('No supplier lists this model right now.')}
      <a class="btn outline block" href="#/b/request/new?model=${d.model.id}">Ask all suppliers for a fresh price</a>`,
  }));
}, { role: 'buyer' });

route('/b/supplier/:id', async ({ params, render }) => {
  const d = await api('GET', `/api/suppliers/${params.id}`);
  const s = d.supplier;
  render(shell({
    title: s.name, eyebrow: `${typeLabel[s.supplier_type] || 'Supplier'} · ${s.city}`, back: 'javascript:history.back()',
    actions: `<a class="btn primary small" href="#/chat/new?with=${s.id}">${icons.msg} Message</a>`,
    body: `
      <div class="row wrap">${bizBadges(s)}${s.docs_status === 'verified' ? '' : `<span class="badge">${s.docs_status === 'received' ? 'Documents under review' : 'Documents not checked'}</span>`}</div>
      <section class="grid3">
        <div class="metric"><span class="v">${s.deals}</span><span class="small muted">deals on app</span></div>
        <div class="metric"><span class="v">${s.rating?.avg !== null && s.rating?.avg !== undefined ? '★ ' + s.rating.avg.toFixed(1) : '–'}</span><span class="small muted">${s.rating?.count ? plural(s.rating.count, 'rating') : 'no ratings yet'}</span></div>
        <div class="metric" style="${s.with_you ? 'background:var(--brand-tint)' : ''}"><span class="v">${s.with_you || 0}</span><span class="small muted">with you</span></div>
      </section>
      ${s.my_last_rating ? `<span class="small muted">You rated them ${s.my_last_rating} ★ last time.</span>` : ''}
      ${d.reviews.length ? `<section class="card"><span class="label-caps">Ratings from buyers${s.rating?.top_tags?.length ? ' · ' + s.rating.top_tags.map((t) => esc(t.tag)).join(', ') : ''}</span>
        ${d.reviews.map((x) => `<div class="review"><span class="small"><span class="star-text" aria-label="${x.stars} of 5 stars">${starText(x.stars)}</span> · ${esc(x.rater_name)} · ${new Date(x.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          ${x.tags.length ? `<span class="row wrap" style="gap:4px">${x.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</span>` : ''}
          ${x.comment ? `<span class="small">“${esc(x.comment)}”</span>` : ''}
          ${x.reply ? `<div class="reply small"><span class="strong">${esc(s.name)} replied:</span> ${esc(x.reply)}</div>` : ''}</div>`).join('')}
        <span class="tiny muted">Only buyers with a delivered order can rate. The score uses each buyer’s latest rating from the last 12 months and shows from 3 ratings.</span></section>` : ''}
      <section class="card"><span class="label-caps">About</span>
        <span class="small">${esc(typeLabel[s.supplier_type] || '')} · ${s.years ? s.years + ' years in business · ' : ''}member since ${new Date(s.created_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
        <span class="small">Delivers to ${esc(s.delivery_cities || s.city)}</span>
        ${s.address ? `<span class="small">${esc(s.contact || '')}${s.contact ? ' · ' : ''}${esc(s.address)}</span>` : ''}
        <span class="private-note">${icons.lock} Phone numbers stay private on Kainat. <a href="#/chat/new?with=${s.id}">Message them here</a>.</span>
      </section>
      ${d.history.length ? `<section class="card"><span class="label-caps">Your history with them</span>
        ${d.history.map((h) => `<a class="row between small" href="#/order/${h.id}" style="color:inherit;text-decoration:none"><span>${esc((h.brand || '') + ' ' + (h.name || ''))} × ${h.qty}</span>
          <span class="muted">${esc(h.status)} · ${new Date(h.delivered_at || h.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></a>`).join('')}</section>` : ''}
      <section class="card"><span class="label-caps">In their shop</span>
        ${d.items.map((i) => `<a class="row between small" href="#/b/model/${i.model_id}" style="color:inherit;text-decoration:none"><span>${esc(i.brand + ' ' + i.name)}</span><span class="nowrap strong">${priceText(i)}</span></a>`).join('') || '<span class="small muted">No items listed</span>'}</section>
      <p class="tiny muted">Business details are provided by the supplier and checked by the Kainat team where marked verified.</p>`,
  }));
}, { role: 'buyer' });

route('/b/request/new', async ({ query, render }) => {
  const me = state.me;
  let preset = null;
  let listing = null;
  if (query.listing) {
    listing = await api('GET', `/api/listings/${query.listing}`);
    preset = listing.model;
  } else if (query.model) {
    preset = (await api('GET', `/api/models/${encodeURIComponent(query.model)}/offers`)).model;
  }
  const partners = 0;
  render(shell({
    title: listing ? 'Ask for the exact price' : 'Post a request', eyebrow: listing ? `to ${listing.supplier.name}` : 'Suppliers reply with quotes', back: 'javascript:history.back()',
    body: `
      <form id="f" class="stack" style="gap:14px">
        <div class="field"><span class="flabel">What do you need?</span>
          ${listing ? `<div class="card tint"><span class="strong">${esc(modelName(preset))}</span><span class="small">${esc(listing.supplier.name)} · range ${priceText(listing)}</span></div>`
            : `<div class="searchbox">${icons.search}<input type="search" id="mq" value="${esc(preset ? modelName(preset) : query.q || '')}" placeholder="Model, or a type like 5 kWh lithium battery" aria-label="What do you need"></div>
          <div class="result-list" id="mres"></div>
          <div id="free" class="grid2 hidden"><label class="field"><span class="flabel">Category</span><select name="category">${CATS.slice(1).map(([k, v]) => `<option value="${k}" ${query.cat === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="field"><span class="flabel">Description</span><input name="description" placeholder="e.g. 5 kWh lithium battery"></label></div>
          <span class="hint" id="pickhint">${preset ? 'Selected: ' + esc(modelName(preset)) : 'Pick a model, or use “any model” to describe it.'}</span>`}
          <input type="hidden" name="model_id" value="${preset && !listing ? preset.id : ''}">
        </div>
        <div class="grid2">
          <label class="field"><span class="flabel">Quantity</span><input name="qty" type="number" min="1" value="${listing ? Math.max(1, listing.min_order) : 1}" required></label>
          <label class="field"><span class="flabel">Needed by</span><input name="needed_by" type="date" min="${todayISO()}"></label>
        </div>
        <label class="field"><span class="flabel">Delivery city</span><input name="city" value="${esc(me.city || 'Lahore')}" required></label>
        ${listing ? '' : `<fieldset><legend>Send to</legend>
          <label class="radio-card"><input type="radio" name="scope" value="all" checked><span class="stack" style="gap:2px"><span class="strong">All matching suppliers in that city</span><span class="small muted">Importers, distributors and wholesalers who sell this category</span></span></label>
          <label class="radio-card"><input type="radio" name="scope" value="partners"><span class="stack" style="gap:2px"><span class="strong">Only suppliers I have traded with</span><span class="small muted">From your trade history</span></span></label>
        </fieldset>`}
        <fieldset><legend>Bidding</legend>
          <label class="radio-card"><input type="radio" name="bidding" value="open" checked><span class="stack" style="gap:2px"><span class="strong">Open bidding</span><span class="small muted">Suppliers see the lowest bid and can beat it. Usually gets you the best price.</span></span></label>
          <label class="radio-card"><input type="radio" name="bidding" value="sealed"><span class="stack" style="gap:2px"><span class="strong">Sealed bids</span><span class="small muted">Each supplier sees only their own bid.</span></span></label>
        </fieldset>
        <p class="small muted">Suppliers who have this model in stock are alerted instantly and can bid with one tap. Others get it on WhatsApp and in the app. Bids arrive live; requests close after 48 hours.</p>
        <button class="btn primary lg block">Send request</button>
      </form>`,
  }));
  void partners;
  const f = $('#f');
  if (!listing) {
    const mq = $('#mq');
    const show = async () => {
      const rows = await api('GET', `/api/catalog?q=${encodeURIComponent(mq.value)}`);
      $('#mres').innerHTML = rows.slice(0, 6).map((m) => `<button type="button" data-id="${m.id}" class="${String(m.id) === f.model_id.value ? 'on' : ''}"><span class="strong">${esc(modelName(m))}</span> <span class="small muted">${esc(catLabel[m.category])}</span></button>`).join('')
        + '<button type="button" data-free="1"><span class="strong">Any model</span> <span class="small muted">describe what you need</span></button>';
      $$('#mres [data-id]').forEach((b) => b.onclick = () => {
        f.model_id.value = b.dataset.id;
        $('#free').classList.add('hidden');
        $('#pickhint').textContent = 'Selected: ' + b.querySelector('.strong').textContent;
        $$('#mres button').forEach((x) => x.classList.toggle('on', x === b));
      });
      $('#mres [data-free]').onclick = (e) => {
        f.model_id.value = '';
        $('#free').classList.remove('hidden');
        f.description.value = mq.value;
        $('#pickhint').textContent = 'Any model: suppliers in this category will quote.';
        $$('#mres button').forEach((x) => x.classList.toggle('on', x === e.currentTarget));
      };
    };
    mq.oninput = () => { f.model_id.value = ''; show(); };
    show();
  }
  f.onsubmit = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    if (listing) body.listing_id = listing.id;
    if (!listing && !body.model_id && $('#free').classList.contains('hidden')) { toast('Pick a model from the list, or choose “Any model”', 'error'); return; }
    run(e.submitter, async () => {
      const r = await sendGuarded((mask) => api('POST', '/api/requests', { ...body, mask }), { text: body.description || '' });
      if (!r) { f.description?.focus(); return; }
      toast(r.sent_to ? `Sent to ${r.sent_to} supplier${r.sent_to > 1 ? 's' : ''}${r.in_stock ? `. ${r.in_stock} ha${r.in_stock > 1 ? 've' : 's'} it in stock now` : ''}${r.later ? `. ${r.later} more get it in 30 minutes if bids are slow.` : '.'}` : 'Posted. No matching supplier yet; our team will find one.');
      location.hash = `#/b/request/${r.id}`;
    });
  };
}, { role: 'buyer' });

route('/b/requests', async ({ render }) => {
  await refreshMe();
  const reqs = await api('GET', '/api/requests');
  render(shell({
    title: 'My requests', nav: navFor('requests'),
    actions: `<a class="btn primary small" href="#/b/request/new">${icons.plus}New</a>`,
    body: reqs.map((r) => `<a class="card ${r.status === 'open' && r.quotes ? 'accent' : ''}" href="#/b/request/${r.id}">
        <div class="row between"><span class="strong">${esc(r.model_id ? r.brand + ' ' + r.name : r.description || catLabel[r.category])} × ${num(r.qty)}</span>${statusBadge(r.status)}</div>
        <span class="small muted">${esc(r.city)} · sent to ${r.sent_to} supplier${r.sent_to === 1 ? '' : 's'} · ${ago(r.created_at)}</span>
        <span class="small">${r.quotes ? `<strong>${r.quotes} bid${r.quotes > 1 ? 's' : ''}</strong> · best ${rs(r.best)}` : 'No bids yet'}</span></a>`).join('')
      || emptyState('No requests yet. Post one when you need prices.', '<a class="btn primary" href="#/b/request/new">Post a request</a>'),
  }));
}, { role: 'buyer' });

route('/b/request/:id', async ({ params, render }) => {
  const d = await api('GET', `/api/requests/${params.id}`);
  const r = d.request;
  const what = d.model ? modelName(d.model) : r.description || catLabel[r.category];
  render(shell({
    title: `${what} × ${num(r.qty)}`, eyebrow: `Request #${r.id} · ${r.city}${r.needed_by ? ' · by ' + day(r.needed_by) : ''}`, back: '#/b/requests',
    body: `
      <div class="row wrap">${statusBadge(r.status)}<span class="badge">${r.bidding === 'sealed' ? 'Sealed bids' : 'Open bidding'}</span><span class="small muted">Sent to ${d.targets.length} supplier${d.targets.length === 1 ? '' : 's'} ${ago(r.created_at)}${r.status === 'open' ? ' · ' + until(r.expires_at) : ''}</span></div>
      ${d.order ? `<a class="card tint" href="#/order/${d.order.id}"><span class="strong">Order #${d.order.id} placed</span><span class="small">${esc(d.order.status)}</span></a>` : ''}
      <div class="row between"><span class="label-caps">${d.quotes.length} bid${d.quotes.length === 1 ? '' : 's'}${d.quotes.length ? ', lowest first' : ''}</span>${r.status === 'open' ? '<span class="tiny muted">updates live</span>' : ''}</div>
      ${d.quotes.map((q, i) => `<article class="card ${q.status === 'chosen' || (i === 0 && r.status === 'open') ? 'accent' : ''}">
        <div class="row between top"><span class="stack" style="gap:3px"><a href="#/b/supplier/${q.supplier.id}" class="strong" style="color:var(--ink)">${esc(q.supplier.name)}</a>
          <span class="small muted">${esc(typeLabel[q.supplier.supplier_type] || '')} · ${plural(q.supplier.deals, 'deal')} · via ${q.channel === 'whatsapp' ? 'WhatsApp' : 'app'} ${ago(q.created_at)}</span></span>
          <span class="row wrap" style="justify-content:flex-end;gap:4px">${i === 0 && q.status === 'active' ? '<span class="badge brand">Best bid</span>' : ''}${bizBadges(q.supplier)}</span></div>
        ${q.model && !d.model ? `<span class="small">Offering ${esc(modelName(q.model))}</span>` : ''}
        <div class="row between"><span class="stack" style="gap:2px"><span class="price">${rs(q.price)}${q.revisions > 1 && q.first_price > q.price ? ` <span class="small" style="color:var(--ok);font-weight:600">down ${rs(q.first_price - q.price)}</span>` : ''}</span>
          <span class="small muted">${num(q.qty)} available · ${q.token_pct}% token · ${q.lead_days ? q.lead_days + ' day(s)' : 'same day'}${q.revisions > 1 ? ` · revised ${q.revisions - 1}×` : ''}</span></span>
          ${r.status === 'open' && q.status === 'active' ? `<a class="btn primary small" href="#/b/order/new?quote=${q.id}">Accept bid</a>` : statusBadge(q.status === 'chosen' ? 'ordered' : q.status === 'lost' ? 'expired' : r.status)}</div>
        <a class="small strong" href="${q.conversation_id ? '#/chat/' + q.conversation_id : `#/chat/new?with=${q.supplier.id}&request=${r.id}`}">${icons.msg} Chat with ${esc(q.supplier.name)}</a>
      </article>`).join('') || emptyState('No bids yet. Suppliers with stock are alerted instantly; bids appear here as they arrive.')}
      ${d.in_stock.length && r.status === 'open' ? `<span class="label-caps">${icons.bolt} In stock right now, not bid yet</span>
        ${d.in_stock.map((o) => `<article class="card"><div class="row between top"><a href="#/b/supplier/${o.supplier.id}" class="strong" style="color:var(--ink)">${esc(o.supplier.name)}</a><span class="row wrap" style="gap:4px">${bizBadges(o.supplier)}</span></div>
          <div class="row between"><span class="stack" style="gap:2px"><span class="price">${priceText(o)}</span><span class="small muted">${num(o.qty)} in stock · ${o.token_pct}% token · ${o.lead_days ? o.lead_days + ' day(s)' : 'same day'}</span></span>
            ${o.exact ? `<a class="btn outline small" href="#/b/order/new?listing=${o.id}">Order now</a>` : ''}</div>
          <a class="small strong" href="#/chat/new?with=${o.supplier.id}&request=${r.id}">${icons.msg} Ask them to bid</a></article>`).join('')}` : ''}
      <details class="card"><summary class="strong">Who received this request</summary>
        ${d.targets.map((t) => `<div class="row between small"><span>${esc(t.name)}</span>${statusBadge(t.status)}</div>`).join('') || '<span class="small muted">No supplier matched yet.</span>'}</details>
      ${r.status === 'open' && !d.quotes.length && r.wave >= 3 ? `<section class="card warn"><span class="strong">No bids yet</span>
        <span class="small">Send it to suppliers in other cities who sell this and deliver to ${esc(r.city)}.</span>
        <button type="button" id="widen" class="btn primary">Widen to other cities</button></section>` : ''}
      ${r.status === 'open' && r.wave === 1 && r.next_wave_at && Date.parse(r.next_wave_at) > Date.now() ? `<span class="tiny muted">More matching suppliers get this ${until(r.next_wave_at).replace('closes ', '')} if fewer than 2 bids arrive.</span>` : ''}
      ${r.status === 'open' ? `<details class="card"><summary class="strong">Invite my own supplier</summary>
        <p class="small muted">They get this request on WhatsApp and can quote without installing the app.</p>
        <form id="inv" class="stack" style="gap:10px"><label class="field"><span class="flabel">Business name</span><input name="name" required></label>
          <div class="grid2"><label class="field"><span class="flabel">Mobile number</span><input name="phone" type="tel" placeholder="0300 1234567" required></label>
          <label class="field"><span class="flabel">City</span><input name="city" value="${esc(r.city)}"></label></div>
          <button class="btn outline">Send invite</button></form></details>
        <button type="button" id="cancel" class="btn danger block">Cancel request</button>` : ''}`,
  }));
  if (r.status === 'open') {
    // Re-draw when a new bid or revision arrives, unless the buyer is typing in the invite form.
    const latest = (await api('GET', `/api/requests/${r.id}/board`)).latest;
    poll(async () => {
      const b = await api('GET', `/api/requests/${r.id}/board`);
      if ((b.latest !== latest || b.status !== r.status) && !document.activeElement?.matches('input, textarea')) {
        location.hash = `#/b/request/${r.id}?t=${Date.now()}`;
      }
    }, 4000);
  }
  $('#widen')?.addEventListener('click', (e) => run(e.target, async () => {
    const x = await api('POST', `/api/requests/${r.id}/widen`);
    toast(x.sent_to ? `Sent to ${plural(x.sent_to, 'more supplier')}` : 'No other supplier sells this yet. The Kainat team will look for one.');
    location.hash = `#/b/request/${r.id}?t=${Date.now()}`;
  }));
  $('#cancel')?.addEventListener('click', (e) => run(e.target, async () => {
    await api('POST', `/api/requests/${r.id}/cancel`);
    toast('Request cancelled');
    location.hash = '#/b/requests';
  }));
  $('#inv')?.addEventListener('submit', (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      const body = Object.fromEntries(new FormData(e.target));
      body.request_id = r.id;
      const x = await api('POST', '/api/invite-supplier', body);
      toast(x.targeted ? 'Invite sent with this request' : 'Invite sent');
      location.hash = `#/b/request/${r.id}?t=${Date.now()}`;
    });
  });
}, { role: 'buyer' });

route('/b/order/new', async ({ query, render }) => {
  const me = state.me;
  let item;
  if (query.quote) {
    const q = await api('GET', `/api/quotes/${query.quote}`);
    item = { kind: 'quote', id: q.id, model: q.model, supplier: q.supplier, price: q.price, qty_max: q.qty, min: 1, token_pct: q.token_pct,
      lead_days: q.lead_days, default_qty: Math.min(q.request.qty, q.qty), needed_by: q.request.needed_by };
  } else if (query.listing) {
    const l = await api('GET', `/api/listings/${query.listing}`);
    if (!l.exact) throw new Error('Ask this supplier for an exact price first.');
    item = { kind: 'listing', id: l.id, model: l.model, supplier: l.supplier, price: l.price, qty_max: l.qty, min: l.min_order, token_pct: l.token_pct,
      lead_days: l.lead_days, default_qty: Math.max(1, l.min_order) };
  } else throw new Error('Nothing selected to order');
  const addresses = await api('GET', '/api/addresses');
  const s = item.supplier;
  render(shell({
    title: 'Confirm order', eyebrow: `from ${s.name}`, back: 'javascript:history.back()',
    body: `
      <section class="card"><div class="row between top"><span class="stack" style="gap:2px"><span class="strong">${esc(modelName(item.model))}</span>
        <span class="small muted">${rs(item.price)} per ${esc(item.model?.unit || 'unit')} · ${num(item.qty_max)} available · ${item.lead_days ? item.lead_days + ' day(s)' : 'same day'}</span></span><span class="row wrap" style="justify-content:flex-end;gap:4px;min-width:0">${bizBadges(s)}</span></div>
        ${s.deals === 0 ? '<div class="card warn small">This supplier has no completed deals on the app yet. Check their documents and stock before paying token money.</div>' : ''}</section>
      <form id="f" class="stack" style="gap:14px">
        <label class="field"><span class="flabel">Quantity${item.min > 1 ? ` (minimum ${item.min})` : ''}</span><input name="qty" type="number" min="${item.min}" max="${item.qty_max}" value="${item.default_qty}" required></label>
        <label class="field"><span class="flabel">Delivery address</span><select name="addr">${addresses.map((a) => `<option value="${esc(a.text)}">${esc(a.label)}: ${esc(a.text)}</option>`).join('')}<option value="__new">+ New address</option></select></label>
        <div id="newaddr" class="stack ${addresses.length ? 'hidden' : ''}" style="gap:10px"><label class="field"><span class="flabel">New address</span><input name="address_new" placeholder="House, street, area, city"></label>
          <div class="grid2"><label class="field"><span class="flabel">Label</span><input name="address_label" placeholder="Site: Model Town"></label>
          <label class="check" style="align-self:end;height:46px"><input type="checkbox" name="save_address" checked>Save it</label></div></div>
        <div class="grid2"><label class="field"><span class="flabel">Needed by</span><input name="needed_by" type="date" min="${todayISO()}" value="${esc(item.needed_by || '')}"></label>
          <label class="field"><span class="flabel">Note</span><input name="note" placeholder="Gate at the back, deliver after 2 pm"></label></div>
        <section class="card"><div class="row between"><span>Total</span><span class="strong" id="total"></span></div>
          <div class="row between"><span>Token money to pay (${item.token_pct}%)</span><span class="strong" style="color:var(--brand-dark)" id="token"></span></div>
          <span class="tiny muted">Pay the token to the supplier’s bank account as usual, then upload the screenshot. Kainat does not hold money yet.</span></section>
        <div class="field"><span class="flabel">Token money screenshot</span>
          <label class="btn block" style="height:76px;border-style:dashed;flex-direction:column;gap:4px">${icons.camera}<span id="fname">Upload screenshot (image or PDF)</span>
            <input type="file" name="proof" accept="image/*,application/pdf" class="hidden"></label>
          <span class="hint">You can also add it later from the order page.</span></div>
        <button class="btn primary lg block">Send order</button>
        <p class="small muted center">The price is locked at ${rs(item.price)} when you send.</p>
      </form>`,
  }));
  const f = $('#f');
  const calc = () => {
    const q = Number(f.qty.value || 0);
    $('#total').textContent = rs(q * item.price);
    $('#token').textContent = rs(Math.round((q * item.price * item.token_pct) / 100));
  };
  f.qty.oninput = calc;
  calc();
  const toggleAddr = () => $('#newaddr').classList.toggle('hidden', f.addr.value !== '__new' && addresses.length > 0);
  f.addr.onchange = toggleAddr;
  if (!addresses.length) f.addr.value = '__new';
  f.proof.onchange = () => { $('#fname').textContent = f.proof.files[0]?.name || 'Upload screenshot'; };
  f.onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      const address = f.addr.value === '__new' ? f.address_new.value.trim() : f.addr.value;
      const file = f.proof.files[0];
      if (file && file.size > 6 * 1024 * 1024) throw new Error('Screenshot is larger than 6 MB');
      const body = { qty: f.qty.value, address, needed_by: f.needed_by.value, note: f.note.value,
        save_address: f.addr.value === '__new' && f.save_address.checked, address_label: f.address_label.value,
        token_proof: file ? await fileToDataUrl(file) : undefined };
      body[item.kind === 'quote' ? 'quote_id' : 'listing_id'] = item.id;
      const r = await sendGuarded((mask) => api('POST', '/api/orders', { ...body, mask }), { text: [body.address, body.note].filter(Boolean).join(' · '), partner: s.name });
      if (!r) { f.note.focus(); return; }
      toast('Order sent. The supplier has been notified on WhatsApp.');
      location.hash = `#/order/${r.id}`;
    });
  };
  void me;
}, { role: 'buyer' });
