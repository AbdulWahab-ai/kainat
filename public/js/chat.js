// In-app chat between a buyer and a supplier: share requirements, photos, spec sheets, and see bids in the same thread.
import { route, render, shell, navFor, api, esc, rs, num, ago, toast, state, run, $, $$, typeLabel, emptyState, refreshMe,
  fileToDataUrl, icons, poll, bizBadges, statusBadge } from './core.js';

route('/chats', async ({ render }) => {
  await refreshMe();
  const chats = await api('GET', '/api/chats');
  render(shell({
    title: 'Chats', eyebrow: 'Talk to buyers and suppliers without sharing your number', nav: navFor('chats'),
    actions: `<a class="btn small" href="#/whatsapp">WhatsApp</a>`,
    body: chats.map((c) => `<a class="card ${c.unread ? 'accent' : ''}" href="#/chat/${c.id}">
        <div class="row between"><span class="strong">${esc(c.other.name)}</span><span class="tiny muted nowrap">${ago(c.last?.at || c.last_at)}</span></div>
        ${c.request ? `<span class="small"><span class="badge brand">Request #${c.request.id}</span> ${esc(c.request.what)} × ${num(c.request.qty)}</span>` : `<span class="small muted">${esc(typeLabel[c.other.supplier_type] || (c.other.role === 'buyer' ? 'Installer' : ''))} · ${esc(c.other.city || '')}</span>`}
        <div class="row between"><span class="small ${c.unread ? 'strong' : 'muted'}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.last ? (c.last.mine ? 'You: ' : '') + esc(c.last.body) : 'No messages yet'}</span>
          ${c.unread ? `<span class="badge dark">${c.unread}</span>` : ''}</div></a>`).join('')
      || emptyState(state.me.role === 'buyer' ? 'No chats yet. Open a supplier or a bid and tap Chat to ask about stock, warranty or delivery.' : 'No chats yet. When a buyer messages you, or you ask about a request, it shows here.',
        state.me.role === 'buyer' ? '<a class="btn primary" href="#/b/search">Find suppliers</a>' : '<a class="btn primary" href="#/s/inbox">Open requests</a>'),
  }));
});

// Opens (or creates) the chat with a business, optionally about one request, then shows it.
route('/chat/new', async ({ query, render }) => {
  const r = await api('POST', '/api/chats', { with_id: query.with, request_id: query.request || undefined });
  location.replace(`#/chat/${r.id}`);
});

function bubble(m, me, convId) {
  if (m.kind === 'bid') {
    return `<div class="bubble ${m.sender_id === me.id ? 'me' : 'them'}" style="border:1px solid var(--brand-line)"><span class="label-caps" style="color:var(--brand-dark)">${icons.bolt} ${esc(m.sender_name || '')}</span><br>${esc(m.body)}<div class="meta">${ago(m.at)}</div></div>`;
  }
  if (m.kind === 'system') return `<div class="center tiny muted">${esc(m.body)}</div>`;
  const file = m.has_file ? (/\.pdf$/i.test(m.attachment_name || '') ? `<a href="/api/chats/${convId}/files/${m.id}" target="_blank" rel="noopener" class="badge">PDF: ${esc(m.attachment_name)}</a>`
    : `<a href="/api/chats/${convId}/files/${m.id}" target="_blank" rel="noopener"><img src="/api/chats/${convId}/files/${m.id}" alt="${esc(m.attachment_name || 'Attachment')}" style="max-width:220px;max-height:220px;border-radius:8px;display:block;margin-top:4px"></a>`) : '';
  return `<div class="bubble ${m.sender_id === me.id ? 'me' : 'them'}">${m.body ? esc(m.body) : ''}${file}<div class="meta">${ago(m.at)}</div></div>`;
}

route('/chat/:id', async ({ params, render }) => {
  const me = state.me;
  const d = await api('GET', `/api/chats/${params.id}`);
  const c = d.conversation;
  let lastId = d.messages.at(-1)?.id || 0;
  const isBuyer = me.id === c.buyer_id;
  const q = c.quote;
  const r = c.request;
  const bidBar = r ? `<section class="card ${q && q.status === 'active' ? 'tint' : ''}" id="bidbar">
      <div class="row between"><span class="small"><strong>Request #${r.id}</strong> · ${esc(r.what)} × ${num(r.qty)}</span>${statusBadge(r.status)}</div>
      ${q ? `<div class="row between"><span><span class="price">${rs(q.price)}</span> <span class="small muted">× ${num(q.qty)} · ${q.token_pct}% token · ${q.lead_days ? q.lead_days + ' day(s)' : 'same day'}</span></span>
        ${isBuyer ? (r.status === 'open' && q.status === 'active' ? `<a class="btn primary small" href="#/b/order/new?quote=${q.id}">Accept bid</a>` : '')
          : (r.status === 'open' ? `<a class="btn outline small" href="#/s/quote/${r.id}">Change bid</a>` : '')}</div>
        ${c.board && c.board.mode === 'open' && c.board.count > 1 ? `<span class="tiny muted">${c.board.count} bids · lowest ${rs(c.board.lowest)}${!isBuyer && c.board.my_rank ? ` · you are #${c.board.my_rank}` : ''}</span>` : ''}`
        : isBuyer ? '<span class="small muted">No bid from this supplier yet. Ask them here.</span>'
          : r.status === 'open' ? `<a class="btn primary small" href="#/s/quote/${r.id}">Send a bid</a>` : ''}
    </section>` : '';
  render(shell({
    title: c.other.name, eyebrow: `${typeLabel[c.other.supplier_type] || (c.other.role === 'buyer' ? 'Installer' : '')} · ${c.other.city || ''} · ${c.other.deals} deal${c.other.deals === 1 ? '' : 's'}`,
    back: '#/chats',
    actions: isBuyer ? `<a class="btn small" href="#/b/supplier/${c.other.id}">Profile</a>` : '',
    body: `
      <div class="row wrap">${bizBadges(c.other, { forBuyer: isBuyer })}</div>
      ${bidBar}
      <div class="stack" id="thread" style="gap:8px">${d.messages.map((m) => bubble(m, me, c.id)).join('') || '<p class="small muted center">Say hello. Share the model, quantity, site and anything that matters: warranty, delivery time, batch, photos.</p>'}</div>
      <div id="att" class="row small hidden"><span class="badge" id="attname"></span><button type="button" class="link-btn" id="attclear">Remove</button></div>
      <form id="send" class="composer" style="position:sticky;bottom:72px;background:var(--bg);padding:6px 0">
        <label class="icon-btn" title="Attach a photo or PDF" style="border:1px solid var(--line-2);background:var(--card)">${icons.clip}<input type="file" id="file" accept="image/*,application/pdf" class="hidden" aria-label="Attach a photo or PDF"></label>
        <input name="body" placeholder="Message ${esc(c.other.name)}" aria-label="Message" autocomplete="off">
        <button class="btn primary" aria-label="Send">${icons.send}</button>
      </form>`,
    nav: navFor('chats'),
  }));
  const thread = $('#thread');
  const toBottom = () => window.scrollTo(0, document.body.scrollHeight);
  toBottom();
  const file = $('#file');
  file.onchange = () => {
    const f = file.files[0];
    $('#att').classList.toggle('hidden', !f);
    $('#attname').textContent = f ? f.name : '';
  };
  $('#attclear').onclick = () => { file.value = ''; file.onchange(); };
  const pull = async () => {
    const x = await api('GET', `/api/chats/${c.id}?after=${lastId}`);
    if (x.messages.length) {
      if (!lastId) thread.innerHTML = '';
      thread.insertAdjacentHTML('beforeend', x.messages.map((m) => bubble(m, me, c.id)).join(''));
      lastId = x.messages.at(-1).id;
      toBottom();
    }
  };
  $('#send').onsubmit = (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    const f = file.files[0];
    if (!body && !f) return;
    run(e.submitter, async () => {
      if (f && f.size > 6 * 1024 * 1024) throw new Error('Attachment is larger than 6 MB');
      await api('POST', `/api/chats/${c.id}/messages`, { body, attachment: f ? await fileToDataUrl(f) : undefined, attachment_name: f?.name });
      e.target.body.value = '';
      file.value = ''; file.onchange();
      await pull();
    });
  };
  poll(pull, 3000);
  void toast; void $$;
});
