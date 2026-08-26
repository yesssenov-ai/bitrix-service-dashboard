// ProLab AI — история обращений по каждому сотруднику (отдельный диалог на user_id).
// Таблица создаётся лениво при первом использовании. Храним компактную сводку
// каждого запроса (вопрос + результат), без строк выборки — чтобы было легко.
const { pool } = require('./auth');

let ensured = false;
async function ensure() {
  if (ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_plsai_history (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    q TEXT NOT NULL,
    payload JSONB NOT NULL
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_plsai_hist_user ON ticketsmodule_plsai_history(user_id, id DESC)');
  ensured = true;
}

async function save(userId, q, payload) {
  if (!userId) return;
  try {
    await ensure();
    await pool.query('INSERT INTO ticketsmodule_plsai_history (user_id, q, payload) VALUES ($1,$2,$3)',
      [userId, String(q || '').slice(0, 500), JSON.stringify(payload || {})]);
    // Оставляем последние 100 записей на пользователя.
    await pool.query(`DELETE FROM ticketsmodule_plsai_history WHERE user_id=$1 AND id NOT IN
      (SELECT id FROM ticketsmodule_plsai_history WHERE user_id=$1 ORDER BY id DESC LIMIT 100)`, [userId]);
  } catch (e) { console.error('plsai history save:', e.message); }
}

async function list(userId, limit = 60) {
  if (!userId) return [];
  try {
    await ensure();
    const { rows } = await pool.query(
      'SELECT id, created_at, q, payload FROM ticketsmodule_plsai_history WHERE user_id=$1 ORDER BY id DESC LIMIT $2',
      [userId, limit]);
    return rows.reverse().map(r => Object.assign({ id: Number(r.id), at: r.created_at, q: r.q }, r.payload || {}));
  } catch (e) { console.error('plsai history list:', e.message); return []; }
}

async function clear(userId) {
  if (!userId) return;
  try { await ensure(); await pool.query('DELETE FROM ticketsmodule_plsai_history WHERE user_id=$1', [userId]); }
  catch (e) { console.error('plsai history clear:', e.message); }
}

module.exports = { save, list, clear };
