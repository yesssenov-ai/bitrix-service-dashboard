// Run in Railway Console: node list-non-email-logins.js
// Lists every user whose username isn't email-formatted — these can't send
// client correspondence (the send endpoint requires username to look like
// an email, since it's used directly as the SMTP "from" address).
const { pool } = require('./auth');

async function main() {
  const { rows } = await pool.query('SELECT id, username, display_name, role FROM ticketsmodule_users WHERE active=true ORDER BY id');
  const nonEmail = rows.filter(u => !u.username.includes('@'));
  console.log(`Всего активных пользователей: ${rows.length}`);
  console.log(`Логин не похож на почту: ${nonEmail.length}\n`);
  nonEmail.forEach(u => console.log(`  id=${u.id} | ${u.username} | ${u.display_name} | ${u.role}`));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
