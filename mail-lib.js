const { pool } = require('./auth');

// ── Classification ──────────────────────────────────────────────────────────

async function classify(email) {
  const rules = await getRules();
  const learned = await getLearnedPatterns();

  const fromLower = (email.from_addr || '').toLowerCase();
  const subjectLower = (email.subject || '').toLowerCase();

  for (const rule of rules) {
    const target = rule.field === 'from' ? fromLower : subjectLower;
    if (target.includes(rule.pattern.toLowerCase())) {
      await incrementRule(rule.id);
      return { category: rule.category, source: 'rule' };
    }
  }

  for (const pattern of learned) {
    const target = pattern.field === 'from' ? fromLower : subjectLower;
    if (target.includes(pattern.pattern.toLowerCase())) {
      return { category: pattern.category, source: 'learned' };
    }
  }

  return { category: 'uncategorized', source: 'none' };
}

async function learnFromManualChange(email, newCategory) {
  try {
    const match = (email.from_addr || '').match(/@([\w.-]+)/);
    if (match) {
      await learnPattern(match[1].toLowerCase(), 'from', newCategory);
    }
    const words = (email.subject || '')
      .toLowerCase()
      .replace(/[^\wа-яё\s]/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 4);
    if (words.length > 0) {
      await learnPattern(words[0], 'subject', newCategory);
    }
  } catch (e) {
    console.error('learnFromManualChange error:', e.message);
  }
}

// ── DB access ────────────────────────────────────────────────────────────────

async function upsertEmail(data) {
  await pool.query(`
    INSERT INTO ticketsmodule_mail_emails
      (id, message_id, in_reply_to, from_addr, from_name, subject, received_at, category, category_source, body_preview, mailbox)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(id) DO NOTHING
  `, [data.id, data.message_id, data.in_reply_to, data.from_addr, data.from_name,
      data.subject, data.received_at, data.category, data.category_source, data.body_preview,
      data.mailbox || 'service']);
}

async function findBySubject(subject) {
  const { rows } = await pool.query(
    "SELECT * FROM ticketsmodule_mail_emails WHERE LOWER(REGEXP_REPLACE(subject, '^(re|fw|fwd):\\s*', '', 'gi')) = LOWER($1) ORDER BY received_at DESC LIMIT 1",
    [subject]
  );
  return rows[0] || null;
}

async function findByMessageId(messageId) {
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_mail_emails WHERE message_id = $1', [messageId]);
  return rows[0] || null;
}

async function markAnswered(answeredBy, messageId, answerBody = null, answerSubject = null) {
  await pool.query(
    'UPDATE ticketsmodule_mail_emails SET answered = 1, answered_at = NOW(), answered_by = $1, answer_body = $2, answer_subject = $3 WHERE message_id = $4',
    [answeredBy, answerBody, answerSubject, messageId]
  );
}

async function updateCategory(category, id) {
  await pool.query('UPDATE ticketsmodule_mail_emails SET category = $1, category_source = $2 WHERE id = $3',
    [category, 'manual', id]);
}

async function getEmails(filter = {}) {
  let sql = 'SELECT * FROM ticketsmodule_mail_emails WHERE 1=1';
  const params = [];
  let i = 1;
  if (filter.category) { sql += ` AND category = $${i++}`; params.push(filter.category); }
  if (filter.answered !== undefined) { sql += ` AND answered = $${i++}`; params.push(filter.answered); }
  if (filter.date) { sql += ` AND DATE(received_at) = $${i++}`; params.push(filter.date); }
  if (filter.mailbox) { sql += ` AND mailbox = $${i++}`; params.push(filter.mailbox); }
  sql += ' ORDER BY received_at DESC LIMIT 500';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getPendingEmails() {
  const { rows } = await pool.query(`
    SELECT * FROM ticketsmodule_mail_emails
    WHERE answered = 0 AND category != 'spam' AND category != 'adv'
    ORDER BY received_at DESC
  `);
  return rows;
}

async function getUnnotified(minutes) {
  const { rows } = await pool.query(`
    SELECT * FROM ticketsmodule_mail_emails
    WHERE answered = 0 AND category = 'client' AND notified = 0
      AND received_at <= NOW() - ($1 || ' minutes')::INTERVAL
  `, [minutes]);
  return rows;
}

async function markNotified(id) {
  await pool.query('UPDATE ticketsmodule_mail_emails SET notified = 1 WHERE id = $1', [id]);
}

async function getStats(mailbox = null) {
  let sql = `SELECT
      COUNT(*) as total,
      SUM(answered) as answered,
      SUM(CASE WHEN category='spam' THEN 1 ELSE 0 END) as spam,
      SUM(CASE WHEN category='tender' THEN 1 ELSE 0 END) as tender,
      SUM(CASE WHEN category='adv' THEN 1 ELSE 0 END) as adv,
      SUM(CASE WHEN category='client' THEN 1 ELSE 0 END) as client,
      SUM(CASE WHEN category='uncategorized' THEN 1 ELSE 0 END) as uncategorized,
      SUM(CASE WHEN answered=0 AND (category='client' OR category='uncategorized') THEN 1 ELSE 0 END) as pending_client
    FROM ticketsmodule_mail_emails
    WHERE DATE(received_at) = CURRENT_DATE`;
  const params = [];
  if (mailbox) { sql += ` AND mailbox = $1`; params.push(mailbox); }
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

async function getRules() {
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_mail_rules ORDER BY hit_count DESC');
  return rows;
}

async function addRule(field, pattern, category) {
  const { rows } = await pool.query(
    'INSERT INTO ticketsmodule_mail_rules (field, pattern, category) VALUES ($1,$2,$3) RETURNING id',
    [field, pattern, category]
  );
  return rows[0];
}

async function deleteRule(id) {
  await pool.query('DELETE FROM ticketsmodule_mail_rules WHERE id = $1', [id]);
}

async function incrementRule(id) {
  await pool.query('UPDATE ticketsmodule_mail_rules SET hit_count = hit_count + 1 WHERE id = $1', [id]);
}

async function learnPattern(pattern, field, category) {
  await pool.query(`
    INSERT INTO ticketsmodule_mail_learned_patterns (pattern, field, category)
    VALUES ($1,$2,$3)
    ON CONFLICT(pattern, field) DO UPDATE SET
      confidence = ticketsmodule_mail_learned_patterns.confidence + 1,
      category = EXCLUDED.category
  `, [pattern, field, category]);
}

async function getLearnedPatterns() {
  const { rows } = await pool.query(
    'SELECT * FROM ticketsmodule_mail_learned_patterns WHERE confidence >= 2 ORDER BY confidence DESC'
  );
  return rows;
}

module.exports = {
  classify, learnFromManualChange,
  upsertEmail, findBySubject, findByMessageId, markAnswered, updateCategory,
  getEmails, getPendingEmails, getUnnotified, markNotified, getStats,
  getRules, addRule, deleteRule, incrementRule, learnPattern, getLearnedPatterns,
};
