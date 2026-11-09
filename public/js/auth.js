// Sign-in, role choice, sign-up and "claim your shop".
import { route, render, shell, api, esc, toast, state, refreshMe, homeFor, run, $, rs, priceText, modelName, catLabel, phoneText } from './core.js';

const DEMO = [
  ['Supplier', 'Al-Noor Solar Imports', 'Importer, Lahore', '03001111111'],
  ['Supplier', 'Sun City Traders', 'Distributor, Hall Road', '03002222222'],
  ['Supplier', 'Abbas Solar Store', 'Wholesaler, Sahiwal', '03005555555'],
  ['Supplier', 'New Era Energy', 'Shop built by the team, not claimed yet', '03006666666'],
  ['Buyer', 'SunPeak Energy', 'Installer, verified', '03211111111'],
  ['Buyer', 'Green Roof Solutions', 'Installer', '03212222222'],
  ['Buyer', 'Bright Solar Works', 'Small installer, not verified', '03213333333'],
  ['Admin', 'Kainat team', 'Admin console', '03000000000'],
];

let config = null;
route('/login', async ({ render }) => {
  if (state.me) { location.replace(homeFor(state.me)); return; }
  // Demo accounts and on-screen codes exist only on a development server, never in production.
  config = config || await api('GET', '/api/config').catch(() => ({ demo: false }));
  render(`<div class="shell"><main class="content" style="padding-top:32px">
    <img class="logo" src="/icon.svg" alt="Kainat">
    <div class="stack"><h1 style="font-size:26px">Buy and sell solar equipment without the phone calls</h1>
      <p class="muted">Live prices from importers and distributors. Every deal on record.</p></div>
    <form id="f" class="stack" style="gap:14px">
      <div class="field"><label for="phone">Mobile number</label>
        <div class="row"><span class="btn" style="cursor:default">+92</span><input id="phone" name="phone" type="tel" inputmode="numeric" placeholder="300 1234567" autocomplete="tel" required></div></div>
      <fieldset><legend>Send my code by</legend>
        <div class="grid2"><label class="radio-card"><input type="radio" name="channel" value="whatsapp" checked><span class="strong">WhatsApp</span></label>
        <label class="radio-card"><input type="radio" name="channel" value="sms"><span class="strong">SMS</span></label></div></fieldset>
      <button class="btn primary lg block">Send code</button>
      <p class="tiny muted center">One account per phone number.</p>
    </form>
    ${config.demo ? `<div class="sep"></div>
    <div class="stack"><h2>Demo accounts</h2><p class="small muted">Tap one to sign in. Any other number starts a new sign-up.</p>
      <div class="demo-list">${DEMO.map(([role, name, sub, phone]) => `<button type="button" data-phone="${phone}">
        <span class="stack" style="gap:2px"><span class="strong">${esc(name)}</span><span class="small muted">${esc(sub)}</span></span>
        <span class="badge ${role === 'Buyer' ? 'blue' : role === 'Admin' ? 'dark' : 'green'}">${role}</span></button>`).join('')}</div></div>` : ''}
  </main></div>`);
  const start = async (phone, channel, btn) => run(btn, async () => {
    const r = await api('POST', '/api/auth/start', { phone, channel });
    if (r.devCode) sessionStorage.setItem('devCode', r.devCode); else sessionStorage.removeItem('devCode');
    location.hash = `#/otp?phone=${r.phone}&via=${r.channel}`;
  });
  $('#f').onsubmit = (e) => { e.preventDefault(); start($('#phone').value, e.target.channel.value, e.submitter); };
  document.querySelectorAll('[data-phone]').forEach((b) => { b.onclick = () => start(b.dataset.phone, 'whatsapp', b); });
}, { public: true });

route('/otp', async ({ query, render }) => {
  const phone = query.phone || '';
  const code = sessionStorage.getItem('devCode') || '';
  render(shell({ title: 'Enter your code', back: '#/login', body: `
    <p class="muted">Sent on ${query.via === 'sms' ? 'SMS' : 'WhatsApp'} to ${esc(phoneText(phone))}</p>
    ${code ? `<div class="card tint"><span class="small">Local demo: no message is really sent. Your code is</span><span class="big" style="letter-spacing:.2em">${esc(code)}</span></div>` : ''}
    <form id="f" class="stack" style="gap:14px">
      <label class="field"><span class="flabel">6-digit code</span><input id="code" class="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
      <button class="btn primary lg block">Verify</button>
      ${code ? '<button type="button" id="fill" class="btn block">Fill the demo code</button>' : '<p class="tiny muted center">The code expires in 10 minutes. Never share it with anyone, including the Kainat team.</p>'}
    </form>` }));
  $('#fill')?.addEventListener('click', () => { $('#code').value = code; $('#f').requestSubmit(); });
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      await api('POST', '/api/auth/verify', { phone, code: $('#code').value });
      sessionStorage.removeItem('devCode');
      const me = await refreshMe();
      location.hash = homeFor(me);
    });
  };
  setTimeout(() => $('#code')?.focus(), 30);
}, { public: true });

route('/welcome', async ({ render }) => {
  if (state.me?.role) { location.replace(homeFor(state.me)); return; }
  render(shell({ title: 'How will you use the app?', eyebrow: `Verified ${state.me.phone}`, body: `
    <a class="card" href="#/signup/buyer"><div class="row top"><span class="badge blue">Buyer</span></div>
      <h2>I buy equipment</h2><p class="muted small">Installer or solar company comparing suppliers</p></a>
    <a class="card" href="#/signup/supplier"><div class="row top"><span class="badge green">Supplier</span></div>
      <h2>I sell equipment</h2><p class="muted small">Importer, distributor or wholesaler. You answer buyer requests; your answers become your shop.</p></a>
    <p class="small muted">If our team already set up your shop, sign in with the number you gave us and it opens directly.</p>
    <button type="button" class="btn" id="out">Use a different number</button>` }));
  $('#out').onclick = async () => { await api('POST', '/api/auth/logout'); state.me = null; location.hash = '#/login'; };
}, { onboarding: true, role: 'any' });

route('/signup/:role', async ({ params, render }) => {
  if (state.me?.role) { location.replace(homeFor(state.me)); return; }
  const supplier = params.role === 'supplier';
  render(shell({ title: supplier ? 'Your business' : 'Your company', back: '#/welcome', body: `
    <p class="muted small">${supplier ? 'Buyers see this before they send token money.' : 'Suppliers see this when you send a request. Takes under a minute.'}</p>
    <form id="f" class="stack" style="gap:14px">
      <label class="field"><span class="flabel">${supplier ? 'Business name' : 'Company name'}</span><input name="name" required></label>
      ${supplier ? `<fieldset><legend>Business type</legend><div class="grid3">
        ${['importer', 'distributor', 'wholesaler'].map((t, i) => `<label class="radio-card tight"><input type="radio" name="supplier_type" value="${t}" ${i === 2 ? 'checked' : ''}><span class="small strong">${t[0].toUpperCase() + t.slice(1)}</span></label>`).join('')}
      </div></fieldset>` : ''}
      <div class="grid2"><label class="field"><span class="flabel">City</span><input name="city" value="Lahore" required></label>
        ${supplier ? '<label class="field"><span class="flabel">Years in business</span><input name="years" type="number" min="0"></label>'
          : `<label class="field"><span class="flabel">Installs a month</span><select name="installs"><option>Under 5</option><option selected>5 to 20</option><option>Over 20</option></select></label>`}</div>
      <label class="field"><span class="flabel">Contact person</span><input name="contact"></label>
      ${supplier ? `<label class="field"><span class="flabel">Cities you deliver to</span><input name="delivery_cities" placeholder="Lahore, Faisalabad"></label>
        <label class="field"><span class="flabel">Warehouse or shop address</span><input name="address"></label>
        <label class="field"><span class="flabel">NTN or registration number <span class="muted">(optional, gets you a verified badge sooner)</span></span><input name="ntn"></label>`
        : `<label class="field"><span class="flabel">Default delivery address <span class="muted">(optional)</span></span><input name="address"></label>
        <fieldset><legend>What do you buy most?</legend><div class="chips">${['Panels', 'Inverters', 'Batteries', 'Structures', 'Cables'].map((b) =>
          `<label class="check chip"><input type="checkbox" name="buys" value="${b}">${b}</label>`).join('')}</div></fieldset>`}
      <button class="btn primary lg block">${supplier ? 'Create my shop' : 'Start finding equipment'}</button>
    </form>` }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f);
    body.role = params.role;
    if (!supplier) body.buys = f.getAll('buys').join(', ');
    run(e.submitter, async () => {
      await api('POST', '/api/onboard', body);
      const me = await refreshMe();
      toast(supplier ? 'Your shop is live. Buyer requests will arrive in your inbox.' : 'Welcome. Search for equipment or post a request.');
      location.hash = homeFor(me);
    });
  };
}, { onboarding: true, role: 'any' });

route('/claim', async ({ render }) => {
  const me = state.me;
  if (me.role !== 'supplier' || me.claimed) { location.replace(homeFor(me)); return; }
  const [shop, reqs] = await Promise.all([api('GET', '/api/shop'), api('GET', '/api/requests')]);
  const waiting = reqs.filter((r) => r.status === 'open').length;
  render(shell({ title: 'Your shop is ready', body: `
    <p class="muted">Set up by our team ${me.created_at ? 'on ' + new Date(me.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''} from your call. Check it and you are live.</p>
    ${waiting ? `<div class="card tint"><span class="big">${waiting} buyer request${waiting > 1 ? 's' : ''} waiting</span><span class="small">They go to the first suppliers who quote</span></div>` : ''}
    <section class="card"><div class="row between"><span class="label-caps">Business</span><a href="#/profile" class="small strong">Edit</a></div>
      <h2>${esc(me.name)}</h2><p class="small muted">${esc((me.supplier_type || '') + ' · ' + (me.city || '') + (me.contact ? ' · ' + me.contact : ''))}</p>
      <p class="small">${me.docs_status === 'verified' ? 'Documents verified' : me.docs_status === 'received' ? 'Documents received, check in progress' : 'Documents still needed: NTN or registration'}</p></section>
    <section class="card"><span class="label-caps">${shop.length} items already listed</span>
      ${shop.slice(0, 5).map((l) => `<div class="row between small"><span>${esc(l.brand + ' ' + l.name)}</span><span class="muted nowrap">${rs(l.price)}</span></div>`).join('')}
      <p class="tiny muted">Verified buyers and past partners see exact prices; others see a range. You can change this per item.</p></section>
    <button id="claim" class="btn primary lg block">Looks right, show me the requests</button>
    <p class="small muted center">Something wrong? Reply on WhatsApp and our team fixes it.</p>` }));
  $('#claim').onclick = (e) => run(e.target, async () => {
    await api('POST', '/api/claim');
    await refreshMe();
    location.hash = '#/s/inbox';
  });
  void priceText; void modelName; void catLabel;
}, { role: 'supplier' });
