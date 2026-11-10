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

  // Доступ: admin → всё; иначе — выданные коды; ADM только суперадмину.
  var ALLOWED = null, ROLE = '';
  function loadAccess(cb){
    var done=0, acc=null, me=null;
    function fin(){ if(++done<2) return;
      var isAdmin = me && (me.role==='admin'||me.role==='superadmin');
      var set=null;
      if(acc && acc.admin) set=null;                 // всё
      else set = new Set((acc && acc.modules)||[]);
      ALLOWED=set; ROLE=(me&&me.role)||''; cb(); }
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
    function render(q){
      q=(q||'').toLowerCase().trim();
      var body=document.getElementById('cupAllBody'); var out='';
      CATS.forEach(function(cat){
        var list=mods.filter(function(m){return m.g===cat.id && (!q || m.n.toLowerCase().indexOf(q)>=0);});
        if(!list.length) return;
        out+='<div class="cup-allsec"><div class="cup-allsec-h">'+esc(cat.name)+'</div><div class="cup-allgrid">'+
          list.map(function(m){ return '<a class="cup-alltile" href="'+m.h+'">'+
            '<span class="cup-alltile-i" style="color:'+cat.c+';background:color-mix(in srgb,'+cat.c+' 12%,var(--surface))">'+cicon(cat.id)+'</span>'+
            '<span class="cup-alltile-n">'+esc(m.n)+'</span></a>'; }).join('')+
          '</div></div>';
      });
      body.innerHTML = out || '<div class="cup-allov-empty">Ничего не найдено</div>';
    }
    render('');
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

  function start(){ loadAccess(function(){}); build(); }
  if(document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
