// Экспорт ЗАГОЛОВКОВ ящика для передачи дел (техотдел ProLab). Только заголовки
// (от/кому/копия/тема/дата) — без тел и вложений. Read-only, ничего не меняет.
// ДОКАЧКА: прогресс в _handover/mail-progress.json, файл .jsonl дописывается.
// Мягкий режим: сначала «Отправленные», затем «Входящие»; пачки по 100 с паузой;
// при обрыве — переподключение с РАСТУЩЕЙ задержкой (чтобы не словить анти-флуд Яндекса).
// Можно просто запускать повторно — продолжит с места. EXPORT_MONTHS=6 сократит период.
//
//   set EXPORT_IMAP_USER=kuanysh.e@prolabsupport.kz
//   set EXPORT_IMAP_PASS=пароль-приложения
//   node mail-export.js

const fs = require('fs');
const path = require('path');
const Imap = require('imap');

const USER = process.env.EXPORT_IMAP_USER;
const PASS = process.env.EXPORT_IMAP_PASS;
const HOST = process.env.EXPORT_IMAP_HOST || 'imap.yandex.ru';
const PORT = parseInt(process.env.EXPORT_IMAP_PORT || '993', 10);
const MONTHS = parseInt(process.env.EXPORT_MONTHS || '12', 10);
const BATCH = parseInt(process.env.EXPORT_BATCH || '100', 10);

if (!USER || !PASS) { console.error('Нет EXPORT_IMAP_USER / EXPORT_IMAP_PASS в окружении.'); process.exit(1); }

const OUT_DIR = path.join(process.cwd(), '_handover');
const OUT_FILE = path.join(OUT_DIR, 'mail-export.jsonl');
const PROG_FILE = path.join(OUT_DIR, 'mail-progress.json');
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = fs.createWriteStream(OUT_FILE, { flags: 'a' });

const since = new Date(); since.setMonth(since.getMonth() - MONTHS);
const sinceStr = since.toISOString().slice(0, 10);

let progress = {};
try { progress = JSON.parse(fs.readFileSync(PROG_FILE, 'utf8')); } catch (e) {}
const doneSet = {};
for (const f in progress) doneSet[f] = new Set(progress[f].done || []);
function persist() {
  const o = {}; for (const f in doneSet) o[f] = { uidvalidity: progress[f] && progress[f].uidvalidity, done: [...doneSet[f]] };
  fs.writeFileSync(PROG_FILE, JSON.stringify(o));
}
function decodeMime(s) {
  if (!s) return '';
  s = s.replace(/\?=\s+=\?/g, '?==?');
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    try {
      let buf;
      if (enc.toLowerCase() === 'b') buf = Buffer.from(txt, 'base64');
      else {
        const bytes = []; txt = txt.replace(/_/g, ' ');
        for (let i = 0; i < txt.length; i++) {
          if (txt[i] === '=' && /[0-9A-Fa-f]{2}/.test(txt.substr(i + 1, 2))) { bytes.push(parseInt(txt.substr(i + 1, 2), 16)); i += 2; }
          else bytes.push(txt.charCodeAt(i));
        }
        buf = Buffer.from(bytes);
      }
      return buf.toString(/utf/i.test(cs) ? 'utf8' : 'latin1');
    } catch (e) { return m; }
  });
}
function field(hdr, name) {
  const h = hdr.replace(/\r\n[ \t]+/g, ' ');
  const m = h.match(new RegExp('^' + name + ':[ \\t]*(.*)$', 'im'));
  return m ? decodeMime(m[1].trim()) : '';
}
function flatten(boxes, prefix, acc) {
  for (const name in boxes) {
    const b = boxes[name];
    const full = prefix ? prefix + (b.delimiter || '/') + name : name;
    acc.push({ path: full, attribs: (b.attribs || []).map(a => String(a).toLowerCase()) });
    if (b.children) flatten(b.children, full, acc);
  }
  return acc;
}
const openBox = (imap, n) => new Promise((res, rej) => imap.openBox(n, true, (e, b) => e ? rej(e) : res(b)));
const search = (imap, c) => new Promise((res, rej) => imap.search(c, (e, r) => e ? rej(e) : res(r || [])));
const getBoxes = (imap) => new Promise((res, rej) => imap.getBoxes((e, b) => e ? rej(e) : res(b)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let finished = false, attempts = 0;
const counters = { ok: 0 };

function fetchBatch(imap, uids, folder, state) {
  return new Promise((resolve, reject) => {
    if (!uids.length) return resolve();
    let done = 0; const total = uids.length; const okUids = [];
    const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (FROM TO CC SUBJECT DATE)', struct: false });
    f.on('message', (msg) => {
      let hdr = ''; let uid = null;
      msg.on('attributes', (a) => { uid = a.uid; });
      msg.on('body', (stream) => { stream.on('data', (c) => { hdr += c.toString('utf8'); }); });
      msg.once('end', () => {
        try {
          out.write(JSON.stringify({ folder, date: field(hdr, 'Date'), from: field(hdr, 'From'),
            to: field(hdr, 'To'), cc: field(hdr, 'Cc'), subject: field(hdr, 'Subject') }) + '\n');
          if (uid != null) okUids.push(uid); counters.ok++;
        } catch (e) {}
        done++; if (done === total) { okUids.forEach(u => state.add(u)); resolve(); }
      });
    });
    f.once('error', (e) => { okUids.forEach(u => state.add(u)); reject(e); });
    f.once('end', () => setTimeout(() => { if (done < total) { okUids.forEach(u => state.add(u)); resolve(); } }, 2500));
  });
}

async function processAll(imap) {
  const all = flatten(await getBoxes(imap), '', []);
  // Сначала «Отправленные» (исходящая почта = карта «кому пишем»), потом «Входящие».
  const sent = all.filter(b => b.attribs.includes('\\sent') || /sent|отправлен/i.test(b.path)).map(b => b.path);
  const inbox = all.filter(b => b.path.toLowerCase() === 'inbox').map(b => b.path);
  const boxes = [...new Set([...sent, ...inbox])];
  if (!boxes.length) boxes.push('INBOX');
  for (const box of boxes) {
    const info = await openBox(imap, box);
    if (!doneSet[box]) doneSet[box] = new Set();
    if (progress[box] && progress[box].uidvalidity && progress[box].uidvalidity !== info.uidvalidity) doneSet[box] = new Set();
    progress[box] = { uidvalidity: info.uidvalidity, done: [] };
    const uids = (await search(imap, [['SINCE', since]])).sort((a, b) => a - b);
    const remaining = uids.filter(u => !doneSet[box].has(u));
    if (!remaining.length) { console.log(`  ${box}: готово (${uids.length})`); continue; }
    console.log(`  ${box}: всего ${uids.length}, осталось ${remaining.length}`);
    for (let i = 0; i < remaining.length; i += BATCH) {
      await fetchBatch(imap, remaining.slice(i, i + BATCH), box, doneSet[box]);
      persist();
      process.stdout.write(`\r    ${box}: ${doneSet[box].size}/${uids.length}   `);
      await sleep(500);
    }
    console.log('');
  }
}

function start() {
  const imap = new Imap({ user: USER, password: PASS, host: HOST, port: PORT, tls: true,
    tlsOptions: { rejectUnauthorized: true }, authTimeout: 25000 });
  let settled = false;
  const retry = (why) => {
    if (settled || finished) return; settled = true;
    try { imap.end(); } catch (e) {}
    persist();
    if (attempts++ < 40) {
      const delay = Math.min(15000 * Math.pow(1.6, attempts), 300000); // 15с → до 5 мин
      console.log(`\n  (${why}) пауза ${Math.round(delay / 1000)}с и продолжаю… попытка ${attempts}`);
      setTimeout(start, delay);
    } else console.error('\nЯндекс долго не пускает. Подождите 15–30 минут и запустите снова: node mail-export.js — продолжит с места.');
  };
  imap.once('ready', async () => {
    try {
      await processAll(imap);
      finished = true; settled = true; persist();
      out.end(() => { console.log(`\nГотово. Выгружено заголовков за сессию: ${counters.ok}. Файл: ${OUT_FILE}`); try { imap.end(); } catch (e) {} });
    } catch (e) { retry('ошибка: ' + e.message); }
  });
  imap.once('error', (e) => retry('IMAP: ' + e.message));
  imap.once('end', () => { if (!finished) retry('соединение закрыто'); });
  imap.connect();
}

console.log('Период: с', sinceStr, '(', MONTHS, 'мес.), пачка', BATCH, '— сначала Отправленные, докачка включена');
start();
