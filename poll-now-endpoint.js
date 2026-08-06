app.post('/api/ticket-email/poll-now', requireAuth(['admin','coordinator','engineer']), async (req, res) => {
  try {
    const { pollTicketMailbox } = require('./ticket-mail-poller');
    await pollTicketMailbox();
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/ticket-email/poll-now error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось проверить почту' });
  }
});
