// Loads every screen module, then starts the hash router.
import { navigate, api, state, $ } from './js/core.js';
import './js/auth.js';
import './js/supplier.js';
import './js/buyer.js';
import './js/shared.js';
import './js/chat.js';
import './js/admin.js';

window.addEventListener('hashchange', navigate);
$('#switch-account').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.me = null;
  location.hash = '#/login';
});
navigate();
