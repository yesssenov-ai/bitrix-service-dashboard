const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const mailLib = require('../mail-lib');
const { pollInbox } = require('../mail-poller');

// admin sees everything; everyone else is restricted to their assigned mailbox
// (set per-account in admin.html, mail_mailbox column). No mailbox assigned
// yet = sees nothing, rather than guessing.
function mailboxFilterFor(user) {
  if (user.role === 'admin') return null;
  return user.mail_mailbox || '__none__';
}

router.get('/emails', requireAuth(), async (req, res) => {
  try {
    const { category, answered, date } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (answered !== undefined) filter.answered = parseInt(answered);
    if (date) filter.date = date;
    const mailbox = mailboxFilterFor(req.user);
    if (mailbox) filter.mailbox = mailbox;
    res.json(await mailLib.getEmails(filter));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', requireAuth(), async (req, res) => {
  try {
    const mailbox = mailboxFilterFor(req.user);
    res.json(await mailLib.getStats(mailbox));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/emails/:id/category', requireAuth(), async (req, res) => {
  try {
    const { category } = req.body;
    const valid = ['client','spam','adv','tender','internal','uncategorized'];
    if (!valid.includes(category)) return res.status(400).json({ error: 'Неверная категория' });
    const emails = await mailLib.getEmails({});
    const email = emails.find(e => e.id === req.params.id);
    if (email) await mailLib.learnFromManualChange(email, category);
    await mailLib.updateCategory(category, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/rules', requireAuth(), async (req, res) => {
  try { res.json(await mailLib.getRules()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rules', requireAuth(), async (req, res) => {
  try {
    const { field, pattern, category } = req.body;
    if (!field || !pattern || !category) return res.status(400).json({ error: 'Все поля обязательны' });
    const result = await mailLib.addRule(field, pattern, category);
    res.json({ id: result.id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/rules/:id', requireAuth(), async (req, res) => {
  try { await mailLib.deleteRule(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/report', requireAuth(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Укажите корректный email' });
    const { sendEmailReport } = require('../mail-mailer');
    const stats = await mailLib.getStats();
    const pending = await mailLib.getPendingEmails();
    await sendEmailReport(stats, pending, email);
    res.json({ ok: true, message: `Отчёт отправлен на ${email}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/poll', requireAuth(), async (req, res) => {
  res.json({ ok: true });
  await pollInbox();
});

module.exports = { router };
