const { pool } = require('./auth');

// Builds { clientName, dateStr, modules: [...], grandTotal } from a kp_request_id.
// Numbering (1, 1.1, 1.1.1 ...) is computed fresh each time from whichever
// categories/sections/items actually have quantities selected — matching the
// real template's behaviour of never leaving numbering gaps.
async function assembleKpData(kpRequestId) {
  const { rows: reqRows } = await pool.query(
    `SELECT * FROM ticketsmodule_kp_requests WHERE id=$1`, [kpRequestId]
  );
  if (!reqRows.length) throw new Error('Заявка не найдена');
  const request = reqRows[0];

  const { rows: cats } = await pool.query(
    `SELECT rc.category_id, c.slug, c.name AS category_name, c.sort_order
     FROM ticketsmodule_kp_request_categories rc
     JOIN ticketsmodule_kp_categories c ON c.id=rc.category_id
     WHERE rc.kp_request_id=$1 ORDER BY c.sort_order`, [kpRequestId]
  );
  const { rows: lineItems } = await pool.query(
    `SELECT li.quantity, li.unit_price_snapshot, li.is_included_snapshot,
            it.category_id, it.section_name, it.name, it.sort_order
     FROM ticketsmodule_kp_line_items li
     JOIN ticketsmodule_kp_items it ON it.id=li.item_id
     WHERE li.kp_request_id=$1
     ORDER BY it.category_id, it.sort_order`, [kpRequestId]
  );

  const modules = [];
  let grandTotal = 0;
  let moduleNo = 0;

  for (const cat of cats) {
    const items = lineItems.filter(li => li.category_id === cat.category_id);
    if (!items.length) continue; // skip categories nobody filled in

    moduleNo++;
    const hasSections = items.some(it => it.section_name);

    let sectionsOut = [];
    let moduleTotal = 0;

    if (hasSections) {
      const sectionOrder = [];
      const bySection = {};
      items.forEach(it => {
        const key = it.section_name || '—';
        if (!bySection[key]) { bySection[key] = []; sectionOrder.push(key); }
        bySection[key].push(it);
      });
      sectionOrder.forEach((secName, sIdx) => {
        const secNo = `${moduleNo}.${sIdx + 1}`;
        const itemsOut = bySection[secName].map((it, iIdx) => {
          const lineTotal = it.is_included_snapshot ? null : it.quantity * (it.unit_price_snapshot || 0);
          if (lineTotal) moduleTotal += lineTotal;
          return {
            no: `${secNo}.${iIdx + 1}`, name: it.name, qty: it.quantity,
            unitPrice: it.unit_price_snapshot, included: it.is_included_snapshot, lineTotal,
          };
        });
        sectionsOut.push({ no: secNo, name: secName, items: itemsOut });
      });
    } else {
      // Flat category (no sections) — e.g. Услуги: single-level numbering
      const itemsOut = items.map((it, iIdx) => {
        const lineTotal = it.is_included_snapshot ? null : it.quantity * (it.unit_price_snapshot || 0);
        if (lineTotal) moduleTotal += lineTotal;
        return {
          no: `${moduleNo}.${iIdx + 1}`, name: it.name, qty: it.quantity,
          unitPrice: it.unit_price_snapshot, included: it.is_included_snapshot, lineTotal,
        };
      });
      sectionsOut.push({ no: null, name: null, items: itemsOut });
    }

    grandTotal += moduleTotal;
    modules.push({ no: moduleNo, name: cat.category_name, slug: cat.slug, sections: sectionsOut, moduleTotal, flat: !hasSections });
  }

  return {
    request,
    clientName: request.client_name,
    dateStr: new Date(request.updated_at || request.created_at).toLocaleDateString('ru-RU'),
    modules,
    grandTotal,
  };
}

module.exports = { assembleKpData };
