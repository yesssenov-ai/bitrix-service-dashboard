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

const VALID_ROLES = new Set(['admin', 'coordinator', 'engineer', 'viewer']);

module.exports = { USERS, USER_EMAILS, SERVICE_TYPES, COORDINATORS, VALID_ROLES };
