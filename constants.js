/**
 * Shared constants and lookup dictionaries
 * Single source of truth — edit here, used everywhere
 */

const USERS = {
  1:'Администратор',4:'Куаныш Есенов',7:'Мирас Актайлаков',8:'Рустам Абылкасимов',
  9:'Мурат Булегенов',10:'Асылбек Ожикен',11:'Гаухар Ахметжан',12:'Айжан Байжигитова',
  13:'Назерке Марат',14:'Канат Жунусов',15:'Семен Жаров',16:'Дамели Садырова',
  18:'Александр Якунин',19:'Ерлан Адильбеков',20:'Айнур Разакова',21:'Жадыра Сагитова',
  22:'Данияр Орахбаев',23:'Бахытгуль Даут',24:'Шокан Рымбек',25:'Рауан Жаксылык',
  26:'Азамат Аннабаев',27:'Маржан Доскенова',28:'Айнур Карпсеитова',29:'Борис Егоров',
  31:'Куаныш Нурмаганбетов',32:'Акерке Шотанова',33:'Аннель Лекер',34:'Гульнур Касымханова',
  36:'Аруна Болатова',37:'Акгулим Самиголлаева',38:'Талант Амангелді',39:'Мансұр Сейтжанұлы',
  40:'Каха Чоговадзе',41:'Наталья Зенченко',44:'Бақытжан Шаймұрат',45:'Азат Манат',
  46:'Жандос Кунаев',47:'Дмитрий Сорокин',48:'Дарын Негметжанов',50:'Нурбек Ибраемов',
  55:'Нурхат Оразгалиев',67:'Айнель Сеитова',68:'Игорь Бодров',71:'Азамат Алиев',
  73:'Ерасыл Махаш',76:'Аскат Көбей',77:'Адиль Тасмагамбетов',78:'Дмитрий Волков',
  79:'Арман Манаспаев',85:'Максим Мазняк',86:'Аманжол Сыздыков',88:'Асем Жарылгап',90:'Ерқанат Сырғабек',
};

const USER_EMAILS = {
  4:'kuanysh.e@prolabsupport.kz',7:'miras.a@prolabsupport.kz',8:'rustam.a@prolabsupport.kz',
  9:'murat.b@prolabsupport.kz',10:'assylbek.o@prolabsupport.kz',11:'gauhar.a@prolabsupport.kz',
  12:'aizhan.b@prolabsupport.kz',13:'nazerke.m@prolabsupport.kz',14:'kanat.zh@prolabsupport.kz',
  15:'semen.zh@prolabsupport.kz',16:'dameli.s@prolabsupport.kz',18:'alexandr.y@prolabsupport.kz',
  19:'yerlan.a@prolabsupport.kz',20:'ainur.r@prolabsupport.kz',21:'zhadyra.s@prolabsupport.kz',
  22:'daniyar.o@prolabsupport.kz',23:'bakhytgul.d@prolabsupport.kz',24:'shokan.r@prolabsupport.kz',
  25:'rauan.zh@prolabsupport.kz',26:'azamat.a@prolabsupport.kz',27:'marzhan.d@prolabsupport.kz',
  28:'project@prolabsupport.kz',29:'boris.e@prolabsupport.kz',31:'techsupport@prolabsupport.kz',
  32:'akerke.sh@prolabsupport.kz',33:'annel.l@prolabsupport.kz',34:'gulnur.k@prolabsupport.kz',
  36:'aruna.b@prolabsupport.kz',37:'akgulim.s@prolabsupport.kz',38:'talant.a@prolabsupport.kz',
  39:'mansur.s@prolabsupport.kz',40:'kakha.ch@prolabsupport.kz',41:'accountant@prolabsupport.kz',
  44:'bakytzhan.sh@prolabsupport.kz',45:'azat.m@prolabsupport.kz',46:'zhandos.k@prolabsupport.kz',
  47:'dmitry.s@prolabsupport.kz',48:'daryn.n@prolabsupport.kz',50:'nurbek.i@prolabsupport.kz',
  55:'nurkhat.o@prolabsupport.kz',67:'ainel.s@prolabsupport.kz',68:'igor.b@prolabsupport.kz',
  71:'azamat.ali@prolabsupport.kz',73:'yerassyl.m@prolabsupport.kz',76:'askhat.k@prolabsupport.kz',
  77:'adil.t@prolabsupport.kz',78:'dmitriy.v@prolabsupport.kz',79:'arman.man@prolabsupport.kz',
  85:'maxim.m@prolabsupport.kz',86:'amanzhol.s@prolabsupport.kz',88:'assem.zh@prolabsupport.kz',
  90:'yerkanat.s@prolabsupport.kz',
};

const SERVICE_TYPES = {
  '103':'Установка','104':'Техническое обслуживание','105':'Диагностика',
  '106':'Ремонт','108':'Обучение','109':'Обучение ТЦ','110':'Квалификация (IQ/OQ/PQ)',
  '111':'Подбор доп. оборудования','114':'Другое','402':'Подготовка документов','619':'Заявка клиента',
};

const COORDINATORS = new Set([26, 79]);

// Роли (правка = редактирование заявок/сделок, удаление всегда с логом):
//  admin      — всё; удаление в любом модуле.
//  manager    — правит любые; удаляет только в своём модуле «Реализация».
//  logist     — правит любые; удаляет только в своём модуле «Логистика».
//  coordinator— правит любые; удаляет только в своих «Планировщик»/«Сервисные заявки».
//  engineer(=sales) — правит только «свои» (где он ответственный); не удаляет.
//  store      — правит любые закупки в модуле «Закупки» (кроме удаления);
//               остальные выданные модули — только просмотр.
//  viewer     — только просмотр выданных модулей.
const VALID_ROLES = new Set(['admin', 'manager', 'logist', 'coordinator', 'engineer', 'store', 'accountant', 'viewer']);

// ── Гидратация справочника сотрудников из Bitrix (глобально для ВСЕХ модулей) ──
// Статический USERS выше — курируемый минимум; сотрудники с новыми ID (49, 66, 92…)
// в нём отсутствовали и показывались как «#49». Здесь один раз при старте сервера
// дозагружаем полный список из user.get и ДОПИСЫВАЕМ недостающие имена прямо в тот
// же объект USERS. Так как все модули импортируют одну и ту же ссылку, обновление
// подхватывается везде (Логистика, Контракты, Реализация и т.д.). Курируемые имена
// не перетираем. Best-effort: при ошибке остаётся статический справочник.
let _hydrated = false;
async function hydrateUsers() {
  if (_hydrated) return 0;
  const { b24 } = require('./bitrix');
  let added = 0;
  const ingest = arr => {
    for (const u of (arr || [])) {
      const id = String(u.ID);
      if (!USER_EMAILS[id] && u.EMAIL && /@/.test(u.EMAIL)) USER_EMAILS[id] = String(u.EMAIL).trim();
      if (USERS[id]) continue; // курируемое имя не трогаем
      USERS[id] = [u.LAST_NAME, u.NAME].filter(Boolean).join(' ').trim() || u.EMAIL || ('#' + id);
      added++;
    }
  };
  // Два прохода: активные + УВОЛЕННЫЕ/деактивированные (их сделки остаются в базе,
  // иначе бывший менеджер показывается как «#72»).
  const passes = [{ ADMIN_MODE: 'Y' }, { ADMIN_MODE: 'Y', ACTIVE: false, FILTER: { ACTIVE: false } }];
  try {
    for (const extra of passes) {
      let start = 0, guard = 0;
      while (guard++ < 60) {
        const res = await b24('user.get', Object.assign({ start }, extra));
        ingest(res && res.result);
        const next = res && res.next;
        if (next === undefined || next === null) break;
        start = next;
      }
    }
    _hydrated = true;
    if (added) console.log(`USERS: дозагружено сотрудников из Bitrix (вкл. уволенных) — ${added} (всего ${Object.keys(USERS).length})`);
  } catch (e) {
    console.error('hydrateUsers error:', e.message);
  }
  return added;
}

module.exports = { USERS, USER_EMAILS, SERVICE_TYPES, COORDINATORS, VALID_ROLES, hydrateUsers };
