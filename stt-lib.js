// Распознавание речи (Speech-to-Text) для голосовых сообщений мессенджера.
// По умолчанию — OpenAI Whisper (хорошо понимает русский), но провайдер
// настраивается через окружение (любой OpenAI-совместимый endpoint):
//   OPENAI_API_KEY (или STT_API_KEY)  — ключ (обязательно, иначе распознавание выключено)
//   STT_URL    — endpoint (по умолчанию https://api.openai.com/v1/audio/transcriptions)
//   STT_MODEL  — модель (по умолчанию whisper-1)
//   STT_LANG   — подсказка языка (по умолчанию ru)
// Если ключ не задан — функция возвращает null, приложение не падает, голосовое
// просто остаётся аудио без расшифровки.
const KEY = process.env.OPENAI_API_KEY || process.env.STT_API_KEY || '';
const URL = process.env.STT_URL || 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = process.env.STT_MODEL || 'whisper-1';
const LANG = process.env.STT_LANG || 'ru';

function configured() { return !!KEY; }

// Расшифровать аудио. buffer — Buffer с аудио, mimetype — тип (audio/webm и т.п.),
// filename — имя (важно расширение: whisper определяет формат по нему).
async function transcribe(buffer, mimetype, filename) {
  if (!configured()) return null;
  if (!buffer || !buffer.length) return null;
  try {
    const type = mimetype || 'audio/webm';
    let name = filename || 'voice.webm';
    // Гарантируем расширение в имени (whisper требует узнаваемый формат).
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') || type.includes('m4a') ? 'm4a'
        : type.includes('mpeg') || type.includes('mp3') ? 'mp3' : type.includes('wav') ? 'wav' : 'webm';
      name = name + '.' + ext;
    }
    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), name);
    form.append('model', MODEL);
    if (LANG) form.append('language', LANG);
    const r = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: form });
    if (!r.ok) { console.error('STT error', r.status, (await r.text().catch(() => '')).slice(0, 200)); return null; }
    const d = await r.json().catch(() => null);
    const text = d && d.text ? String(d.text).trim() : '';
    return text || null;
  } catch (e) { console.error('STT exception:', e.message); return null; }
}

module.exports = { configured, transcribe };
