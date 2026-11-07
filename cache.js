// Лёгкий in-process TTL-кэш для тяжёлых дашборд-чтений. Снижает egress Supabase и
// ускоряет отклик: когда несколько пользователей открывают один дашборд в одно окно,
// Postgres читается ОДИН раз, остальные получают готовый результат из памяти.
// Ключевая деталь — дедуп параллельных промахов (pending): при холодном кэше и 10
// одновременных запросах выполняется один загрузчик, остальные ждут тот же промис.
const store = new Map(); // key -> { exp:number, val:any, pending:Promise|null }

async function memo(key, ttlMs, loader) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit) {
    if (hit.val !== undefined && hit.exp > now) return hit.val; // свежий результат
    if (hit.pending) return hit.pending;                        // уже грузится — ждём
  }
  const p = Promise.resolve().then(loader);
  store.set(key, { exp: 0, val: undefined, pending: p });
  try {
    const val = await p;
    store.set(key, { exp: Date.now() + ttlMs, val, pending: null });
    return val;
  } catch (e) {
    store.delete(key); // ошибки не кэшируем
    throw e;
  }
}

// Сбросить все ключи с указанным префиксом (вызывать после синка, чтобы дашборды
// сразу показали свежие данные, не дожидаясь истечения TTL).
function bust(prefix) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

module.exports = { memo, bust };
