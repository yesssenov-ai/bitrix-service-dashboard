// cleanup-scan.js — показывает, какие файлы в проекте реально нужны, а какие
// можно убрать. НИЧЕГО НЕ УДАЛЯЕТ — только анализирует и печатает план.
// Запуск из корня репозитория:  node cleanup-scan.js
const fs=require('fs'), path=require('path');
const ROOT=process.cwd();
const SKIP_DIRS=['node_modules','.git','public','kp-template','_archive','scripts'];

function localRequires(file){
  let s; try{s=fs.readFileSync(file,'utf8');}catch(e){return[];}
  const out=[]; const re=/require\(\s*['"](\.[^'"]+)['"]\s*\)/g; let m;
  while((m=re.exec(s))) out.push(m[1]); return out;
}
function resolve(from,spec){
  const p=path.resolve(path.dirname(from),spec);
  for(const c of [p,p+'.js',p+'.json',path.join(p,'index.js')]){
    try{ if(fs.statSync(c).isFile()) return c; }catch(e){}
  } return null;
}
const entry=path.resolve(ROOT,'server.js');
const reach=new Set(), q=[entry];
while(q.length){ const f=q.shift(); if(reach.has(f))continue; reach.add(f);
  for(const s of localRequires(f)){ const r=resolve(f,s); if(r&&!reach.has(r)) q.push(r); } }

function walk(d,a){ for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if(SKIP_DIRS.includes(e.name)||e.name==='.git') continue;
  const full=path.join(d,e.name);
  if(e.isDirectory()) walk(full,a); else a.push(full);
} return a; }
const all=walk(ROOT,[]); const rel=f=>path.relative(ROOT,f).replace(/\\/g,'/');

// reachable JSONs (kept as runtime data)
const jsonUsed=new Set();
for(const f of reach){ for(const s of localRequires(f)){ const r=resolve(f,s); if(r&&r.endsWith('.json')) jsonUsed.add(rel(r)); } }
// also .json read via fs by reachable files (rough): scan reachable source for "<name>.json"
for(const f of reach){ let s=''; try{s=fs.readFileSync(f,'utf8');}catch(e){}
  for(const m of s.matchAll(/([\w.-]+\.json)/g)) jsonUsed.add(m[1]); }

const TOOL=/^(import|seed|sync|backfill|register|poll)-/;
const ONEOFF=/^(probe|discover|find|dump|diagnose|check|sample|verify|stats-discovery|list|fix|apply|build|bonus-setup)/;
const KNOWN_OK=new Set(['server.js','package.json','package-lock.json','.gitignore','.env.example','.npmrc','nixpacks.toml','README.md']);
const routeBases=new Set(all.filter(f=>rel(f).startsWith('routes/')&&f.endsWith('.js')).map(f=>path.basename(f)));

const core=[],tools=[],oneoff=[],junk=[],dup=[],jsonKeep=[],jsonOrphan=[],review=[];
for(const f of all){
  const r=rel(f), base=path.basename(f), ext=path.extname(f);
  if(reach.has(f)){ core.push(r); continue; }
  if(KNOWN_OK.has(r)) { core.push(r); continue; }
  if(ext==='.json'){ (jsonUsed.has(r)||jsonUsed.has(base)?jsonKeep:jsonOrphan).push(r); continue; }
  if(r.startsWith('routes/')) { core.push(r); continue; } // routes are loaded dynamically
  if(ext!=='.js'){ junk.push(r); continue; } // h, type, .patch, странные файлы без .js
  if(base==='.js'){ junk.push(r); continue; }
  if(!r.includes('/') && routeBases.has(base)) { dup.push(r+'   (дубликат routes/'+base+')'); continue; }
  if(TOOL.test(base)) tools.push(r);
  else if(ONEOFF.test(base)) oneoff.push(r);
  else review.push(r);
}
const p=(t,a)=>{ console.log('\n=== '+t+': '+a.length+' ==='); if(a.length) console.log(a.sort().join('\n')); };
console.log('ЯДРО (достижимо от server.js — НЕ трогать)');
p('Ядро',core);
p('МУСОР (удалять)',junk);
p('ДУБЛИКАТЫ (удалять)',dup);
p('ОДНОРАЗОВЫЕ скрипты (удалять)',oneoff);
p('ИНСТРУМЕНТЫ (оставить в корне — можешь запускать снова)',tools);
p('НА РЕВЬЮ (реши сам, по умолчанию оставь)',review);
p('JSON используемые (оставить)',jsonKeep);
p('JSON только для одноразовых скриптов (удалять)',jsonOrphan);
console.log('\n--- Готовая команда удаления (скопируй её целиком в CMD) ---');
const toRm=[...junk,...dup.map(d=>d.split('   ')[0]),...oneoff,...jsonOrphan];
if(toRm.length) console.log('git rm '+toRm.map(f=>'"'+f+'"').join(' '));
else console.log('(нечего удалять — уже чисто)');
console.log('\nИнструменты и «на ревью» НЕ трогаем: у них внутри относительные require, оставляем в корне.');
