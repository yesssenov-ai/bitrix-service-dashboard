// Модуль «Тренинг-центр» (Фаза 1 — Курсы). Перенос ProLabOne (артефакт claude.ai)
// на стек ЦУП. Данные — своя таблица ticketsmodule_tc_trainings в Postgres.
// Чтение — по выдаче модуля TC (requireModuleApi); запись — admin/coordinator.
const express = require('express');
const router = express.Router();
const { pool, requireAuth, requireModuleApi, isAdminLike } = require('../auth');

const WRITE = ['admin', 'coordinator']; // кто правит курсы (superadmin наследует admin)
const STATUSES = ['held', 'plan', 'lead'];

// Разовый посев реальными данными ТЦ (снимок ProLabOne). Запускается один раз:
// если таблица пустая — заливаем, иначе ничего не трогаем.
const SEED = [{"title":"GC OpenLab Workstation, 1 группа (выезд)","client":"ТШО","dates_text":"9-12 февраля","hours":32,"level":"basic","place":"Выездное обучение на площадке заказчика","method":["GC"],"status":"held","participants":[{"fio":"Кулбалиева Жанар Сексенбаевна","org":"ТОО «Тенгизшевройл»","pos":"Инженер-химик","pay":"paid","cert":"000165"},{"fio":"Калиева Гульфара Кайржановна","org":"ТОО «Тенгизшевройл»","pos":"Инженер-химик","pay":"paid","cert":"000166"},{"fio":"Нугманулы Ислам","org":"ТОО «Тенгизшевройл»","pos":"Инженер-химик","pay":"paid","cert":"000167"},{"fio":"Жантуриева Арай Армановна","org":"ТОО «Тенгизшевройл»","pos":"Инженер-химик","pay":"paid","cert":"000168"},{"fio":"Ильясов Айдынбек Калдыбекович","org":"ТОО «Тенгизшевройл»","pos":"Слесарь КИПиА","pay":"paid","cert":"000169"},{"fio":"Курмангазиев Чингисхан Турсынович","org":"ТОО «Тенгизшевройл»","pos":"Слесарь КИПиА","pay":"paid","cert":"000170"},{"fio":"Мухамедиев Наиль Рахимжанович","org":"ТОО «Тенгизшевройл»","pos":"Слесарь КИПиА","pay":"paid","cert":"000171"},{"fio":"Нигметов Ерик Алибекович","org":"ТОО «Тенгизшевройл»","pos":"Лаборант","pay":"paid","cert":"000172"}],"issued":true,"note":"# Рекомендации к закупке расходных материалов и услуг:\n\nПри дальнейшей эксплуатации хроматографического оборудования, для обеспечения корректной и бесперебойной работы системы, а также своевременного выполнения регламентных работ по техническому обслуживанию, необходимо планово осуществлять следующие закупки:\n\n# 1. ЕЖЕГОДНО (рекомендуется закупить в ближайшее время):\n\n# Приобретать наборы для обслуживания узлов ВЭЖХ:\n\n* Насос (Binary Pump 1260 Infinity II) - Preventive maintenance kit for 1260 Infinity/Infinity II and III Binary pump (кат. номер - G1312-68741);\n* Если конфигурация насоса включает в себя промывку уплотнений (Active Seal Wash), добавить Seal wash preventive maintenance kit (кат. номер - G1310-68742) × 2 ед.;\n* Автосамплер (Vialsampler 1260 Infinity II) - Preventive maintenance kit for 1260 Infinity II and III vialsampler  (кат. номер - G7129-68740);\n* Диодно-матричный детектор (DAD 1260 Infinity II) - InfinityLab Long-life Deuterium DAD/MWD Lamp with RFID tag (кат. номер - 2140-0820)."},{"title":"AAS, 1-я группа","client":"АлтынАлмас","dates_text":"20-24 апреля","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[{"fio":"Кусаиынов Ильяс Кусаиынов","org":"АО \"АК Алтыналмас\"","pos":"старший лаборант","pay":"wait","cert":""},{"fio":"Иманбаев Әділжан Сауытбекұлы","org":"АО \"АК Алтыналмас\"","pos":"Инженер-металлург","pay":"wait","cert":""},{"fio":"Жүсіп Мадияр Ерболатұлы","org":"АО \"АК Алтыналмас\"","pos":"старший лаборант","pay":"wait","cert":""},{"fio":"Шеряз Алмаз Серікболұлы","org":"АО \"АК Алтыналмас\"","pos":"Инженер-металлург","pay":"wait","cert":""},{"fio":"Садықов Еділ Саматұлы","org":"АО \"АК Алтыналмас\"","pos":"старший лаборант","pay":"wait","cert":""},{"fio":"Жумашев Алмас Муратович","org":"АО \"АК Алтыналмас\"","pos":"Инженер","pay":"wait","cert":""},{"fio":"Пернебек Абай Айдарұлы","org":"АО \"АК Алтыналмас\"","pos":"старший лаборант","pay":"wait","cert":""},{"fio":"Тузубеков Темірлан Шынарбекұлы","org":"АО \"АК Алтыналмас\"","pos":"старший лаборант","pay":"wait","cert":""}],"issued":false,"note":""},{"title":"AAS","client":"ГРК МЛД","dates_text":"12-16 мая","hours":32,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[{"fio":"Дюдина Юлия Михайловна","org":"ТОО “Грк млд”","pos":"Лаборант","pay":"paid","cert":""},{"fio":"Танырбердинова Карлыгаш Еркыновна","org":"ТОО “Грк млд”","pos":"Лаборант","pay":"paid","cert":""}],"issued":false,"note":""},{"title":"AAS","client":"","dates_text":"15-19 июня","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[{"fio":"Шиденова Марал Хайруллиновна","org":"АО \"Майкаинзолото\"","pos":"Инженер химического анализа","pay":"paid","cert":"000147"},{"fio":"Лукманов Константин Владимирович","org":"АО \"Майкаинзолото\"","pos":"Инженер-металлург","pay":"paid","cert":"000148"},{"fio":"Оразалиева Нургуль Донесовна","org":"ТОО Аналитик-Аф (физ лицо)","pos":"Главный специалист","pay":"wait","cert":"000149"},{"fio":"Поважная Наталья Николаевна","org":"ТОО \"ВСАМ Продакшн\"","pos":"инженер химик","pay":"paid","cert":"000150"},{"fio":"Қонарбай Айғаным Қайыржанқызы","org":"ТОО\"Khan Tau Minerals\"","pos":"инженер-химик","pay":"paid","cert":"000151"}],"issued":false,"note":""},{"title":"ICP-OES","client":"NordGold (АО ФИК Алель)","dates_text":"15-26 июня","hours":80,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["ICP-OES"],"status":"held","participants":[],"issued":false,"note":""},{"title":"XRD","client":"NCOC","dates_text":"29 июня - 3 июля","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["XRD"],"status":"held","participants":[],"issued":false,"note":""},{"title":"MP-AES","client":"NCOC","dates_text":"6-10 июля","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["MP-AES"],"status":"held","participants":[],"issued":false,"note":""},{"title":"AAS","client":"Шугыла Кент","dates_text":"13-17 июля","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[],"issued":false,"note":""},{"title":"ICP-OES (выезд, Алматы)","client":"НЦЭЛС","dates_text":"24 августа - 4 сентября","hours":80,"level":"basic","place":"Выездное обучение, Алматы","method":["ICP-OES"],"status":"held","participants":[],"issued":false,"note":""},{"title":"AAS, 2-я группа","client":"АлтынАлмас","dates_text":"7-11 сентября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[],"issued":false,"note":""},{"title":"AAS","client":"ТОО \"Khan Tau Minerals\"","dates_text":"14-18 сентября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[],"issued":false,"note":""},{"title":"GC","client":"","dates_text":"14-18 сентября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["GC"],"status":"held","participants":[],"issued":false,"note":""},{"title":"HPLC + GC","client":"СКГУ им. Козыбаева","dates_text":"21 сентября - 02 октября","hours":80,"level":"complex","place":"г. Астана, ул. Ж. Тархана, 6","method":["HPLC","GC"],"status":"held","participants":[],"issued":false,"note":""},{"title":"GC","client":"Бану Каримбердиевна (физ лицо)","dates_text":"28 сентября - 02 октября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["GC"],"status":"held","participants":[],"issued":false,"note":""},{"title":"ICP-OES","client":"КазМинералс Актогай","dates_text":"5-7 октября (1 группа - 2 чел),\n19-21 октября (2 группа - 2 чел)","hours":104,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["ICP-OES"],"status":"held","participants":[],"issued":false,"note":""},{"title":"AAS","client":"RG Processing","dates_text":"19-23 октября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[],"issued":false,"note":""},{"title":"Комплексный (ICP, AAS, XRD, XRF, TSG) 1 группа","client":"АлтынАлмас геологи","dates_text":"27-30 октября","hours":32,"level":"complex","place":"г. Астана, ул. Ж. Тархана, 6","method":["ICP-OES","AAS","XRF","XRD","ReveNIR"],"status":"held","participants":[],"issued":false,"note":""},{"title":"Комплексный (ICP, AAS, XRD, XRF, TSG) 2 группа","client":"АлтынАлмас геологи","dates_text":"2-5 ноября","hours":32,"level":"complex","place":"г. Астана, ул. Ж. Тархана, 6","method":["ICP-OES","AAS","XRF","XRD","ReveNIR"],"status":"plan","participants":[],"issued":false,"note":""},{"title":"AAS","client":"Жана Лаб","dates_text":"9-13 ноября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"lead","participants":[],"issued":false,"note":""},{"title":"HPLC","client":"БМЦ УДП РК (Центр ядерной медицины)","dates_text":"9-13 ноября","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["HPLC"],"status":"plan","participants":[],"issued":false,"note":""},{"title":"GC OpenLab Workstation, 2 группа (выезд)","client":"ТШО","dates_text":"19-23 ноября","hours":24,"level":"basic","place":"Выездное обучение на площадке заказчика","method":["GC"],"status":"plan","participants":[],"issued":false,"note":""},{"title":"ICP-OES","client":"Жана Лаб","dates_text":"23-30 ноября","hours":48,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["ICP-OES"],"status":"lead","participants":[],"issued":false,"note":""},{"title":"Пробоподготовка","client":"Жана Лаб","dates_text":"1-8 декабря\n14-31 декабря","hours":184,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":[],"status":"lead","participants":[],"issued":false,"note":""},{"title":"XRF (выезд)","client":"КазМинералс Актогай","dates_text":"9-11 декабря","hours":24,"level":"basic","place":"Выездное обучение на площадке заказчика","method":["XRF"],"status":"plan","participants":[],"issued":false,"note":""},{"title":"GC-MS (выезд)","client":"NCOC","dates_text":"10-19 декабря","hours":56,"level":"basic","place":"Выездное обучение на площадке заказчика","method":["GC"],"status":"plan","participants":[],"issued":false,"note":""},{"title":"Комплексный","client":"STS проект","dates_text":"2026 год","hours":0,"level":"complex","place":"г. Астана, ул. Ж. Тархана, 6","method":[],"status":"plan","participants":[],"issued":false,"note":""},{"title":"AAS","client":"","dates_text":"2027 год","hours":0,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"plan","participants":[],"issued":false,"note":""},{"title":"ICP-MS","client":"КДЛ Олимп","dates_text":"2027 год","hours":0,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["ICP-MS"],"status":"lead","participants":[],"issued":false,"note":""},{"title":"AAS + XRF","client":"Физ лицо (Толганай, НУ)","dates_text":"9-12 февраля","hours":32,"level":"complex","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS","XRF"],"status":"held","participants":[{"fio":"Әндіжанова Толғанай Мерекеқызы","org":"Nazabayev University","pos":"PhD srudent","pay":"paid","cert":""}],"issued":false,"note":""},{"title":"AAS","client":"4324","dates_text":"16-20 февраля","hours":40,"level":"basic","place":"г. Астана, ул. Ж. Тархана, 6","method":["AAS"],"status":"held","participants":[{"fio":"Мухамеджанов Асет Ерболович","org":"ТОО \"Alex lab\"","pos":"Инженер-химик","pay":"paid","cert":"000173"},{"fio":"Рамазанов Әліби Есболұлы","org":"ТОО \"Alex lab\"","pos":"Инженер-химик","pay":"paid","cert":"000174"},{"fio":"Равна Венера Забиравна","org":"ТОО КЭМП-Восток","pos":"Начальник лаборатории","pay":"paid","cert":"000175"},{"fio":"Федорова Евгения","org":"ТОО КЭМП-Восток","pos":"Инженер-химик","pay":"paid","cert":"000176"},{"fio":"Сатыбалдиев Еламан Мауленұлы","org":"ТОО “ВСАМ Продакшн”","pos":"Инженер-химик","pay":"paid","cert":"000177"}],"issued":false,"note":"1. **Контроль системы ввода пробы.** Ежедневно проверять состояние перистальтических шлангов, распылителя и горелки; шланги менять не реже 1 раза в 2–4 недели при интенсивной работе;\n1. **Контроль качества результатов.** В каждой серии анализировать бланк, проверочный стандарт (ICV/CCV) и контрольный образец; при отклонении более ±10 % от аттестованного значения повторять градуировку;\n1. **Чистота реактивов.** Использовать кислоты квалификации не ниже ос.ч. и воду 1 класса (ISO 3696); посуду выдерживать в 5–10 % HNO₃;\n1. **Газы.** Аргон чистотой не ниже 99,996 %; для ААС — ацетилен с контролем давления в баллоне не ниже 0,7 МПа;\n1. **Профилактика.** Проводить плановое ТО не реже 1 раза в год с участием сервисного инженера."},{"title":"HPLC-MS/MS (выезд, Алматы)","client":"НЦЭЛС","dates_text":"15-26 июня","hours":40,"level":"basic","place":"Выездное обучение, Алматы","method":["HPLC"],"status":"held","participants":[],"issued":false,"note":""}];
let _seeded = null;
async function ensureSeed() {
  if (_seeded) return _seeded;
  _seeded = (async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ticketsmodule_tc_trainings');
      if (rows[0].n > 0) return;
      for (const t of SEED) {
        await pool.query(
          `INSERT INTO ticketsmodule_tc_trainings
             (title, client, dates_text, hours, level, place, method, status, participants, issued, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [t.title, t.client, t.dates_text, t.hours || 0, t.level, t.place,
           JSON.stringify(t.method || []), STATUSES.includes(t.status) ? t.status : 'plan',
           JSON.stringify(t.participants || []), !!t.issued, t.note || '', 'seed']
        );
      }
      console.log(`✅ ТЦ: посев курсов — ${SEED.length} записей`);
    } catch (e) { console.error('ТЦ seed error:', e.message); _seeded = null; }
  })();
  return _seeded;
}

// Нормализация тела запроса в поля курса.
function norm(b) {
  const arr = v => Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
  return {
    title: String(b.title || '').trim().slice(0, 500),
    client: String(b.client || '').trim().slice(0, 300),
    dates_text: String(b.dates_text || '').trim().slice(0, 200),
    hours: Number.isFinite(+b.hours) ? Math.max(0, Math.round(+b.hours)) : 0,
    level: String(b.level || '').trim().slice(0, 40),
    place: String(b.place || '').trim().slice(0, 400),
    method: arr(b.method),
    status: STATUSES.includes(b.status) ? b.status : 'plan',
    participants: Array.isArray(b.participants) ? b.participants : [],
    issued: !!b.issued,
    note: String(b.note || '').trim().slice(0, 4000),
  };
}

// GET /api/tc/trainings — список курсов + флаг прав на правку.
router.get('/trainings', requireModuleApi('TC'), async (req, res) => {
  try {
    await ensureSeed();
    const { rows } = await pool.query('SELECT * FROM ticketsmodule_tc_trainings ORDER BY id DESC');
    const canEdit = isAdminLike(req.user.role) || WRITE.includes(req.user.role);
    res.json({ ok: true, canEdit, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/tc/trainings — создать курс.
router.post('/trainings', requireAuth(WRITE), express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const t = norm(req.body || {});
    if (!t.title) return res.status(400).json({ ok: false, error: 'Укажите название курса' });
    const by = (req.user.display_name || req.user.username || '').slice(0, 100);
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_tc_trainings
         (title, client, dates_text, hours, level, place, method, status, participants, issued, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [t.title, t.client, t.dates_text, t.hours, t.level, t.place, JSON.stringify(t.method),
       t.status, JSON.stringify(t.participants), t.issued, t.note, by]
    );
    res.json({ ok: true, item: rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/tc/trainings/:id — обновить курс.
router.put('/trainings/:id(\\d+)', requireAuth(WRITE), express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const t = norm(req.body || {});
    if (!t.title) return res.status(400).json({ ok: false, error: 'Укажите название курса' });
    const { rows } = await pool.query(
      `UPDATE ticketsmodule_tc_trainings SET
         title=$1, client=$2, dates_text=$3, hours=$4, level=$5, place=$6, method=$7,
         status=$8, participants=$9, issued=$10, note=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [t.title, t.client, t.dates_text, t.hours, t.level, t.place, JSON.stringify(t.method),
       t.status, JSON.stringify(t.participants), t.issued, t.note, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Курс не найден' });
    res.json({ ok: true, item: rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/tc/trainings/:id — удалить курс (только admin).
router.delete('/trainings/:id(\\d+)', requireAuth(['admin']), async (req, res) => {
  try {
    await pool.query('DELETE FROM ticketsmodule_tc_trainings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };
