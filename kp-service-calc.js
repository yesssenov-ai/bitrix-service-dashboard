// Логика подмодуля «КП · Сервис»: каталог-пресеты услуг, шаблон сопроводительного
// письма, конструктор КП (данные для DOCX) и таргетинг «кому предложить сервис».
const { pool } = require('./auth');
const { USERS, USER_EMAILS } = require('./constants');

// ── Стадии (как в других модулях) ────────────────────────────────────────────
const SOLD_STAGES = new Set([
  'FINAL_INVOICE', '1', 'UC_Q9J6VV', 'UC_9MBFR2', '2', '3', 'WON',
  'C1:FINAL_INVOICE', 'C1:1', 'C1:UC_3MVK90', 'C1:UC_3SCB5K', 'C1:2', 'C1:3', 'C1:WON',
  'C2:FINAL_INVOICE', 'C2:1', 'C2:2', 'C2:WON',
  'C3:FINAL_INVOICE', 'C3:UC_YYTFYG', 'C3:2', 'C3:WON',
]);
const WON_STAGES = new Set(['WON', 'C1:WON', 'C2:WON', 'C3:WON']);
const LOSTFROZEN = new Set(['LOSE', 'C1:LOSE', 'C2:LOSE', 'C3:LOSE', 'APOLOGY', 'C1:APOLOGY', 'C2:UC_IXKNOM', 'C3:UC_DWU581']);
const isSold = s => SOLD_STAGES.has(s);
const isWon = s => WON_STAGES.has(s);
const isDead = s => LOSTFROZEN.has(s);

// ── Пресеты услуг (единый шаблон, но с заготовками текста и цены; всё редактируется) ─
const SCOPE_TO = [
  'Проверка комплектности и технического состояния оборудования, включая основные механические, электрические, электронные и оптико-измерительные узлы.',
  'Проверка соответствия оборудования требованиям эксплуатации завода-изготовителя (условия размещения, электропитание, подключение вспомогательных систем, состояние ПО).',
  'Проведение регламентного технического обслуживания в соответствии с рекомендациями завода-изготовителя (очистка, смазка, проверка и настройка узлов, базовая настройка ПО).',
  'Предоставление письменных рекомендаций по дальнейшей эксплуатации и техническому обслуживанию, включая перечень рекомендуемых к замене запасных частей и расходных материалов.',
  'Замена запасных частей и расходных материалов (при необходимости и при наличии у Заказчика), без проведения капитального ремонта и модернизации.',
  'Консультация персонала Заказчика по корректной эксплуатации оборудования.',
];
const CONDITIONS_DEFAULT = 'Услуги оказываются Поставщиком по месту расположения прибора на предприятии Заказчика сертифицированными специалистами по данному прибору и оформляются Актом выполненных работ. Запланированный визит осуществляется на основании письменного запроса Заказчика в согласованные с Поставщиком даты. При обнаружении неисправности и отсутствии необходимых запчастей у Заказчика работы считаются выполненными.';

const PRESETS = [
  { key: 'to', name: 'Плановое ТО', title: 'Проведение технического обслуживания лабораторного оборудования', scope: SCOPE_TO, conditions: CONDITIONS_DEFAULT, volume: 'Услуга предполагает 1 плановый выезд.', price: 0 },
  { key: 'to2', name: 'ТО (2 выезда/год)', title: 'Проведение планового технического обслуживания лабораторного оборудования (2 визита в год)', scope: SCOPE_TO, conditions: CONDITIONS_DEFAULT, volume: 'Услуга предполагает 2 плановых выезда в течение года.', price: 0 },
  { key: 'calib', name: 'Поверка / калибровка', title: 'Проведение поверки/калибровки лабораторного оборудования', scope: [
    'Проверка метрологических характеристик оборудования.',
    'Калибровка/поверка в соответствии с методикой и рекомендациями завода-изготовителя.',
    'Оформление протокола и рекомендаций по эксплуатации.',
  ], conditions: CONDITIONS_DEFAULT, volume: 'Услуга предполагает 1 плановый выезд.', price: 0 },
  { key: 'repair', name: 'Ремонт / диагностика', title: 'Диагностика и ремонт лабораторного оборудования', scope: [
    'Диагностика технического состояния оборудования и выявление неисправностей.',
    'Ремонтные работы с заменой неисправных узлов (при наличии ЗИП).',
    'Проверка работоспособности после ремонта, рекомендации по эксплуатации.',
  ], conditions: CONDITIONS_DEFAULT, volume: 'Услуга предполагает 1 выезд специалиста.', price: 0 },
  { key: 'startup', name: 'Пусконаладка', title: 'Пусконаладочные работы и ввод оборудования в эксплуатацию', scope: [
    'Распаковка, установка и подключение оборудования.',
    'Пусконаладка и проверка соответствия заявленным характеристикам.',
    'Инструктаж персонала Заказчика по эксплуатации.',
  ], conditions: CONDITIONS_DEFAULT, volume: 'Услуга предполагает 1 выезд специалиста.', price: 0 },
];

// ── Шаблон сопроводительного письма (плейсхолдеры {name}, {equipment}, подпись — от пользователя) ─
function coverLetter({ greetingName, equipment, sender }) {
  const eq = equipment || 'оборудование';
  const s = sender || {};
  const sig = [s.name || '', s.title || 'Sales manager, ProLabSupport', 'Kazakhstan, Astana city, 55/22 Mangilik El ave, EXPO-2017', s.phone ? 'моб: ' + s.phone : '', 'www.prolabsupport.kz'].filter(Boolean).join('\n');
  return `Добрый день${greetingName ? ', ' + greetingName : ''}!

Благодарим Вас за предоставленную возможность представить компанию ProLabSupport.
Сегодня ProLabSupport — это не просто поставщик лабораторного оборудования, а экосистема решений для лабораторий и промышленных предприятий Казахстана и Центральной Азии: www.prolabsupport.kz

Мы помогаем клиентам выстраивать устойчивую и эффективную работу лабораторий — от подбора технологий и внедрения оборудования до сервисного сопровождения, обучения специалистов и прикладной методической поддержки.

Компания ProLabSupport является официальным дистрибьютором Agilent Technologies (США), Metrohm (Швейцария), Malvern Panalytical (Великобритания), Struers (Дания), LNI Swissgas (Швейцария) и ELGA LabWater (Великобритания) на территории Казахстана.

Направляю коммерческое предложение на техническое обслуживание ${eq}.

С уважением,
${sig}`;
}

// ── Данные текущего пользователя как «ответственного» ────────────────────────
function senderFor(user) {
  const bid = user && user.bitrix_user_id;
  return {
    name: (user && user.display_name) || (bid && USERS[bid]) || '',
    email: (bid && USER_EMAILS[bid]) || (user && user.email) || 'service@prolabsupport.kz',
    phone: '',
    title: 'Quality control and sales manager',
  };
}

const ymd = v => { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); };

// ── Таргетинг: кому предложить сервис ─────────────────────────────────────────
// Установочная база = проданные приборы (воронка «Приборы», sold-стадии). Для
// каждого клиента смотрим: гарантия, давность установки, наличие сервисных сделок.
async function serviceCandidates() {
  const { rows } = await pool.query(
    `SELECT deal_id, category_id, stage_id, company_id, company_name, deal_title,
            instrument_name, manufacturer, assigned_by_id,
            TO_CHAR(contract_date,'YYYY-MM-DD') AS contract_date,
            TO_CHAR(install_date,'YYYY-MM-DD')  AS install_date,
            TO_CHAR(warranty_end,'YYYY-MM-DD')  AS warranty_end,
            opportunity, currency_id
       FROM ticketsmodule_stat_deals`
  );
  // Индекс сервисных сделок (воронка 3) по компании: есть ли активная / любая.
  const svcByCompany = new Map(); // companyId -> {any:bool, active:bool, wonExpired:bool}
  rows.forEach(r => {
    if (r.category_id !== 3) return;
    const c = r.company_id || ('name:' + (r.company_name || ''));
    const e = svcByCompany.get(c) || { any: false, active: false };
    e.any = true;
    if (!isDead(r.stage_id) && !isWon(r.stage_id)) e.active = true;   // в работе/доконтрактная
    svcByCompany.set(c, e);
  });

  const today = new Date(); const todayMs = today.getTime();
  const WARN_DAYS = 90, OLD_DAYS = 365;
  const out = [];
  for (const r of rows) {
    if (r.category_id !== 0) continue;          // установочная база = воронка «Приборы»
    if (!isSold(r.stage_id)) continue;          // купили прибор (контракт и далее)
    const c = r.company_id || ('name:' + (r.company_name || ''));
    const svc = svcByCompany.get(c) || { any: false, active: false };
    const instDate = r.install_date || r.contract_date;
    const daysSinceInstall = instDate ? Math.floor((todayMs - new Date(instDate).getTime()) / 86400000) : null;
    const wEnd = r.warranty_end;
    const daysToWarrantyEnd = wEnd ? Math.floor((new Date(wEnd).getTime() - todayMs) / 86400000) : null;

    const flags = [];
    if (daysToWarrantyEnd != null && daysToWarrantyEnd >= -30 && daysToWarrantyEnd <= WARN_DAYS) flags.push('warranty');
    if (daysSinceInstall != null && daysSinceInstall > OLD_DAYS) flags.push('old');
    if (!svc.active) flags.push('no_active_service');
    if (!svc.any) flags.push('sold_not_serviced');
    if (svc.any && !svc.active) flags.push('service_expired');
    if (!flags.length) continue;                // показываем только кандидатов хотя бы с одним признаком

    // Приоритет: гарантия важнее всего, затем «продали-без-сервиса», давность.
    let score = 0;
    if (flags.includes('warranty')) score += 100 - (daysToWarrantyEnd || 0);
    if (flags.includes('sold_not_serviced')) score += 40;
    if (flags.includes('service_expired')) score += 30;
    if (flags.includes('no_active_service')) score += 20;
    if (flags.includes('old')) score += Math.min(30, Math.floor((daysSinceInstall || 0) / 365) * 10);

    out.push({
      dealId: r.deal_id,
      company: r.company_name || (r.company_id ? 'Компания #' + r.company_id : 'Без компании'),
      companyId: r.company_id || null,
      instrument: r.instrument_name || r.deal_title || '',
      manufacturer: r.manufacturer || '',
      managerId: r.assigned_by_id || null,
      managerName: r.assigned_by_id ? (USERS[r.assigned_by_id] || ('#' + r.assigned_by_id)) : '—',
      installDate: instDate || null,
      warrantyEnd: wEnd || null,
      daysToWarrantyEnd, daysSinceInstall,
      flags, score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { PRESETS, coverLetter, senderFor, serviceCandidates };
