// Подключение личного ящика Google (OAuth, только чтение) — /google/*.
//
// Ловушка: cookie входа в ЦУП стоят SameSite=strict, а возврат с accounts.google.com —
// межсайтовый переход: на /google/callback браузер cookie НЕ пришлёт. Поэтому callback
// без авторизации отдаёт крошечную страницу, которая сама переходит на /google/finish —
// это уже переход изнутри сайта, cookie приходят, и мы сверяем: подключение начинал
// тот же человек (uid в подписанном state). Иначе чужую ссылку согласия можно было бы
// подсунуть и привязать свой ящик к чужой учётке или наоборот.
const router = require('express').Router();
const { requirePageAuth, auditLog } = require('../auth');
const gmail = require('../gmail-lib');

const back = (res, status, msg) => res.redirect('/account.html?google=' + encodeURIComponent(status) + (msg ? '&msg=' + encodeURIComponent(String(msg).slice(0, 200)) : '') + '#google');

router.get('/connect', requirePageAuth(), (req, res) => {
  if (req.user._imp) return back(res, 'error', 'В режиме «вход от имени» почту подключать нельзя');
  if (!gmail.configured()) return back(res, 'error', 'Подключение почты Google ещё не настроено администратором');
  res.redirect(gmail.authUrl(req.user));
});

// Google Диск ЦУП — подключает суперадмин, выбирая в Google техническую учётку (admin@).
router.get('/drive/connect', requirePageAuth(), (req, res) => {
  const toAdmin = (st, msg) => res.redirect('/admin.html?drive=' + st + (msg ? '&msg=' + encodeURIComponent(msg) : '') + '#drive');
  if (req.user.role !== 'superadmin' || req.user._imp) return toAdmin('error', 'Подключать Диск ЦУП может только суперадмин');
  if (!gmail.configured()) return toAdmin('error', 'OAuth-клиент Google не настроен (GOOGLE_CLIENT_ID / SECRET / TOKEN_KEY)');
  res.redirect(require('../drive-lib').authUrl(req.user));
});

router.get('/callback', (req, res) => {
  const q = new URLSearchParams();
  for (const k of ['code', 'state', 'error']) if (req.query[k]) q.set(k, String(req.query[k]));
  const to = '/google/finish?' + q.toString();
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Подключение почты…</title>` +
    `<meta http-equiv="refresh" content="0;url=${to.replace(/"/g, '&quot;')}">` +
    `<body style="font:14px system-ui;padding:40px;color:#444">Подключаю почту… <a href="${to.replace(/"/g, '&quot;')}">продолжить</a>` +
    `<script>location.replace(${JSON.stringify(to)})</script>`);
});

router.get('/finish', requirePageAuth(), async (req, res) => {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  if (req.user._imp) return back(res, 'error', 'В режиме «вход от имени» почту подключать нельзя');
  if (req.query.error) return back(res, 'error', req.query.error === 'access_denied' ? 'Вы отменили доступ в Google' : 'Google: ' + req.query.error);
  if (!req.query.code || !req.query.state) return back(res, 'error', 'Нет кода подтверждения от Google');
  // Подключение Диска ЦУП (state.p='drive') — другая ветка и возврат в админку.
  const st = gmail.readState(String(req.query.state));
  if (st && st.p === 'drive') {
    const toAdmin = (s, m) => res.redirect('/admin.html?drive=' + s + (m ? '&msg=' + encodeURIComponent(String(m).slice(0, 200)) : '') + '#drive');
    if (st.uid !== req.user.id || req.user.role !== 'superadmin') return toAdmin('error', 'Ссылка подключения устарела или не ваша');
    try {
      const r = await require('../drive-lib').finishConnect(req.user, String(req.query.code), st);
      try { await auditLog(req.user.id, req.user.username, 'GOOGLE_DRIVE_CONNECTED', null, { email: r.email }, req.ip, req.headers['user-agent']); } catch (e) {}
      return toAdmin('ok', r.email);
    } catch (e) { return toAdmin('error', e.message); }
  }
  try {
    const r = await gmail.finishConnect(req.user, String(req.query.code), String(req.query.state));
    try { await auditLog(req.user.id, req.user.username, 'GOOGLE_MAIL_CONNECTED', null, { email: r.email }, req.ip, req.headers['user-agent']); } catch (e) {}
    back(res, 'ok', r.email);
  } catch (e) {
    back(res, 'error', e.message);
  }
});

module.exports = router;
