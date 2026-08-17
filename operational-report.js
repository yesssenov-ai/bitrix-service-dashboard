// ─────────────────────────────────────────────────────────────────────────────
// Операционный отчёт для руководства («отчёт по оперативке»).
// Executive one-pager: RAG-статус → KPI → красные флаги с ответственным и «что
// требуется» → что изменилось с прошлого отчёта (по снимку) → ближайшие поставки.
// Отдаётся как HTML (просмотр/тело письма) и PDF (вложение); авто-рассылка —
// еженедельно (см. ops-report-scheduler.js).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const PdfPrinter = require('pdfmake/src/printer');
const db = () => require('./auth').pool; // lazy — рендер/PDF не тянут auth-env

const FONT_DIR = path.join(__dirname, 'public', 'assets', 'fonts');
const fonts = { Deja: {
  normal: path.join(FONT_DIR, 'DejaVuSans.ttf'), bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  italics: path.join(FONT_DIR, 'DejaVuSans.ttf'), bolditalics: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
} };

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const mln = n => (Number(n) || 0) / 1e6;
const fmtMln = n => mln(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const fmtDate = d => { if (!d) return '—'; const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(d); };
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const CRIT = ['red', 'overdue', 'late-ship', 'overdue-task', 'open-bp'];
const SEV = { red: 0, overdue: 1, 'late-ship': 2, 'overdue-task': 3, 'open-bp': 4, 'open-proc': 5, stale: 6 };
const FLAG_LABEL = { red: 'Красный флаг', overdue: 'Просрочена поставка', 'late-ship': 'Отгрузка позже срока', 'overdue-task': 'Просроченные задачи', 'open-bp': 'Незавершённые БП', 'open-proc': 'Открытые процессы', stale: 'Нет движения >14 дн' };
const FLAG_COLOR = { red: '#C53B2F', overdue: '#ff5752', 'late-ship': '#c98bff', 'overdue-task': '#ff8a3d', 'open-bp': '#8b5cf6', 'open-proc': '#3b82f6', stale: '#e0a940' };
const FLAG_ASK = {
  red: 'ручной красный флаг — нужно решение руководства',
  overdue: 'просрочена поставка по договору — эскалация',
  'late-ship': 'отгрузка завода позже срока по договору',
  'overdue-task': 'есть просроченные задачи — назначить/ускорить',
  'open-bp': 'незавершённые бизнес-процессы — довести до конца',
  stale: 'нет движения больше 14 дней — проверить статус',
};
const primaryFlag = flags => { let best = null, bs = 99; (flags || []).forEach(f => { const s = SEV[f] ?? 9; if (s < bs) { bs = s; best = f; } }); return best; };

// ── Снимок для дельт «что изменилось» ────────────────────────────────────────
let _snapReady = false;
async function ensureSnapshotTable() {
  if (_snapReady) return;
  await db().query(`CREATE TABLE IF NOT EXISTS ticketsmodule_ops_report_snapshot (
    deal_id INTEGER PRIMARY KEY, flags TEXT, stage VARCHAR(120), is_done BOOLEAN,
    opportunity NUMERIC(18,2), taken_at TIMESTAMPTZ DEFAULT NOW())`);
  _snapReady = true;
}
async function loadSnapshot() {
  await ensureSnapshotTable();
  const { rows } = await db().query('SELECT deal_id, flags, stage, is_done FROM ticketsmodule_ops_report_snapshot');
  const map = {};
  rows.forEach(r => { map[r.deal_id] = { flags: (r.flags || '').split(',').filter(Boolean), stage: r.stage, done: r.is_done }; });
  return map;
}
async function commitSnapshot(rows) {
  await ensureSnapshotTable();
  await db().query('TRUNCATE ticketsmodule_ops_report_snapshot');
  if (!rows.length) return;
  const vals = [], ph = [];
  rows.forEach((r, i) => { const b = i * 5; ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`); vals.push(r.id, (r.flags || []).join(','), r.stageName || '', !!r.isDone, r.opportunity || 0); });
  await db().query(`INSERT INTO ticketsmodule_ops_report_snapshot (deal_id, flags, stage, is_done, opportunity) VALUES ${ph.join(',')}`, vals);
}

// ── Сбор отчёта ──────────────────────────────────────────────────────────────
async function computeReport({ commit = false } = {}) {
  const { getBoard } = require('./operational');
  const board = await getBoard({});
  const rows = board.rows || [];
  const active = rows.filter(r => !r.isDone && !r.isLost);

  const flagged = rows.filter(r => r.flags.some(f => CRIT.includes(f) || f === 'stale'));
  const attn = flagged.map(r => ({ r, sev: Math.min(...r.flags.map(f => SEV[f] ?? 9)) }))
    .sort((a, b) => a.sev - b.sev || b.r.opportunity - a.r.opportunity).map(x => x.r);

  const cnt = f => rows.filter(r => r.flags.includes(f)).length;
  const counts = { red: cnt('red'), overdue: cnt('overdue'), late: cnt('late-ship'), task: cnt('overdue-task'), bp: cnt('open-bp'), stale: cnt('stale') };
  const atRiskSum = flagged.reduce((a, r) => a + r.opportunity, 0);
  const status = (counts.red || counts.overdue) ? 'red' : (counts.late || counts.task || counts.bp || counts.stale) ? 'amber' : 'green';

  // Дельты
  const prev = await loadSnapshot();
  const firstRun = Object.keys(prev).length === 0;
  const changes = { newFlags: [], resolved: [], completed: [], stageMoved: [], newDeals: [] };
  if (!firstRun) {
    for (const r of rows) {
      const p = prev[r.id];
      const critNow = r.flags.filter(f => CRIT.includes(f));
      if (!p) { if (critNow.length) changes.newDeals.push(r); continue; }
      const critPrev = (p.flags || []).filter(f => CRIT.includes(f));
      const gained = critNow.filter(f => !critPrev.includes(f));
      const cleared = critPrev.filter(f => !critNow.includes(f));
      if (gained.length) changes.newFlags.push({ r, flags: gained });
      if (cleared.length && critNow.length === 0) changes.resolved.push({ r, flags: cleared });
      if (!p.done && r.isDone) changes.completed.push(r);
      else if (p.stage && p.stage !== r.stageName && !r.isDone) changes.stageMoved.push({ r, from: p.stage });
    }
  }

  // Ближайшие поставки (≤14 дней, ещё не просрочены, активные)
  const now = Date.now();
  const watch = active.filter(r => r.deliveryBy && !r.flags.includes('overdue'))
    .map(r => ({ r, days: Math.ceil((new Date(r.deliveryBy).getTime() - now) / 86400000) }))
    .filter(x => x.days >= 0 && x.days <= 14).sort((a, b) => a.days - b.days);

  if (commit) await commitSnapshot(rows);

  const d = new Date();
  return {
    generatedAt: d.toISOString(),
    dateLabel: `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    status, counts, atRiskSum, firstRun,
    kpi: {
      totalSum: rows.reduce((a, r) => a + r.opportunity, 0),
      dealCount: rows.length, activeCount: active.length,
      doneCount: rows.filter(r => r.isDone).length,
      funnel: (board.funnel && board.funnel.cells) || [],
    },
    attn, changes, watch,
  };
}

// ── HTML one-pager (просмотр + тело письма) ──────────────────────────────────
const STATUS_META = { red: { c: '#C53B2F', t: 'КРАСНЫЙ', s: 'есть критические флаги — нужно внимание руководства' }, amber: { c: '#e0a940', t: 'ЖЁЛТЫЙ', s: 'есть предупреждения — держим на контроле' }, green: { c: '#2e9e5b', t: 'ЗЕЛЁНЫЙ', s: 'критических флагов нет' } };
function headline(rep) {
  const c = rep.counts;
  const bits = [];
  if (c.red) bits.push(`${c.red} красных`);
  if (c.overdue) bits.push(`${c.overdue} просроч. поставок`);
  if (c.late) bits.push(`${c.late} поздних отгрузок`);
  if (c.task) bits.push(`${c.task} с просроч. задачами`);
  if (c.bp) bits.push(`${c.bp} с незаверш. БП`);
  if (c.stale) bits.push(`${c.stale} завис`);
  return bits.length ? bits.join(' · ') : 'Критических флагов нет — портфель в норме.';
}
function flagDot(f) { return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${FLAG_COLOR[f] || '#999'};margin-right:5px;vertical-align:middle"></span>`; }
function flagPills(flags) { return (flags || []).slice().sort((a, b) => (SEV[a] ?? 9) - (SEV[b] ?? 9)).map(f => `<span style="display:inline-block;font-size:10px;font-weight:700;color:#fff;background:${FLAG_COLOR[f] || '#999'};border-radius:10px;padding:1px 7px;margin:1px 3px 1px 0;white-space:nowrap">${esc(FLAG_LABEL[f] || f)}</span>`).join(''); }

function renderHtml(rep) {
  const sm = STATUS_META[rep.status];
  const attnTop = rep.attn.slice(0, 18);
  const attnRows = attnTop.map(r => {
    const pf = primaryFlag(r.flags);
    return `<tr>
      <td style="padding:8px 8px;border-bottom:1px solid #eef0f4;white-space:nowrap">${flagDot(pf)}<b>${esc(r.company || '—')}</b><div style="color:#8a93a6;font-size:11px">${esc(r.contractNo || ('#' + r.id))}</div></td>
      <td style="padding:8px 8px;border-bottom:1px solid #eef0f4;font-size:12px">${esc(r.stageName || '')}</td>
      <td style="padding:8px 8px;border-bottom:1px solid #eef0f4;font-size:12px">${esc(r.manager || '—')}${r.engineer ? `<div style="color:#8a93a6;font-size:11px">инж.: ${esc(r.engineer)}</div>` : ''}</td>
      <td style="padding:8px 8px;border-bottom:1px solid #eef0f4;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums"><b>${money(r.opportunity)}</b> ₸${r.deliveryBy ? `<div style="color:#8a93a6;font-size:11px">пост.: ${fmtDate(r.deliveryBy)}</div>` : ''}</td>
      <td style="padding:8px 8px;border-bottom:1px solid #eef0f4;font-size:11.5px">${flagPills(r.flags)}${r.comment ? `<div style="color:#5b667d;font-size:11px;margin-top:3px">💬 ${esc(String(r.comment).slice(0, 160))}</div>` : `<div style="color:#8a93a6;font-size:11px;margin-top:2px">${esc(FLAG_ASK[pf] || '')}</div>`}</td>
    </tr>`;
  }).join('');

  const chBlock = (title, arr, fn, color) => {
    if (!arr.length) return '';
    const items = arr.slice(0, 8).map(fn).join('');
    const more = arr.length > 8 ? `<li style="color:#8a93a6;list-style:none">…и ещё ${arr.length - 8}</li>` : '';
    return `<div style="margin-bottom:10px"><div style="font-weight:700;font-size:12.5px;color:${color};margin-bottom:3px">${title} · ${arr.length}</div><ul style="margin:0;padding-left:18px;font-size:12px;color:#2b3140">${items}${more}</ul></div>`;
  };
  const nm = r => `${esc(r.company || '—')} <span style="color:#8a93a6">(${esc(r.contractNo || ('#' + r.id))})</span>`;
  const changesHtml = rep.firstRun
    ? `<div style="color:#8a93a6;font-size:12px">Это первый отчёт — зафиксирована базовая линия. Со следующего отчёта здесь будут изменения (новые флаги, снятые флаги, завершённые, смена стадий).</div>`
    : (rep.changes.newFlags.length || rep.changes.resolved.length || rep.changes.completed.length || rep.changes.stageMoved.length || rep.changes.newDeals.length
      ? chBlock('🚩 Новые флаги', rep.changes.newFlags, x => `<li>${nm(x.r)} — ${x.flags.map(f => esc(FLAG_LABEL[f])).join(', ')}</li>`, '#C53B2F')
        + chBlock('✅ Флаги сняты', rep.changes.resolved, x => `<li>${nm(x.r)}</li>`, '#2e9e5b')
        + chBlock('🏁 Завершены', rep.changes.completed, r => `<li>${nm(r)} — ${money(r.opportunity)} ₸</li>`, '#2e9e5b')
        + chBlock('➡️ Смена стадии', rep.changes.stageMoved, x => `<li>${nm(x.r)}: ${esc(x.from)} → <b>${esc(x.r.stageName)}</b></li>`, '#3b82f6')
        + chBlock('🆕 Новые под флагом', rep.changes.newDeals, r => `<li>${nm(r)} — ${flagPills(r.flags)}</li>`, '#8b5cf6')
      : `<div style="color:#8a93a6;font-size:12px">С прошлого отчёта существенных изменений по флагам/стадиям нет.</div>`);

  const watchHtml = rep.watch.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:12px">${rep.watch.slice(0, 10).map(x => `<tr><td style="padding:5px 6px;border-bottom:1px solid #eef0f4">${esc(x.r.company || '—')} <span style="color:#8a93a6">(${esc(x.r.contractNo || ('#' + x.r.id))})</span></td><td style="padding:5px 6px;border-bottom:1px solid #eef0f4;text-align:right;white-space:nowrap">${fmtDate(x.r.deliveryBy)} · <b style="color:${x.days <= 3 ? '#C53B2F' : '#e0a940'}">через ${x.days} дн</b></td></tr>`).join('')}</table>${rep.watch.length > 10 ? `<div style="color:#8a93a6;font-size:11px;margin-top:4px">…и ещё ${rep.watch.length - 10}</div>` : ''}`
    : `<div style="color:#8a93a6;font-size:12px">Ближайших поставок (≤14 дней) нет.</div>`;

  const kpiCell = (v, l, c) => `<td style="padding:12px 14px;background:#fff;border:1px solid #eceef2;border-radius:12px" valign="top"><div style="font-size:20px;font-weight:800;color:${c || '#20242e'};line-height:1.1">${v}</div><div style="font-size:11px;color:#8a93a6;margin-top:3px">${l}</div></td>`;
  const funnelHtml = rep.kpi.funnel.length
    ? `<table style="width:100%;border-collapse:separate;border-spacing:6px 0"><tr>${rep.kpi.funnel.map(c => `<td style="background:#f6f7f9;border:1px solid #eceef2;border-radius:9px;padding:7px 9px;text-align:center"><div style="font-size:11px;color:#5b667d;font-weight:700">${esc(c.name)}</div><div style="font-size:13px;font-weight:800;color:#20242e">${fmtMln(c.sum)} млн</div><div style="font-size:10.5px;color:#8a93a6">${c.count} шт.</div></td>`).join('')}</tr></table>`
    : '';

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Операционный отчёт · ${esc(rep.dateLabel)}</title></head>
<body style="margin:0;background:#eef1f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#20242e">
<div style="max-width:900px;margin:0 auto;padding:18px">
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px"><tr>
    <td><div style="font-size:19px;font-weight:800">ProLab<span style="color:#C53B2F">Support</span> · Операционный отчёт</div>
      <div style="color:#8a93a6;font-size:12.5px">Реализация · для руководства · ${esc(rep.dateLabel)}</div></td>
    <td align="right"><span style="display:inline-block;background:${sm.c};color:#fff;font-weight:800;font-size:13px;border-radius:20px;padding:7px 16px">● ${sm.t}</span></td>
  </tr></table>

  <div style="background:${sm.c}12;border:1px solid ${sm.c}55;border-left:5px solid ${sm.c};border-radius:10px;padding:11px 15px;margin-bottom:14px">
    <div style="font-weight:700;font-size:14px;color:${sm.c}">${esc(sm.s)}</div>
    <div style="font-size:13px;color:#2b3140;margin-top:2px">${esc(headline(rep))}</div>
  </div>

  <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:14px"><tr>
    ${kpiCell(fmtMln(rep.kpi.totalSum) + ' млн ₸', 'Портфель · ' + rep.kpi.dealCount + ' сделок')}
    ${kpiCell(rep.kpi.activeCount, 'Активных сделок')}
    ${kpiCell(fmtMln(rep.atRiskSum) + ' млн ₸', 'Под флагами · ' + rep.attn.length + ' сделок', rep.atRiskSum ? '#C53B2F' : '#20242e')}
    ${kpiCell(rep.kpi.doneCount, 'Завершено')}
  </tr></table>

  ${funnelHtml ? `<div style="background:#fff;border:1px solid #eceef2;border-radius:12px;padding:12px 14px;margin-bottom:14px"><div style="font-weight:700;font-size:12.5px;color:#5b667d;margin-bottom:8px">Воронка</div>${funnelHtml}</div>` : ''}

  <div style="background:#fff;border:1px solid #eceef2;border-radius:12px;padding:14px;margin-bottom:14px">
    <div style="font-weight:800;font-size:14px;margin-bottom:8px">🔴 Требуют внимания <span style="color:#8a93a6;font-weight:600;font-size:12px">· ${rep.attn.length}</span></div>
    ${rep.attn.length ? `<table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;color:#8a93a6;font-size:10.5px;text-transform:uppercase">
      <th style="padding:4px 8px">Компания / договор</th><th style="padding:4px 8px">Стадия</th><th style="padding:4px 8px">Ответственный</th><th style="padding:4px 8px;text-align:right">Сумма</th><th style="padding:4px 8px">Флаги / что нужно</th></tr></thead>
      <tbody>${attnRows}</tbody></table>${rep.attn.length > 18 ? `<div style="color:#8a93a6;font-size:11px;margin-top:6px">…и ещё ${rep.attn.length - 18} — см. модуль / PDF</div>` : ''}` : `<div style="color:#2e9e5b;font-size:13px">✓ Нет сделок с критическими флагами.</div>`}
  </div>

  <table style="width:100%;border-collapse:separate;border-spacing:0"><tr>
    <td valign="top" style="width:56%;padding-right:7px">
      <div style="background:#fff;border:1px solid #eceef2;border-radius:12px;padding:14px;height:100%">
        <div style="font-weight:800;font-size:14px;margin-bottom:8px">📈 Изменения с прошлого отчёта</div>${changesHtml}</div>
    </td>
    <td valign="top" style="width:44%;padding-left:7px">
      <div style="background:#fff;border:1px solid #eceef2;border-radius:12px;padding:14px;height:100%">
        <div style="font-weight:800;font-size:14px;margin-bottom:8px">👀 Ближайшие поставки <span style="color:#8a93a6;font-weight:600;font-size:12px">≤14 дн</span></div>${watchHtml}</div>
    </td>
  </tr></table>

  <div style="color:#9aa3b4;font-size:11px;text-align:center;margin:16px 0 6px">Сформировано автоматически из зеркала Bitrix · ProLabSupport ЦУП · ${esc(rep.dateLabel)}</div>
</div></body></html>`;
}

// ── PDF (вложение) ───────────────────────────────────────────────────────────
function buildPdf(rep) {
  const printer = new PdfPrinter(fonts);
  const sm = STATUS_META[rep.status];
  const BR = '#C53B2F', DIM = '#6b7280', LINE = '#e2e5ea';
  const content = [];
  content.push({ columns: [
    { text: [{ text: 'ProLab', bold: true, fontSize: 14 }, { text: 'Support', bold: true, fontSize: 14, color: BR }, { text: '  ·  Операционный отчёт для руководства', fontSize: 11 }], width: '*' },
    { text: rep.dateLabel, alignment: 'right', color: DIM, fontSize: 9, margin: [0, 3, 0, 0] },
  ], margin: [0, 0, 0, 6] });
  content.push({ table: { widths: ['*'], body: [[{ text: `${sm.t} · ${sm.s}\n${headline(rep)}`, color: '#fff', bold: true, fontSize: 10, margin: [8, 5, 8, 5] }]] }, layout: { fillColor: () => sm.c, hLineWidth: () => 0, vLineWidth: () => 0 }, margin: [0, 0, 0, 10] });

  // KPI
  const kpi = (v, l) => ({ table: { widths: ['*'], body: [[{ text: v, bold: true, fontSize: 13, alignment: 'center' }], [{ text: l, color: DIM, fontSize: 8, alignment: 'center' }]] }, layout: { hLineColor: () => LINE, vLineColor: () => LINE, hLineWidth: () => 0.5, vLineWidth: () => 0.5 } });
  content.push({ columns: [
    kpi(`${fmtMln(rep.kpi.totalSum)} млн ₸`, `Портфель · ${rep.kpi.dealCount} сделок`),
    kpi(String(rep.kpi.activeCount), 'Активных'),
    kpi(`${fmtMln(rep.atRiskSum)} млн ₸`, `Под флагами · ${rep.attn.length}`),
    kpi(String(rep.kpi.doneCount), 'Завершено'),
  ], columnGap: 6, margin: [0, 0, 0, 12] });

  // Attention table
  content.push({ text: `Требуют внимания · ${rep.attn.length}`, bold: true, fontSize: 12, color: BR, margin: [0, 0, 0, 5] });
  if (rep.attn.length) {
    const body = [[
      { text: '', style: 'th' }, { text: 'Компания / договор', style: 'th' }, { text: 'Стадия', style: 'th' },
      { text: 'Ответственный', style: 'th' }, { text: 'Сумма', style: 'th', alignment: 'right' }, { text: 'Флаги / что нужно', style: 'th' },
    ]];
    rep.attn.forEach(r => {
      const pf = primaryFlag(r.flags);
      body.push([
        { text: '●', color: FLAG_COLOR[pf] || '#999', alignment: 'center', fontSize: 9 },
        { text: [{ text: (r.company || '—'), bold: true }, { text: '\n' + (r.contractNo || ('#' + r.id)), color: DIM, fontSize: 7 }], fontSize: 8 },
        { text: r.stageName || '', fontSize: 8 },
        { text: [{ text: r.manager || '—' }, r.engineer ? { text: '\nинж.: ' + r.engineer, color: DIM, fontSize: 7 } : {}], fontSize: 8 },
        { text: money(r.opportunity), alignment: 'right', bold: true, fontSize: 8 },
        { text: [{ text: (r.flags || []).map(f => FLAG_LABEL[f]).join(', ') }, { text: r.comment ? '\n💬 ' + String(r.comment).slice(0, 140) : ('\n' + (FLAG_ASK[pf] || '')), color: DIM, fontSize: 7 }], fontSize: 7.5 },
      ]);
    });
    content.push({ table: { headerRows: 1, widths: [10, 110, 70, 80, 55, '*'], body, dontBreakRows: true }, layout: { fillColor: i => i === 0 ? '#20242e' : (i % 2 === 0 ? '#f6f7f9' : null), hLineColor: () => LINE, vLineColor: () => LINE, hLineWidth: () => 0.5, vLineWidth: () => 0.5, paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4 }, margin: [0, 0, 0, 12] });
  } else content.push({ text: '✓ Нет сделок с критическими флагами.', color: '#2e9e5b', fontSize: 9, margin: [0, 0, 0, 12] });

  // Changes
  content.push({ text: 'Изменения с прошлого отчёта', bold: true, fontSize: 12, color: BR, margin: [0, 0, 0, 5] });
  const chLines = [];
  const nm = r => `${r.company || '—'} (${r.contractNo || ('#' + r.id)})`;
  if (rep.firstRun) chLines.push({ text: 'Первый отчёт — зафиксирована базовая линия. Изменения появятся со следующего отчёта.', color: DIM, fontSize: 9 });
  else {
    const addLines = (title, arr, fn) => { if (arr.length) { chLines.push({ text: `${title} · ${arr.length}`, bold: true, fontSize: 9, margin: [0, 3, 0, 1] }); arr.slice(0, 10).forEach(x => chLines.push({ text: '• ' + fn(x), fontSize: 8.5, margin: [0, 0, 0, 0] })); if (arr.length > 10) chLines.push({ text: `…и ещё ${arr.length - 10}`, color: DIM, fontSize: 8 }); } };
    addLines('🚩 Новые флаги', rep.changes.newFlags, x => `${nm(x.r)} — ${x.flags.map(f => FLAG_LABEL[f]).join(', ')}`);
    addLines('✅ Флаги сняты', rep.changes.resolved, x => nm(x.r));
    addLines('🏁 Завершены', rep.changes.completed, r => `${nm(r)} — ${money(r.opportunity)} ₸`);
    addLines('➡ Смена стадии', rep.changes.stageMoved, x => `${nm(x.r)}: ${x.from} → ${x.r.stageName}`);
    addLines('🆕 Новые под флагом', rep.changes.newDeals, r => `${nm(r)} — ${(r.flags || []).map(f => FLAG_LABEL[f]).join(', ')}`);
    if (!chLines.length) chLines.push({ text: 'Существенных изменений по флагам/стадиям нет.', color: DIM, fontSize: 9 });
  }
  content.push({ stack: chLines, margin: [0, 0, 0, 12] });

  // Watch
  content.push({ text: 'Ближайшие поставки (≤14 дней)', bold: true, fontSize: 12, color: BR, margin: [0, 0, 0, 5] });
  if (rep.watch.length) content.push({ ul: rep.watch.slice(0, 14).map(x => `${x.r.company || '—'} (${x.r.contractNo || ('#' + x.r.id)}) — ${fmtDate(x.r.deliveryBy)} · через ${x.days} дн`), fontSize: 8.5 });
  else content.push({ text: 'Нет.', color: DIM, fontSize: 9 });

  const docDefinition = {
    pageSize: 'A4', pageMargins: [26, 24, 26, 28], defaultStyle: { font: 'Deja', fontSize: 9 },
    footer: (cur, total) => ({ text: `ProLabSupport · ${cur}/${total}`, alignment: 'center', color: DIM, fontSize: 7, margin: [0, 6, 0, 0] }),
    content, styles: { th: { bold: true, color: '#fff', fontSize: 7.5 } },
  };
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); doc.end();
  });
}

// ── Email (Resend, HTML + PDF-вложение) ──────────────────────────────────────
async function sendReportEmail(recipients, rep, html, pdfBuffer) {
  const fetch = require('node-fetch');
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const to = (recipients || []).filter(Boolean);
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY не задан' };
  if (!to.length) return { ok: false, error: 'Нет получателей (OPS_REPORT_RECIPIENTS)' };
  const subject = `Операционный отчёт · ${rep.dateLabel} · ${STATUS_META[rep.status].t}`;
  const body = {
    from: `ProLabSupport ЦУП <${process.env.OPS_REPORT_FROM || 'service@prolabsupport.kz'}>`,
    to, subject, html,
    attachments: pdfBuffer ? [{ filename: `ops-report-${rep.dateLabel.replace(/\s/g, '-')}.pdf`, content: pdfBuffer.toString('base64') }] : [],
  };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, id: d.id, to } : { ok: false, error: 'Resend ' + r.status + ': ' + JSON.stringify(d) };
  } catch (e) { return { ok: false, error: e.message }; }
}

function recipientsFromEnv() {
  return String(process.env.OPS_REPORT_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = { computeReport, renderHtml, buildPdf, sendReportEmail, recipientsFromEnv };
