// Авто-рассылка операционного отчёта руководству.
// По умолчанию: вторник 18:00 по Казахстану (UTC+5) = 13:00 UTC — сразу после
// оперативки. Настраивается через env:
//   OPS_REPORT_RECIPIENTS   — a@b.kz,c@d.kz (без него рассылка не идёт)
//   OPS_REPORT_CRON_DOW     — день недели UTC (0=вс … 2=вт), по умолч. 2
//   OPS_REPORT_CRON_HOUR_UTC— час UTC, по умолч. 13
//   OPS_REPORT_CRON_MIN_UTC — минута, по умолч. 0
// Проверяет раз в минуту; фиксирует снимок (для дельт следующего отчёта).
let _timer = null, _lastKey = null;

function startOpsReportScheduler() {
  if (_timer) return;
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const dow = int(process.env.OPS_REPORT_CRON_DOW, 2);
  const hour = int(process.env.OPS_REPORT_CRON_HOUR_UTC, 13);
  const min = int(process.env.OPS_REPORT_CRON_MIN_UTC, 0);
  console.log(`ops-report scheduler: день=${dow} (UTC, 0=вс), ${hour}:${String(min).padStart(2, '0')} UTC` +
    (process.env.OPS_REPORT_RECIPIENTS ? '' : ' — нет OPS_REPORT_RECIPIENTS, рассылка выключена'));

  _timer = setInterval(async () => {
    try {
      const now = new Date();
      if (now.getUTCDay() !== dow || now.getUTCHours() !== hour || now.getUTCMinutes() !== min) return;
      const key = now.toISOString().slice(0, 13); // час-ключ, чтобы не повторять в ту же минуту
      if (_lastKey === key) return;
      _lastKey = key;

      const { computeReport, renderHtml, buildPdf, sendReportEmail, recipientsFromEnv } = require('./operational-report');
      const recipients = recipientsFromEnv();
      if (!recipients.length) { console.log('ops-report: пропуск авто-рассылки — не задан OPS_REPORT_RECIPIENTS'); return; }
      const rep = await computeReport({ commit: true });
      const [html, pdf] = await Promise.all([Promise.resolve(renderHtml(rep)), buildPdf(rep)]);
      const out = await sendReportEmail(recipients, rep, html, pdf);
      console.log('ops-report авто-рассылка:', out.ok ? `отправлено (${rep.status}) → ${(out.to || []).join(', ')}` : `ошибка — ${out.error}`);
    } catch (e) { console.error('ops-report scheduler error:', e.message); }
  }, 60 * 1000);
  if (_timer.unref) _timer.unref();
}

module.exports = { startOpsReportScheduler };
