/* cup-mobile.js — мобильный app-shell ЦУП (модель Analytical Network Control Panel).
   Нижняя навигация с именованными вкладками (без FAB) + полноэкранный экран
   «Все разделы» (поиск + модули по секциям). Подставляется сервером на все
   страницы дизайн-системы; виден только ≤640px. Строгие line-иконки, один акцент. */
(function () {
  if (window.__cupMobile) return; window.__cupMobile = 1;

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function clickId(id){ var e=document.getElementById(id); if(e){e.click();return true;} return false; }
  function go(h){ location.href=h; }
  function openSearch(){ if(!clickId('pls-sr-btn')) go('/portal.html'); }

  var NAV = {
    home:'<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    tasks:'<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    grid:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    close:'<path d="M6 6l12 12M18 6L6 18"/>'
  };
  function nsvg(n){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">'+NAV[n]+'</svg>'; }

  // ── Каталог модулей (снято с портала) ───────────────────────────────────────
  var MODULES = [
    {c:'PLN',n:'Планировщик',h:'/planner.html',g:'service'},
    {c:'SVC',n:'Сервисные заявки',h:'/index.html',g:'service'},
    {c:'EQP',n:'Карта оборудования',h:'/equipment-map.html',g:'service'},
    {c:'LIC',n:'Карта лицензий ГМК',h:'/licenses-map.html',g:'sales'},
    {c:'REL',n:'Связи сделок',h:'/relations.html',g:'sales'},
    {c:'MAIL',n:'Почта',h:'/mail.html',g:'analytics'},
    {c:'KP',n:'Коммерческие предложения',h:'/kp-hub.html',g:'sales'},
    {c:'BONUS',n:'Бонусы инженеров',h:'/bonus.html',g:'service'},
    {c:'STATS',n:'Статистика',h:'/stats.html',g:'analytics'},
    {c:'CONTR',n:'Контракты',h:'/contracts.html',g:'finance'},
    {c:'DEBT',n:'Дебет',h:'/finance-debt.html',g:'finance'},
    {c:'STOCK',n:'Склад',h:'/finance-stock.html',g:'supply'},
    {c:'QUALITY',n:'Качество',h:'/finance-quality.html',g:'finance'},
    {c:'ADV',n:'Авансы',h:'/finance-advances.html',g:'finance'},
    {c:'CASHFLOW',n:'Cash Flow',h:'/finance-cashflow.html',g:'finance'},
    {c:'CMP',n:'Компании',h:'/companies.html',g:'sales'},
    {c:'SALE',n:'План продаж',h:'/plansales.html',g:'sales'},
    {c:'NKT',n:'НКТ',h:'/nct.html',g:'supply'},
    {c:'PROJ',n:'Проекты КАМ',h:'/projects.html',g:'sales'},
    {c:'LOG',n:'Логистика',h:'/logistics.html',g:'supply'},
    {c:'OPS',n:'Реализация',h:'/operational.html',g:'supply'},
    {c:'PROC',n:'Закупки',h:'/procurement.html',g:'supply'},
    {c:'CAM',n:'Рассылки',h:'/campaigns.html',g:'analytics'},
    {c:'TC',n:'Курсы ТЦ',h:'/tc.html#training',g:'lab'},
    {c:'TC_WK',n:'Исследования',h:'/tc.html#works',g:'lab'},
    {c:'TC_EQ',n:'Приборы лаборатории',h:'/tc.html#equipment',g:'lab'},
    {c:'TC_ST',n:'Склад лаборатории',h:'/tc.html#stock',g:'lab'},
    {c:'TC_QM',n:'СМК (ISO 17025)',h:'/tc.html#qms',g:'lab'},
    {c:'TC_AN',n:'Аналитика ТЦ',h:'/tc.html#analytics',g:'lab'},
    {c:'ADM',n:'Управление',h:'/admin.html',g:'system'}
  ];
  var CATS = [
    {id:'sales',name:'Продажи и клиенты',c:'#2f6ad9'},
    {id:'service',name:'Сервис и инженеры',c:'#13a08a'},
    {id:'supply',name:'Поставки и склад',c:'#d98a12'},
    {id:'finance',name:'Финансы',c:'#C53B2F'},
    {id:'analytics',name:'Аналитика и связь',c:'#7a5cd0'},
    {id:'lab',name:'Лаборатория и ТЦ',c:'#1a7f54'},
    {id:'system',name:'Система',c:'#6a7488'}
  ];
  var CICON = {
    sales:'<path d="M3 17l5-5 4 4 8-8"/><path d="M16 4h4v4"/>',
    service:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2 2.3-2.3z"/>',
    supply:'<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    finance:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    analytics:'<path d="M12 3a9 9 0 1 0 9 9h-9V3z"/><path d="M14 3.5A9 9 0 0 1 20.5 10H14V3.5z"/>',
    lab:'<path d="M9 3h6M10 3v6l-4.5 8a1.5 1.5 0 0 0 1.3 2.2h10.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9"/>',
    system:'<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5c.1-.3.1-.6.1-1z"/>'
  };
  function cicon(g){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(CICON[g]||CICON.system)+'</svg>'; }
  // Уникальная иконка под каждый модуль (как в AN). Фолбэк — иконка секции.
  var MICON = {
    PLN:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    SVC:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2 2.3-2.3z"/>',
    EQP:'<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    LIC:'<path d="M6 3h12v18l-6-4-6 4z"/>',
    REL:'<path d="M9 15l6-6"/><path d="M14 7l1-1a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M10 17l-1 1a3.5 3.5 0 0 1-5-5l1-1"/>',
    MAIL:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    KP:'<path d="M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h5"/>',
    BONUS:'<circle cx="12" cy="9" r="5"/><path d="M9 13.5L8 21l4-2 4 2-1-7.5"/>',
    STATS:'<path d="M4 4v16h16"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
    CONTR:'<path d="M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="M8.5 15l2 2 4-4"/>',
    DEBT:'<path d="M3 7a2 2 0 0 1 2-2h12v4"/><path d="M3 7v10a2 2 0 0 0 2 2h14V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="13.5" r="1.3"/>',
    STOCK:'<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    QUALITY:'<path d="M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>',
    ADV:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
    CASHFLOW:'<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    CMP:'<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
    SALE:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    NKT:'<path d="M4 5v14M7.5 5v14M11 5v14M13.5 5v10M17 5v14M20 5v14"/>',
    PROJ:'<circle cx="9" cy="8" r="3.2"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><path d="M16 5.6a3 3 0 0 1 0 5.4M18.5 20v-1a5 5 0 0 0-3-4.6"/>',
    LOG:'<rect x="2" y="6" width="13" height="10" rx="1"/><path d="M15 9h4l3 3v4h-7z"/><circle cx="6" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/>',
    OPS:'<path d="M4 4h16l-6 8v6l-4 2v-8z"/>',
    PROC:'<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M3 4h2l2.3 11a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L21 7H6"/>',
    CAM:'<path d="M3 11v2a1 1 0 0 0 1 1h2l9 5V5l-9 5H4a1 1 0 0 0-1 1z"/><path d="M18 9.5a3 3 0 0 1 0 5"/>',
    TC:'<path d="M12 5 2 9.5 12 14l10-4.5z"/><path d="M6 11.5V16c0 1.3 2.7 2.5 6 2.5s6-1.2 6-2.5v-4.5"/>',
    TC_WK:'<path d="M9 3h6M10 3v6l-4.5 8a1.5 1.5 0 0 0 1.3 2.2h10.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9"/>',
    TC_EQ:'<rect x="6" y="3" width="12" height="7" rx="1"/><path d="M9 10v8M15 10v8M6 18h12"/>',
    TC_ST:'<rect x="4" y="7" width="16" height="13" rx="1"/><path d="M4 11h16M9 7V4h6v3"/>',
    TC_QM:'<path d="M7 3h7l5 5v13H5V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    TC_AN:'<path d="M12 3a9 9 0 1 0 9 9h-9V3z"/><path d="M14 3.5A9 9 0 0 1 20.5 10H14V3.5z"/>',
    ADM:'<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2"/>'
  };
  function micon(code, g){ var p=MICON[code]||CICON[g]||CICON.system;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>'; }

  // ── Персонализация: «Часто» (топ модулей пользователя) ──────────────────────
  var TOP = null;
  function currentCode(){
    var p=(location.pathname||'').toLowerCase();
    var h=(location.hash||'').toLowerCase().replace(/^#/,'');
    var same=MODULES.filter(function(m){return m.h.split('#')[0].toLowerCase()===p;});
    if(!same.length) return null;
    if(same.length===1) return same[0].c;
    var byHash=same.filter(function(m){return (m.h.split('#')[1]||'').toLowerCase()===h;});
    return byHash.length ? byHash[0].c : same[0].c;
  }
  function track(){
    var c=currentCode(); if(!c) return;
    try{ fetch('/api/portal/track-module',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code:c})}).catch(function(){}); }catch(e){}
  }
  function loadTop(cb){
    try{ fetch('/api/portal/my-top-modules').then(function(r){return r.json();})
      .then(function(d){ TOP=(d&&d.items)||[]; if(cb)cb(); })
      .catch(function(){ TOP=TOP||[]; if(cb)cb(); }); }
    catch(e){ TOP=TOP||[]; if(cb)cb(); }
  }

  // Доступ: admin → всё; иначе — выданные коды; ADM только суперадмину.
  var ALLOWED = null, ROLE = '', NAME = '';
  var ROLE_RU = { superadmin:'Суперадмин', admin:'Администратор', coordinator:'Координатор',
    manager:'Менеджер', engineer:'Инженер', tc:'Тренинг-центр', viewer:'Просмотр',
    logist:'Логист', store:'Склад', accountant:'Бухгалтер', marketolog:'Маркетолог' };
  function loadAccess(cb){
    var done=0, acc=null, me=null;
    function fin(){ if(++done<2) return;
      var set=null;
      if(acc && acc.admin) set=null;                 // всё
      else set = new Set((acc && acc.modules)||[]);
      ALLOWED=set; ROLE=(me&&me.role)||''; NAME=(me&&(me.displayName||me.username))||''; cb(); }
    try{ fetch('/auth/me').then(function(r){return r.json();}).then(function(d){me=(d&&d.user)||{};fin();}).catch(fin); }catch(e){fin();}
    try{ fetch('/api/portal/my-access').then(function(r){return r.json();}).then(function(d){acc=d||{};fin();}).catch(fin); }catch(e){fin();}
  }
  function visibleModules(){
    return MODULES.filter(function(m){
      if(m.c==='ADM') return ROLE==='superadmin';
      if(ALLOWED===null) return true;               // admin
      return ALLOWED.has(m.c);
    });
  }

  // ── Экран «Все разделы» ──────────────────────────────────────────────────────
  var allov=null;
  function closeAll(){ if(allov){allov.remove();allov=null;} }
  function openAll(){
    var mods=visibleModules();
    closeAll();
    allov=document.createElement('div'); allov.className='cup-allov';
    var html='<div class="cup-allov-top"><div class="cup-allov-t">Все разделы</div>'+
      '<button class="cup-allov-x" aria-label="Закрыть">'+nsvg('close')+'</button></div>'+
      '<div class="cup-allov-srch"><span>'+nsvg('search')+'</span><input id="cupAllQ" placeholder="Найти раздел…" autocomplete="off"></div>'+
      '<div class="cup-allov-body" id="cupAllBody"></div>'+
      (NAME ? '<a class="cup-allov-user" href="/account.html"><span class="cup-allov-av">'+esc(NAME.slice(0,1).toUpperCase())+'</span>'+
        '<span class="cup-allov-un"><b>'+esc(NAME)+'</b><small>'+esc(ROLE_RU[ROLE]||ROLE||'')+'</small></span></a>' : '')+
      '<div class="cup-allov-foot">'+
        '<button data-a="acc">Кабинет</button>'+
        '<button data-a="ai">Ассистент</button>'+
        '<button data-a="help">Помощь</button>'+
        '<button data-a="fb">Связь</button>'+
      '</div>';
    allov.innerHTML=html;
    document.body.appendChild(allov);
    var foot=allov.querySelector('.cup-allov-foot');
    foot.addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b) return; var a=b.getAttribute('data-a');
      if(a==='acc'){ closeAll(); go('/account.html'); }
      else if(a==='ai'){ closeAll(); clickId('pai-fab'); }
      else if(a==='help'){ closeAll(); clickId('pls-help-btn'); }
      else if(a==='fb'){ closeAll(); clickId('pls-fb-btn'); } });
    function topSection(q){
      if(q || !TOP || !TOP.length) return '';
      var byCode={}; mods.forEach(function(m){byCode[m.c]=m;});
      var catc={}; CATS.forEach(function(x){catc[x.id]=x.c;});
      var list=TOP.map(function(c){return byCode[c];}).filter(Boolean).slice(0,6);
      if(list.length<2) return '';          // показываем, только когда реально есть что подтянуть
      return '<div class="cup-allsec cup-allsec-top"><div class="cup-allsec-h">Часто</div><div class="cup-allgrid">'+
        list.map(function(m){ var cc=catc[m.g]||'#6a7488';
          return '<a class="cup-alltile" href="'+m.h+'">'+
            '<span class="cup-alltile-i" style="color:'+cc+';background:color-mix(in srgb,'+cc+' 12%,var(--surface))">'+micon(m.c,m.g)+'</span>'+
            '<span class="cup-alltile-n">'+esc(m.n)+'</span></a>'; }).join('')+
        '</div></div>';
    }
    function render(q){
      q=(q||'').toLowerCase().trim();
      var body=document.getElementById('cupAllBody'); var out=topSection(q);
      CATS.forEach(function(cat){
        var list=mods.filter(function(m){return m.g===cat.id && (!q || m.n.toLowerCase().indexOf(q)>=0);});
        if(!list.length) return;
        out+='<div class="cup-allsec"><div class="cup-allsec-h">'+esc(cat.name)+'</div><div class="cup-allgrid">'+
          list.map(function(m){ return '<a class="cup-alltile" href="'+m.h+'">'+
            '<span class="cup-alltile-i" style="color:'+cat.c+';background:color-mix(in srgb,'+cat.c+' 12%,var(--surface))">'+micon(m.c,cat.id)+'</span>'+
            '<span class="cup-alltile-n">'+esc(m.n)+'</span></a>'; }).join('')+
          '</div></div>';
      });
      body.innerHTML = out || '<div class="cup-allov-empty">Ничего не найдено</div>';
    }
    render('');
    if(TOP===null) loadTop(function(){ if(allov){ var q=document.getElementById('cupAllQ'); render(q?q.value:''); } });
    allov.querySelector('.cup-allov-x').onclick=closeAll;
    var qi=document.getElementById('cupAllQ'); if(qi) qi.addEventListener('input',function(){render(qi.value);});
    allov.addEventListener('click',function(e){ if(e.target===allov) closeAll(); });
  }

  // ── Нижняя навигация ─────────────────────────────────────────────────────────
  var path=(location.pathname||'/').replace(/\/+$/,'')||'/';
  var isHome=(path===''||path==='/'||/\/portal\.html$/.test(path));
  var isTasks=/\/board\.html$/.test(path);
  var NAV_MORE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>';
  function build(){
    if(document.getElementById('cupMobNav')) return;
    var nav=document.createElement('nav'); nav.id='cupMobNav'; nav.className='cup-mobnav';
    function tab(svgHtml,label,active){ return '<a href="javascript:void(0)" class="'+(active?'on':'')+'">'+svgHtml+'<span>'+label+'</span></a>'; }
    nav.innerHTML =
      tab(nsvg('home'),'Главная',isHome)+
      tab(nsvg('tasks'),'Задачи',isTasks)+
      tab(nsvg('search'),'Поиск',false)+
      tab(NAV_MORE,'Ещё',false);
    document.body.appendChild(nav);
    var a=nav.querySelectorAll('a');
    a[0].onclick=function(){ go('/portal.html'); };
    a[1].onclick=function(){ go('/board.html'); };
    a[2].onclick=openSearch;
    a[3].onclick=openAll;
  }

  function start(){ loadAccess(function(){}); build(); track(); loadTop(); }
  if(document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
