const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const { USERS } = require('../constants');

const PM_ROLES = ['admin', 'coordinator'];
function isPm(user) { return PM_ROLES.includes(user.role); }

// Resolves the current ЦУП account's Bitrix employee ID, the same way the
// planner does — via engineer_name -> USERS reverse lookup.
async function resolveBitrixIdForAccount(accountUserId) {
  const { rows } = await pool.query('SELECT engineer_name FROM ticketsmodule_users WHERE id=$1', [accountUserId]);
  const name = rows[0]?.engineer_name;
  if (!name) return null;
  const found = Object.entries(USERS).find(([, n]) => n === name);
  return found ? parseInt(found[0], 10) : null;
}

function quarterRange(year, quarter) {
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59));
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// GET /api/bonus/calculate?year=2026&quarter=2[&engineerId=123]
// admin/coordinator can pass any engineerId (or omit for everyone);
// everyone else only ever sees their own numbers regardless of what they pass.
router.get('/calculate', requireAuth(), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const quarter = parseInt(req.query.quarter, 10);
    if (![1,2,3,4].includes(quarter)) return res.status(400).json({ error: 'Укажите квартал (1-4)' });

    const { start, end } = quarterRange(year, quarter);
    const { calculateQuarterBonuses } = require('../bonus-calc');
    const { byEngineer, skippedItems, totalReports, totalRequests } = await calculateQuarterBonuses(start, end);

    let result = byEngineer;
    if (!isPm(req.user)) {
      const myBitrixId = await resolveBitrixIdForAccount(req.user.id);
      result = myBitrixId && byEngineer[myBitrixId] ? { [myBitrixId]: byEngineer[myBitrixId] } : {};
    } else if (req.query.engineerId) {
      const id = parseInt(req.query.engineerId, 10);
      result = byEngineer[id] ? { [id]: byEngineer[id] } : {};
    }

    const withNames = Object.values(result).map(e => ({ ...e, engineerName: USERS[e.engineerId] || `#${e.engineerId}` }));
    withNames.sort((a,b) => b.totalKzt - a.totalKzt);

    res.json({
      year, quarter, period: { start, end },
      engineers: withNames,
      grandTotalKzt: withNames.reduce((s,e) => s + e.totalKzt, 0),
      totalReports,
      totalRequests,
      skippedCount: skippedItems.length,
      skipped: isPm(req.user) ? skippedItems : undefined,
    });
  } catch (e) {
    console.error('GET /api/bonus/calculate error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/bonus/engineers — list of ЦУП accounts that map to a Bitrix
// employee, for the PM/admin "filter by engineer" dropdown.
router.get('/engineers', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT engineer_name FROM ticketsmodule_users WHERE engineer_name IS NOT NULL AND active=true');
    const engineers = rows
      .map(r => {
        const found = Object.entries(USERS).find(([, n]) => n === r.engineer_name);
        return found ? { bitrixId: parseInt(found[0], 10), name: found[1] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    res.json({ engineers });
  } catch (e) { console.error('GET /api/bonus/engineers error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/bonus/export — takes the already-calculated result (same shape
// GET /calculate returns) and turns it into an .xlsx matching the historical
// per-engineer bonus file layout. Re-uses what was already fetched instead
// of recalculating against Bitrix a second time.
router.post('/export', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { engineers, year, quarter } = req.body;
    if (!Array.isArray(engineers)) return res.status(400).json({ error: 'Нет данных для экспорта' });

    const money = n => Math.round((n || 0) * 100) / 100;
    const wb = XLSX.utils.book_new();

    for (const eng of engineers) {
      const rows = [[
        '№', 'Период проведения работ', 'Клиент', 'Договор', 'Наименование и модель прибора',
        'Основание расчёта', 'Курс доллара', 'Сумма (KZT экв.)', 'Доля инженера, KZT', 'Ссылка на заявку',
      ]];
      (eng.lines || []).forEach((li, i) => {
        const period = li.workStart && li.workEnd && li.workStart.slice(0,10) !== li.workEnd.slice(0,10)
          ? `${li.workStart.slice(0,10)} – ${li.workEnd.slice(0,10)}` : (li.workEnd || li.workStart || '').slice(0,10);
        rows.push([
          i + 1, period, li.companyName || '', li.contractLabel || '', li.instrument || li.serviceType || '',
          li.basis || '', li.rate || '', money(li.totalKzt), money(li.shareKzt),
          `https://crm.prolabsupport.kz/crm/type/1058/details/${li.requestId}/`,
        ]);
      });
      rows.push(['', '', '', '', '', '', '', 'Итого, тенге (до налогов)', money(eng.totalKzt), '']);

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{wch:5},{wch:22},{wch:28},{wch:22},{wch:26},{wch:34},{wch:10},{wch:16},{wch:16},{wch:40}];
      const safeName = (eng.engineerName || `eng_${eng.engineerId}`).replace(/[\\/*?:[\]]/g, '').slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, safeName || `Инженер ${eng.engineerId}`);
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Bonus_Q${quarter}_${year}.xlsx"`);
    res.send(buffer);
  } catch (e) {
    console.error('POST /api/bonus/export error:', e.message);
    res.status(500).json({ error: 'Не удалось сформировать файл' });
  }
});

module.exports = { router };
