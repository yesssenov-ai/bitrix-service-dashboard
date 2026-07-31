const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { requireAuth, pool } = require('../auth');
const { notifyPersonal } = require('../kp-notify');

// PM-level access: who may create requests, review, and approve. Kept as a
// simple role check for now — matches the existing role model instead of
// inventing a new "PM" role.
const PM_ROLES = ['admin', 'coordinator'];
function isPm(user) { return PM_ROLES.includes(user.role); }

// ── Catalog (active version) ────────────────────────────────────────────────
router.get('/catalog', requireAuth(), async (req, res) => {
  try {
    const { rows: verRows } = await pool.query(`SELECT id, uploaded_at, note FROM ticketsmodule_kp_catalog_versions WHERE active=true LIMIT 1`);
    if (!verRows.length) return res.json({ version: null, categories: [] });
    const version = verRows[0];

    const { rows: cats } = await pool.query(`SELECT id, slug, name, sort_order FROM ticketsmodule_kp_categories ORDER BY sort_order`);
    const { rows: items } = await pool.query(
      `SELECT id, category_id, section_name, item_no, name, unit_price, is_included, specs, power_kw, sort_order
       FROM ticketsmodule_kp_items WHERE catalog_version_id=$1 ORDER BY category_id, sort_order`,
      [version.id]
    );
    const byCategory = {};
    items.forEach(it => { (byCategory[it.category_id] = byCategory[it.category_id] || []).push(it); });

    res.json({
      version,
      categories: cats.map(c => ({ ...c, items: byCategory[c.id] || [] })),
    });
  } catch (e) { console.error('GET /api/kp/catalog error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/kp/my-categories — which category slugs the current user is assigned to (for the expert view)
router.get('/my-categories', requireAuth(), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.slug FROM ticketsmodule_kp_request_categories rc
     JOIN ticketsmodule_kp_categories c ON c.id=rc.category_id
     WHERE rc.expert_id=$1`, [req.user.id]
  );
  const assignedSlugs = rows.map(r => r.slug);
  const accountSlugs = req.user.kp_categories || [];
  const categories = [...new Set([...assignedSlugs, ...accountSlugs])];
  res.json({ categories, isPm: isPm(req.user) });
});

// ── Requests ─────────────────────────────────────────────────────────────────

router.get('/requests', requireAuth(), async (req, res) => {
  try {
    let sql, params;
    if (isPm(req.user)) {
      sql = `SELECT r.*, u.display_name AS created_by_name
             FROM ticketsmodule_kp_requests r LEFT JOIN ticketsmodule_users u ON u.id=r.created_by
             ORDER BY r.created_at DESC`;
      params = [];
    } else {
      sql = `SELECT DISTINCT r.*, u.display_name AS created_by_name
             FROM ticketsmodule_kp_requests r
             JOIN ticketsmodule_kp_request_categories rc ON rc.kp_request_id=r.id
             LEFT JOIN ticketsmodule_users u ON u.id=r.created_by
             WHERE rc.expert_id=$1
             ORDER BY r.created_at DESC`;
      params = [req.user.id];
    }
    const { rows } = await pool.query(sql, params);
    res.json({ requests: rows });
  } catch (e) { console.error('GET /api/kp/requests error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/requests', requireAuth(PM_ROLES), async (req, res) => {
  const { clientName, categories } = req.body; // categories: [{categoryId, expertId}]
  if (!clientName || !Array.isArray(categories) || !categories.length) {
    return res.status(400).json({ error: 'Укажите клиента и хотя бы одну категорию' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: verRows } = await client.query(`SELECT id FROM ticketsmodule_kp_catalog_versions WHERE active=true LIMIT 1`);
    if (!verRows.length) throw new Error('Нет активной версии каталога');
    const { rows: reqRows } = await client.query(
      `INSERT INTO ticketsmodule_kp_requests (client_name, created_by, pm_id, catalog_version_id, status)
       VALUES ($1,$2,$3,$4,'draft') RETURNING *`,
      [clientName.trim(), req.user.id, req.user.id, verRows[0].id]
    );
    const kpId = reqRows[0].id;
    for (const c of categories) {
      await client.query(
        `INSERT INTO ticketsmodule_kp_request_categories (kp_request_id, category_id, expert_id, status)
         VALUES ($1,$2,$3,'pending')`,
        [kpId, c.categoryId, c.expertId || null]
      );
    }
    await client.query('COMMIT');

    for (const c of categories) {
      if (c.expertId) {
        notifyPersonal(c.expertId, `📋 Новая заявка на КП`,
          `Вам назначена категория в заявке на КП для клиента «${clientName}».`,
          `/kp.html?request=${kpId}`).catch(()=>{});
      }
    }
    res.json({ request: reqRows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/kp/requests error:', e.message);
    res.status(500).json({ error: e.message || 'Server error' });
  } finally { client.release(); }
});

router.get('/requests/:id', requireAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: reqRows } = await pool.query(
      `SELECT r.*, u.display_name AS created_by_name, pm.display_name AS pm_name
       FROM ticketsmodule_kp_requests r
       LEFT JOIN ticketsmodule_users u ON u.id=r.created_by
       LEFT JOIN ticketsmodule_users pm ON pm.id=r.pm_id
       WHERE r.id=$1`, [id]
    );
    if (!reqRows.length) return res.status(404).json({ error: 'Не найдено' });
    const request = reqRows[0];

    const { rows: cats } = await pool.query(
      `SELECT rc.*, c.slug, c.name AS category_name, e.display_name AS expert_name
       FROM ticketsmodule_kp_request_categories rc
       JOIN ticketsmodule_kp_categories c ON c.id=rc.category_id
       LEFT JOIN ticketsmodule_users e ON e.id=rc.expert_id
       WHERE rc.kp_request_id=$1 ORDER BY c.sort_order`, [id]
    );
    const { rows: lineItems } = await pool.query(
      `SELECT li.*, it.name, it.category_id, it.section_name, it.item_no
       FROM ticketsmodule_kp_line_items li JOIN ticketsmodule_kp_items it ON it.id=li.item_id
       WHERE li.kp_request_id=$1`, [id]
    );
    const { rows: comments } = await pool.query(
      `SELECT co.*, u.display_name AS author_name FROM ticketsmodule_kp_comments co
       LEFT JOIN ticketsmodule_users u ON u.id=co.author_id
       WHERE co.kp_request_id=$1 ORDER BY co.created_at DESC`, [id]
    );

    res.json({ request, categories: cats, lineItems, comments });
  } catch (e) { console.error('GET /api/kp/requests/:id error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// Expert saves their quantities for one category
router.put('/requests/:id/categories/:categoryId', requireAuth(), async (req, res) => {
  const kpId = parseInt(req.params.id, 10);
  const categoryId = parseInt(req.params.categoryId, 10);
  const items = Array.isArray(req.body.items) ? req.body.items : []; // [{itemId, quantity}]

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: rcRows } = await client.query(
      `SELECT * FROM ticketsmodule_kp_request_categories WHERE kp_request_id=$1 AND category_id=$2`,
      [kpId, categoryId]
    );
    if (!rcRows.length) throw new Error('Категория не найдена в заявке');
    if (rcRows[0].expert_id && rcRows[0].expert_id !== req.user.id && !isPm(req.user)) {
      throw new Error('Эта категория назначена другому эксперту');
    }

    // Replace this category's line items with what was submitted
    const { rows: catItemIds } = await client.query(`SELECT id, unit_price, is_included FROM ticketsmodule_kp_items WHERE category_id=$1`, [categoryId]);
    const priceById = {}; catItemIds.forEach(i => { priceById[i.id] = i; });
    const validIds = new Set(catItemIds.map(i => i.id));

    await client.query(
      `DELETE FROM ticketsmodule_kp_line_items WHERE kp_request_id=$1 AND item_id IN (SELECT id FROM ticketsmodule_kp_items WHERE category_id=$2)`,
      [kpId, categoryId]
    );
    for (const it of items) {
      const qty = parseFloat(it.quantity);
      if (!validIds.has(it.itemId) || !qty || qty <= 0) continue;
      const meta = priceById[it.itemId];
      await client.query(
        `INSERT INTO ticketsmodule_kp_line_items (kp_request_id, item_id, quantity, unit_price_snapshot, is_included_snapshot)
         VALUES ($1,$2,$3,$4,$5)`,
        [kpId, it.itemId, qty, meta.unit_price, meta.is_included]
      );
    }

    await client.query(
      `UPDATE ticketsmodule_kp_request_categories SET status='saved', saved_at=NOW() WHERE kp_request_id=$1 AND category_id=$2`,
      [kpId, categoryId]
    );
    await client.query(`UPDATE ticketsmodule_kp_requests SET status='in_review', updated_at=NOW() WHERE id=$1 AND status='draft'`, [kpId]);
    const { rows: reqInfo } = await client.query(`SELECT client_name, pm_id FROM ticketsmodule_kp_requests WHERE id=$1`, [kpId]);
    await client.query('COMMIT');

    if (reqInfo[0]?.pm_id) {
      notifyPersonal(reqInfo[0].pm_id, `✅ Категория готова к проверке`,
        `${req.user.display_name} сохранил(а) категорию по заявке «${reqInfo[0].client_name}».`,
        `/kp.html?request=${kpId}`).catch(()=>{});
    }
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PUT /api/kp/requests/:id/categories/:categoryId error:', e.message);
    res.status(400).json({ error: e.message || 'Server error' });
  } finally { client.release(); }
});

// PM sends a category (or whole request) back for revision, with a comment
router.post('/requests/:id/revise', requireAuth(PM_ROLES), async (req, res) => {
  const kpId = parseInt(req.params.id, 10);
  const { categoryId, comment } = req.body;
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Добавьте комментарий' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ticketsmodule_kp_comments (kp_request_id, category_id, author_id, body) VALUES ($1,$2,$3,$4)`,
      [kpId, categoryId || null, req.user.id, comment.trim()]
    );
    if (categoryId) {
      await client.query(`UPDATE ticketsmodule_kp_request_categories SET status='needs_revision' WHERE kp_request_id=$1 AND category_id=$2`, [kpId, categoryId]);
    } else {
      await client.query(`UPDATE ticketsmodule_kp_request_categories SET status='needs_revision' WHERE kp_request_id=$1`, [kpId]);
    }
    await client.query(`UPDATE ticketsmodule_kp_requests SET status='needs_revision', updated_at=NOW() WHERE id=$1`, [kpId]);
    const { rows: catRows } = await client.query(
      `SELECT expert_id FROM ticketsmodule_kp_request_categories WHERE kp_request_id=$1 AND expert_id IS NOT NULL` + (categoryId ? ' AND category_id=$2' : ''),
      categoryId ? [kpId, categoryId] : [kpId]
    );
    const { rows: reqInfo } = await client.query(`SELECT client_name FROM ticketsmodule_kp_requests WHERE id=$1`, [kpId]);
    await client.query('COMMIT');

    for (const c of catRows) {
      notifyPersonal(c.expert_id, `✏️ Заявка на доработку`,
        `По заявке «${reqInfo[0]?.client_name}» есть комментарий: ${comment.trim()}`,
        `/kp.html?request=${kpId}`).catch(()=>{});
    }
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/kp/requests/:id/revise error:', e.message);
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// PM approves — marks the request approved (document generation is wired in separately)
router.post('/requests/:id/approve', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const kpId = parseInt(req.params.id, 10);
    await pool.query(`UPDATE ticketsmodule_kp_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [kpId]);
    res.json({ ok: true });
  } catch (e) { console.error('POST /api/kp/requests/:id/approve error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// List of possible experts (any active user, for the PM's assignment picker)
router.get('/experts', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, display_name, kp_categories FROM ticketsmodule_users WHERE active=true ORDER BY display_name`);
    res.json({ experts: rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// PM adds a category to an already-created request
router.post('/requests/:id/categories', requireAuth(PM_ROLES), async (req, res) => {
  const kpId = parseInt(req.params.id, 10);
  const { categoryId, expertId } = req.body;
  if (!categoryId) return res.status(400).json({ error: 'Не указана категория' });
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_kp_request_categories (kp_request_id, category_id, expert_id, status)
       VALUES ($1,$2,$3,'pending') ON CONFLICT (kp_request_id, category_id) DO NOTHING`,
      [kpId, categoryId, expertId || null]
    );
    if (expertId) {
      const { rows: reqInfo } = await pool.query(`SELECT client_name FROM ticketsmodule_kp_requests WHERE id=$1`, [kpId]);
      notifyPersonal(expertId, `📋 Вам назначена категория КП`,
        `Вам назначена категория в заявке на КП для клиента «${reqInfo[0]?.client_name}».`,
        `/kp.html?request=${kpId}`).catch(()=>{});
    }
    res.json({ ok: true });
  } catch (e) { console.error('POST /requests/:id/categories error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// PM reassigns the expert for one category in an existing request
router.put('/requests/:id/categories/:categoryId/assign', requireAuth(PM_ROLES), async (req, res) => {
  const kpId = parseInt(req.params.id, 10);
  const categoryId = parseInt(req.params.categoryId, 10);
  const expertId = req.body.expertId ? parseInt(req.body.expertId, 10) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE ticketsmodule_kp_request_categories SET expert_id=$1, status='pending', saved_at=NULL
       WHERE kp_request_id=$2 AND category_id=$3 RETURNING *`,
      [expertId, kpId, categoryId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Категория не найдена' });
    if (expertId) {
      const { rows: reqInfo } = await pool.query(`SELECT client_name FROM ticketsmodule_kp_requests WHERE id=$1`, [kpId]);
      notifyPersonal(expertId, `📋 Вам назначена категория КП`,
        `Вам назначена категория в заявке на КП для клиента «${reqInfo[0]?.client_name}».`,
        `/kp.html?request=${kpId}`).catch(()=>{});
    }
    res.json({ ok: true });
  } catch (e) { console.error('PUT /categories/:categoryId/assign error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// Download the generated KP document — only once the request is approved.
// PDF is temporarily disabled: it doesn't match the branded Word template
// visually yet (see kp-generate-pdf.js), so only docx is offered for now.
router.get('/requests/:id/document', requireAuth(PM_ROLES), async (req, res) => {
  const kpId = parseInt(req.params.id, 10);
  if (req.query.format === 'pdf') {
    return res.status(400).json({ error: 'PDF временно отключён — используйте Word' });
  }
  try {
    const { rows } = await pool.query('SELECT status, client_name FROM ticketsmodule_kp_requests WHERE id=$1', [kpId]);
    if (!rows.length) return res.status(404).json({ error: 'Не найдено' });
    if (rows[0].status !== 'approved') return res.status(400).json({ error: 'Заявка ещё не одобрена' });

    const safeClient = rows[0].client_name.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '_');
    const encodedClient = encodeURIComponent(`KP_${safeClient}`);
    const { generateKpDocx } = require('../kp-generate-docx');
    const buf = await generateKpDocx(kpId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="KP.docx"; filename*=UTF-8''${encodedClient}.docx`);
    res.send(buf);
  } catch (e) {
    console.error('GET /requests/:id/document error:', e.message);
    res.status(500).json({ error: 'Не удалось сформировать файл' });
  }
});

// ── Catalog version management (upload / rollback) ──────────────────────────
router.get('/catalog/versions', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.uploaded_at, v.filename, v.note, v.active, u.display_name AS uploaded_by_name,
              (SELECT COUNT(*) FROM ticketsmodule_kp_items WHERE catalog_version_id=v.id) AS item_count
       FROM ticketsmodule_kp_catalog_versions v
       LEFT JOIN ticketsmodule_users u ON u.id=v.uploaded_by
       ORDER BY v.uploaded_at DESC`
    );
    res.json({ versions: rows });
  } catch (e) { console.error('GET /catalog/versions error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/catalog/upload', requireAuth(PM_ROLES), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  try {
    const { importCatalogVersion } = require('../kp-catalog-import');
    const result = await importCatalogVersion({
      buffer: req.file.buffer, filename: req.file.originalname,
      note: req.body.note || null, uploadedBy: req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('POST /catalog/upload error:', e.message);
    res.status(500).json({ error: 'Не удалось разобрать файл: ' + e.message });
  }
});

router.post('/catalog/versions/:id/activate', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const versionId = parseInt(req.params.id, 10);
    const { rows } = await pool.query('SELECT id FROM ticketsmodule_kp_catalog_versions WHERE id=$1', [versionId]);
    if (!rows.length) return res.status(404).json({ error: 'Версия не найдена' });
    await pool.query('UPDATE ticketsmodule_kp_catalog_versions SET active=false');
    await pool.query('UPDATE ticketsmodule_kp_catalog_versions SET active=true WHERE id=$1', [versionId]);
    res.json({ ok: true });
  } catch (e) { console.error('POST /catalog/versions/:id/activate error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

module.exports = { router };
