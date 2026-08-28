// НКТ — AI-помощник (разбор наименования, партномер, краткое имя, каз. перевод,
// подсказки ОКТРУ) + нормализация артикула для проверки дублей.
// LLM переиспользует ANTHROPIC_API_KEY + PLSAI_MODEL (как ProLab AI). Итоговые
// решения всегда за человеком — AI только предлагает.
const LLM_MODEL = process.env.PLSAI_MODEL || 'claude-3-5-haiku-latest';

async function llm(system, user, maxTokens = 700) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY не задан');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 40000);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: String(user || '').slice(0, 4000) }] }),
      signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const d = await r.json();
  if (!r.ok) throw new Error('LLM: ' + ((d && d.error && d.error.message) || r.status));
  return (d.content && d.content[0] && d.content[0].text) || '';
}
async function llmJson(system, user, maxTokens = 700) {
  const raw = await llm(system + '\n\nОтветь ТОЛЬКО валидным JSON, без пояснений и markdown.', user, maxTokens);
  const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  try { return JSON.parse(m ? m[0] : raw); } catch (_) { return null; }
}

// ── Нормализация артикула (правила §5, утверждено: убираем ЛЮБЫЕ разделители,
//    регистр вверх, ведущие нули СОХРАНЯЕМ) ─────────────────────────────────────
function normalizeArticle(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .replace(/[\s\-‐-―_.\/\\()\[\]{}:;,'"«»]+/g, '') // все разделители
    .trim();
}
// Технические варианты поиска (уровни §6.3): исходный, нормализованный, «корень»
// (буквенно-цифровое ядро), цифровая часть.
function articleVariants(s) {
  const raw = String(s || '').trim();
  const norm = normalizeArticle(raw);
  const digits = norm.replace(/[^0-9]/g, '');
  const alnumCore = norm.replace(/[^0-9A-ZА-Я]/gi, '');
  return { raw, norm, digits, alnumCore };
}
// Похожесть по «корню» для «возможного совпадения» (§7/§8): один из ключей входит
// в другой, либо расстояние в 1 символ.
function articleSimilar(aNorm, bNorm) {
  if (!aNorm || !bNorm) return false;
  if (aNorm === bNorm) return true;
  if (aNorm.length >= 5 && (aNorm.includes(bNorm) || bNorm.includes(aNorm))) return true;
  // расстояние Левенштейна <= 1 для длинных ключей
  if (Math.abs(aNorm.length - bNorm.length) <= 1 && aNorm.length >= 5) return lev1(aNorm, bNorm);
  return false;
}
function lev1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

// ── AI: первичный разбор наименования ───────────────────────────────────────────
async function parseName(fullName) {
  const system = 'Ты — эксперт по аналитическому лабораторному оборудованию. Разбери полное русское наименование товара на смысловые элементы. Это ПРЕДВАРИТЕЛЬНЫЙ разбор, не окончательный. Не выдумывай данные, которых нет в тексте; неизвестное оставляй null или пустым.';
  const user = `Наименование: "${fullName}"\n\nВерни JSON:\n{"type":"общий тип товара","purpose":"назначение","brand":"бренд","manufacturer":"производитель","series":"серия","model":"модель","characteristics":["ключевые характеристики"],"role":"одно из: готовый прибор|лабораторная система|модуль|блок|запасная часть|комплектующее|расходный материал|аксессуар|комплект|реагент|ПО|неизвестно","partCandidates":[{"value":"фрагмент","role":"партномер|модель|серия|номер исполнения|часть описания|другое","why":"кратко почему"}]}\nВ partCandidates перечисли ВСЕ буквенно-цифровые фрагменты, похожие на идентификаторы, и предположи роль каждого, НЕ решая окончательно, что это партномер.`;
  return await llmJson(system, user, 800);
}

// ── AI: краткое русское наименование ────────────────────────────────────────────
async function shortNameRu(fullName, elements) {
  const system = 'Ты формируешь КРАТКОЕ русское наименование товара для каталога. Сохрани существенные идентификаторы: тип, бренд, модель/серию, главную отличительную характеристику, партномер (если есть). Не добавляй лишнего. Верни только строку.';
  const user = `Полное наименование: "${fullName}"\nРазбор: ${JSON.stringify(elements || {}).slice(0, 1200)}\n\nВерни JSON: {"shortNameRu":"..."}`;
  const j = await llmJson(system, user, 300);
  return (j && j.shortNameRu) || '';
}

// ── AI: перевод на казахский (технический; бренд/модель/партномер не менять) ─────
async function translateKk(textRu) {
  const system = 'Ты переводишь техническое наименование лабораторного оборудования с русского на казахский. НЕ переводи и не изменяй: бренд, производителя, модель, серию, партномер, буквенно-цифровые обозначения, технические коды — оставляй как есть. Переводи только смысловую часть. Верни только перевод.';
  const j = await llmJson(system, `Русский: "${textRu}"\n\nВерни JSON: {"nameKk":"..."}`, 300);
  return (j && j.nameKk) || '';
}

// ── AI: подсказки ОКТРУ по контексту + верхним узлам дерева ──────────────────────
async function suggestOktru(ctx, rootHints) {
  const system = 'Ты помогаешь подобрать категорию ОКТРУ для товара в Национальном каталоге Казахстана. Ты НЕ назначаешь категорию окончательно — предлагаешь варианты с объяснением, решение принимает человек. Опирайся на роль товара, назначение, принцип работы, самостоятельность. Не выдумывай коды ОКТРУ, которых нет в переданном списке верхних категорий; если не уверен — предложи ветку по названию и пометь как требующую ручной проверки.';
  const user = `Контекст товара: ${JSON.stringify(ctx || {}).slice(0, 1500)}\nВерхние категории ОКТРУ (code — название): ${JSON.stringify(rootHints || []).slice(0, 2500)}\n\nВерни JSON:\n{"questions":[{"key":"role|purpose|principle|standalone|belongs|measures|free","text":"один самый полезный уточняющий вопрос","options":["варианты ответа"]}],"suggestions":[{"rootCode":"код верхней категории из списка","name":"название","why":"почему предложено","signals":["какие признаки использованы"],"uncertain":"что осталось неопределённым","confidence":"высокая|средняя|нужно уточнение","label":"рекомендуемый|альтернатива|для ручной проверки"}]}\nЗадай МИНИМУМ вопросов — только если без них нельзя выбрать ветку. Если из наименования всё ясно — questions пустой.`;
  return await llmJson(system, user, 900);
}

module.exports = { parseName, shortNameRu, translateKk, suggestOktru, normalizeArticle, articleVariants, articleSimilar };
