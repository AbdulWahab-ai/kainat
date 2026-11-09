// Demo data so every screen has something real to show on first run.
// All businesses, people and prices here are made up for the demo.
import { run, get, now, tx } from './db.js';

const daysAgo = (d, h = 10) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(h, 0, 0, 0);
  return t.toISOString();
};

export function seed() {
  tx(() => {
    const t = now();

    // Catalogue
    const models = [
      ['panel', 'Longi', 'Hi-MO 6 580 W', 'Mono PERC, 580 W', 'panel'],
      ['panel', 'Jinko', 'Tiger Neo 585 W', 'N-type bifacial, 585 W', 'panel'],
      ['panel', 'JA Solar', 'JAM72S30 550 W', 'Mono PERC, 550 W', 'panel'],
      ['panel', 'Canadian Solar', 'HiKu7 600 W', 'Mono PERC, 600 W', 'panel'],
      ['inverter', 'Growatt', 'SPF 6000 ES Plus', 'Hybrid off-grid, 6 kW, single phase', 'unit'],
      ['inverter', 'Growatt', 'SPF 10000 ES', 'Hybrid off-grid, 10 kW, single phase', 'unit'],
      ['inverter', 'Growatt', 'MOD 10KTL3-X', 'On-grid, 10 kW, three phase', 'unit'],
      ['inverter', 'Huawei', 'SUN2000-10KTL-M1', 'On-grid, 10 kW, three phase', 'unit'],
      ['inverter', 'Inverex', 'Nitrox 6 kW', 'Hybrid, 6 kW, single phase', 'unit'],
      ['inverter', 'Deye', 'SUN-12K-SG04LP3', 'Hybrid, 12 kW, three phase', 'unit'],
      ['battery', 'Pylontech', 'US5000', 'LFP, 4.8 kWh, 48 V', 'unit'],
      ['battery', 'Pylontech', 'US3000C', 'LFP, 3.5 kWh, 48 V', 'unit'],
      ['battery', 'Dyness', 'B4850', 'LFP, 2.4 kWh, 48 V', 'unit'],
      ['battery', 'Narada', '51.2V 100Ah', 'LFP, 5.1 kWh, 51.2 V', 'unit'],
      ['structure', 'Local', 'Galvanised L2 structure (per panel)', 'Hot-dip galvanised, per panel', 'set'],
      ['cable', 'Pakistan Cables', 'DC solar cable 6 mm (100 m)', '6 mm² DC cable, 100 m roll', 'roll'],
    ];
    const M = {};
    for (const [category, brand, name, specs, unit] of models) {
      const r = run('INSERT INTO models (category, brand, name, specs, unit, status, created_at) VALUES (?,?,?,?,?,?,?)',
        category, brand, name, specs, unit, 'approved', t);
      M[`${brand} ${name}`] = Number(r.lastInsertRowid);
    }

    // Accounts
    const biz = (o) => Number(run(
      `INSERT INTO businesses (role, supplier_type, name, city, address, contact, phone, whatsapp, ntn, years, installs, buys,
        delivery_cities, verified, docs_status, setup_by, invited_by, claimed, status, is_admin, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      o.role, o.supplier_type, o.name, o.city, o.address, o.contact, o.phone, o.phone, o.ntn, o.years, o.installs, o.buys,
      o.delivery_cities, o.verified || 0, o.docs_status || 'pending', o.setup_by || 'self', o.invited_by || null,
      o.claimed ?? 1, 'active', o.is_admin || 0, o.created_at || daysAgo(120)).lastInsertRowid);

    biz({ role: 'admin', name: 'Kainat team', city: 'Lahore', contact: 'Ops', phone: '03000000000', is_admin: 1, verified: 1, docs_status: 'verified' });

    const alNoor = biz({ role: 'supplier', supplier_type: 'importer', name: 'Al-Noor Solar Imports', city: 'Lahore',
      address: 'Warehouse 14, Badami Bagh, Lahore', contact: 'Rashid', phone: '03001111111', ntn: '1234567-8', years: 9,
      delivery_cities: 'Lahore, Faisalabad, Gujranwala', verified: 1, docs_status: 'verified', setup_by: 'team', created_at: daysAgo(300) });
    const sunCity = biz({ role: 'supplier', supplier_type: 'distributor', name: 'Sun City Traders', city: 'Lahore',
      address: 'Shop 7, Hall Road, Lahore', contact: 'Bilal', phone: '03002222222', ntn: '2345678-9', years: 6,
      delivery_cities: 'Lahore', verified: 1, docs_status: 'verified', created_at: daysAgo(200) });
    const greenVolt = biz({ role: 'supplier', supplier_type: 'wholesaler', name: 'Green Volt Wholesale', city: 'Lahore',
      address: 'Plot 3, Ferozepur Road, Lahore', contact: 'Imran', phone: '03003333333', years: 4,
      delivery_cities: 'Lahore, Kasur', docs_status: 'received', created_at: daysAgo(150) });
    const bright = biz({ role: 'supplier', supplier_type: 'importer', name: 'Bright Power Co.', city: 'Lahore',
      address: 'Office 21, Main Boulevard, Gulberg, Lahore', contact: 'Sana', phone: '03004444444', years: 1,
      delivery_cities: 'Lahore', docs_status: 'pending', created_at: daysAgo(12) });
    const abbas = biz({ role: 'supplier', supplier_type: 'wholesaler', name: 'Abbas Solar Store', city: 'Sahiwal',
      address: 'Railway Road, Sahiwal', contact: 'Abbas', phone: '03005555555', years: 11,
      delivery_cities: 'Sahiwal, Okara, Pakpattan', docs_status: 'received', created_at: daysAgo(40) });
    // A shop the team built that has not been claimed yet: sign in with its number to see "Claim your shop".
    const newEra = biz({ role: 'supplier', supplier_type: 'distributor', name: 'New Era Energy', city: 'Lahore',
      address: 'Shop 2, Brandreth Road, Lahore', contact: 'Usman', phone: '03006666666', years: 5,
      delivery_cities: 'Lahore, Sheikhupura', docs_status: 'received', setup_by: 'team', claimed: 0, created_at: daysAgo(1) });

    const sunPeak = biz({ role: 'buyer', name: 'SunPeak Energy', city: 'Lahore', address: 'Office 5, Johar Town, Lahore',
      contact: 'Owner', phone: '03211111111', installs: '5 to 20', buys: 'Panels, Inverters, Batteries', verified: 1, created_at: daysAgo(280) });
    const greenRoof = biz({ role: 'buyer', name: 'Green Roof Solutions', city: 'Lahore', address: 'DHA Phase 5, Lahore',
      contact: 'Ahmed', phone: '03212222222', installs: '5 to 20', buys: 'Panels, Inverters', verified: 1, created_at: daysAgo(180) });
    const brightWorks = biz({ role: 'buyer', name: 'Bright Solar Works', city: 'Lahore', address: 'Model Town, Lahore',
      contact: 'Hamza', phone: '03213333333', installs: 'Under 5', buys: 'Batteries', created_at: daysAgo(60) });

    run('INSERT INTO addresses (buyer_id, label, text) VALUES (?,?,?)', sunPeak, 'Office', 'Office 5, Johar Town, Lahore');
    run('INSERT INTO addresses (buyer_id, label, text) VALUES (?,?,?)', sunPeak, 'Site: DHA Phase 6', 'House 112, Block C, DHA Phase 6, Lahore');

    // Listings: [supplier, model, price, qty, min, token, lead, visibility, source, confirmedDaysAgo]
    const L = [
      [alNoor, 'Longi Hi-MO 6 580 W', 17400, 320, 10, 20, 2, 'band', 'team', 0],
      [alNoor, 'Growatt SPF 10000 ES', 325000, 18, 1, 20, 2, 'band', 'team', 0],
      [alNoor, 'Growatt SPF 6000 ES Plus', 182000, 25, 1, 20, 2, 'band', 'team', 0],
      [alNoor, 'Pylontech US5000', 315000, 0, 1, 25, 3, 'band', 'team', 3],
      [alNoor, 'Jinko Tiger Neo 585 W', 18100, 200, 10, 20, 2, 'exact', 'quote', 1],
      [sunCity, 'Growatt SPF 10000 ES', 331000, 6, 1, 25, 0, 'exact', 'manual', 0],
      [sunCity, 'Longi Hi-MO 6 580 W', 17900, 90, 1, 25, 0, 'exact', 'manual', 0],
      [sunCity, 'Inverex Nitrox 6 kW', 168000, 12, 1, 25, 0, 'exact', 'manual', 0],
      [sunCity, 'Pylontech US3000C', 228000, 10, 1, 25, 1, 'exact', 'quote', 1],
      [greenVolt, 'Growatt SPF 10000 ES', 338000, 40, 1, 10, 1, 'exact', 'manual', 2],
      [greenVolt, 'JA Solar JAM72S30 550 W', 15600, 400, 20, 10, 1, 'exact', 'manual', 2],
      [greenVolt, 'Pakistan Cables DC solar cable 6 mm (100 m)', 21500, 60, 1, 10, 1, 'exact', 'manual', 2],
      [greenVolt, 'Local Galvanised L2 structure (per panel)', 6200, 500, 10, 10, 2, 'exact', 'manual', 4],
      [bright, 'Growatt SPF 10000 ES', 309000, 100, 2, 50, 4, 'exact', 'manual', 0],
      [bright, 'Deye SUN-12K-SG04LP3', 612000, 15, 1, 50, 4, 'exact', 'manual', 0],
      [abbas, 'Longi Hi-MO 6 580 W', 17100, 200, 5, 20, 1, 'band', 'quote', 1],
      [abbas, 'Inverex Nitrox 6 kW', 166000, 8, 1, 20, 1, 'band', 'quote', 1],
      [newEra, 'Pylontech US5000', 305000, 14, 1, 20, 1, 'band', 'team', 1],
      [newEra, 'Narada 51.2V 100Ah', 268000, 20, 1, 20, 1, 'band', 'team', 1],
      [newEra, 'Huawei SUN2000-10KTL-M1', 298000, 9, 1, 20, 2, 'band', 'team', 1],
    ];
    for (const [s, m, price, qty, min, token, lead, vis, source, conf] of L) {
      const at = daysAgo(conf, 9);
      const id = Number(run(`INSERT INTO listings (supplier_id, model_id, price, qty, min_order, token_pct, lead_days, visibility, source,
        visible, price_updated_at, confirmed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s, M[m], price, qty, min, token, lead, vis, source, qty > 0 ? 1 : 0, at, at, daysAgo(30)).lastInsertRowid);
      run('INSERT INTO price_history (listing_id, price, source, at) VALUES (?,?,?,?)', id, price, source, at);
    }

    // Past deals, so trade history and "traded with you" badges have something to show.
    const order = (o) => {
      const id = Number(run(`INSERT INTO orders (buyer_id, supplier_id, model_id, qty, price, token_pct, address, needed_by, note, status,
        created_at, accepted_at, dispatched_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        o.buyer, o.supplier, M[o.model], o.qty, o.price, o.token || 20, o.address || 'Johar Town, Lahore', null, o.note || null,
        o.status || 'delivered', daysAgo(o.d + 3), o.status === 'pending' ? null : daysAgo(o.d + 2),
        ['dispatched', 'delivered'].includes(o.status || 'delivered') ? daysAgo(o.d + 1) : null,
        (o.status || 'delivered') === 'delivered' ? daysAgo(o.d) : null).lastInsertRowid);
      return id;
    };
    order({ buyer: sunPeak, supplier: alNoor, model: 'Longi Hi-MO 6 580 W', qty: 40, price: 17800, d: 24 });
    order({ buyer: sunPeak, supplier: alNoor, model: 'Growatt SPF 6000 ES Plus', qty: 2, price: 185000, d: 38 });
    order({ buyer: sunPeak, supplier: alNoor, model: 'Pylontech US5000', qty: 4, price: 318000, d: 63 });
    order({ buyer: sunPeak, supplier: sunCity, model: 'Inverex Nitrox 6 kW', qty: 1, price: 170000, d: 15 });
    order({ buyer: greenRoof, supplier: sunCity, model: 'Longi Hi-MO 6 580 W', qty: 24, price: 18000, d: 20 });
    order({ buyer: greenRoof, supplier: greenVolt, model: 'JA Solar JAM72S30 550 W', qty: 60, price: 15800, d: 33 });
    order({ buyer: brightWorks, supplier: sunCity, model: 'Pylontech US3000C', qty: 2, price: 230000, d: 9 });

    // An order waiting for Al-Noor to confirm
    const pend = order({ buyer: greenRoof, supplier: alNoor, model: 'Longi Hi-MO 6 580 W', qty: 40, price: 17400,
      address: 'House 9, Block K, Johar Town, Lahore', note: 'Roof access from the back gate', status: 'pending', d: -3 });
    run("UPDATE orders SET created_at = ? WHERE id = ?", new Date(Date.now() - 14 * 60000).toISOString(), pend);
    run('INSERT INTO wa_messages (business_id, direction, body, buttons, context, at) VALUES (?,?,?,?,?,?)', alNoor, 'out',
      'New order from Green Roof Solutions: Longi Hi-MO 6 580 W × 40 at Rs 17,400. Token money proof attached in the app.',
      JSON.stringify(['Open order']), JSON.stringify({ type: 'order', order_id: pend }), t);

    // Open buyer requests
    const reqRow = (o) => Number(run(`INSERT INTO requests (buyer_id, model_id, category, description, qty, city, needed_by, scope, status,
      created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, o.buyer, M[o.model], o.category, o.description || null, o.qty, 'Lahore',
      o.needed_by, 'all', 'open', o.at, new Date(Date.parse(o.at) + 48 * 3600000).toISOString()).lastInsertRowid);

    const r1 = reqRow({ buyer: brightWorks, model: 'Pylontech US5000', category: 'battery', qty: 8, needed_by: '2026-11-10',
      at: new Date(Date.now() - 60 * 60000).toISOString() });
    const r2 = reqRow({ buyer: sunPeak, model: 'Growatt SPF 10000 ES', category: 'inverter', qty: 4, needed_by: '2026-11-07',
      at: new Date(Date.now() - 3 * 3600000).toISOString() });

    const target = (rid, sid, body) => {
      const r = get('SELECT * FROM requests WHERE id = ?', rid);
      const l = get('SELECT * FROM listings WHERE supplier_id = ? AND model_id = ? AND visible = 1 AND qty > 0', sid, r.model_id);
      run('INSERT INTO request_targets (request_id, supplier_id, status, sent_at, in_stock, stock_qty, stock_price) VALUES (?,?,?,?,?,?,?)',
        rid, sid, 'sent', t, l ? 1 : 0, l?.qty ?? null, l?.price ?? null);
      const text = l ? body.replace('\n\nReply with', `\nIn-stock match: you have ${l.qty} in your shop at Rs ${l.price.toLocaleString('en-PK')}.\n\nBid now at your shop price, or reply with`) : body;
      run('INSERT INTO wa_messages (business_id, direction, body, buttons, context, at) VALUES (?,?,?,?,?,?)', sid, 'out', text,
        JSON.stringify(l ? [`Bid Rs ${l.price.toLocaleString('en-PK')}`, 'Bid lower', 'Not in stock'] : ['Send price', 'Not in stock']),
        JSON.stringify({ type: 'request', request_id: rid, match: !!l }), t);
    };
    for (const s of [alNoor, sunCity, newEra]) {
      target(r1, s, 'New request from Bright Solar Works (new buyer, 1 completed deal)\nPylontech US5000 × 8\nLahore, needed by 10 Nov\n\nReply with your price per unit, quantity and token %, for example: 305000 8 20');
    }
    for (const s of [alNoor, sunCity, greenVolt, bright]) {
      target(r2, s, 'New request from SunPeak Energy\nGrowatt SPF 10000 ES × 4\nLahore, needed by 7 Nov\n\nReply with your price per unit, quantity and token %, for example: 325000 4 20');
    }
    // Two suppliers already quoted SunPeak
    const mins = (n) => new Date(Date.now() - n * 60000).toISOString();
    const quote = (rid, sid, model, prices, qty, token, lead, channel) => {
      const price = prices.at(-1);
      const qid = Number(run(`INSERT INTO quotes (request_id, supplier_id, model_id, price, qty, token_pct, lead_days, channel, share, visibility, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, rid, sid, M[model], price, qty, token, lead, channel, 1, 'band', 'active', mins(20)).lastInsertRowid);
      run("UPDATE request_targets SET status = 'quoted' WHERE request_id = ? AND supplier_id = ?", rid, sid);
      const conv = Number(run('INSERT INTO conversations (buyer_id, supplier_id, request_id, created_at, last_at) VALUES (?,?,?,?,?)',
        sunPeak, sid, rid, mins(150), mins(20)).lastInsertRowid);
      prices.forEach((p, i) => {
        const at = mins(150 - i * 60);
        run('INSERT INTO bids (quote_id, request_id, supplier_id, price, qty, at) VALUES (?,?,?,?,?,?)', qid, rid, sid, p, qty, at);
        run('INSERT INTO chat_messages (conversation_id, sender_id, kind, body, at) VALUES (?,?,?,?,?)', conv, sid, 'bid',
          `${i ? 'Revised bid' : 'Bid'}: Rs ${p.toLocaleString('en-PK')} per unit for ${model}. ${qty} available, ${token}% token, ${lead ? 'delivery in ' + lead + ' day(s)' : 'same-day delivery'}.`, at);
      });
      return conv;
    };
    const c1 = quote(r2, sunCity, 'Growatt SPF 10000 ES', [334000, 328000], 6, 25, 0, 'whatsapp');
    quote(r2, greenVolt, 'Growatt SPF 10000 ES', [334000], 40, 10, 1, 'app');
    // A short negotiation in the chat between SunPeak and Sun City
    const chat = (sender, body, m) => run('INSERT INTO chat_messages (conversation_id, sender_id, kind, body, at) VALUES (?,?,?,?,?)', c1, sender, 'text', body, mins(m));
    chat(sunPeak, 'Salam. Are these the 2026 batch with the new WiFi dongle? Site needs them by Saturday.', 70);
    chat(sunCity, 'Yes, fresh stock from last week, dongle included. Same-day delivery in Lahore if you confirm before 4 pm.', 60);
    chat(sunPeak, 'Can you do 325,000 if I take all 4?', 25);
    run('UPDATE conversations SET last_at = ? WHERE id = ?', mins(25), c1);
    run('INSERT INTO chat_reads (conversation_id, business_id, last_read_id) VALUES (?,?,?)', c1, sunPeak,
      get('SELECT MAX(id) m FROM chat_messages WHERE conversation_id = ?', c1).m);

    // Welcome messages in the simulated WhatsApp
    run('INSERT INTO wa_messages (business_id, direction, body, buttons, context, at) VALUES (?,?,?,?,?,?)', newEra, 'out',
      'Assalam o Alaikum Usman sahib. Your shop New Era Energy is ready on Kainat with 3 items, set up by our team from your call. Sign in with this number to check it. 1 buyer request is already waiting.',
      null, null, t);

    void get;
  });
}
