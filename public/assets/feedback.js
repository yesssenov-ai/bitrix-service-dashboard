/* Кнопка обратной связи «💬» на каждой странице ЦУП.
   Клик → модалка (Идея / Проблема + текст) → POST /api/feedback → спасибо.
   Самодостаточно, без зависимостей; тема берётся из cup-ui переменных (с фолбэками). */
(function () {
  'use strict';
  if (window.__plsFeedback) return; window.__plsFeedback = true;
  var V = '--surface:#fff;--text:#101624;--text-3:#6a7488;--line:#e7eaf0;--line-2:#d6dbe4;--accent:#C53B2F;--surface-2:#f1f3f6;--good:#1a7f54';
  function cssVar(n, d) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return v && v.trim() ? v.trim() : d; } catch (e) { return d; } }
  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }

  function mountButton() {
    if (document.getElementById('pls-fb-btn')) return;
    if (!document.getElementById('pls-fb-style')) {
      var st = document.createElement('style'); st.id = 'pls-fb-style';
      st.textContent = '#pls-fb-btn{position:fixed;right:16px;top:190px;z-index:2147483600;width:34px;height:34px;' +
        'border-radius:9px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;' +
        'background:var(--surface,#fff);color:var(--accent,#C53B2F);border:1px solid var(--line-2,#d6dbe4);' +
        'box-shadow:0 1px 2px rgba(20,25,35,.06);transition:color .15s,border-color .15s}' +
        '#pls-fb-btn:hover{border-color:var(--accent,#C53B2F)}#pls-fb-btn svg{width:18px;height:18px;display:block}';
      document.head.appendChild(st);
    }
    var b = el('button', null,
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.6-5A8.5 8.5 0 1 1 21 11.5z"/></svg>');
    b.id = 'pls-fb-btn';
    b.title = 'Предложить улучшение или сообщить о проблеме';
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', openModal);
    document.body.appendChild(b);
  }

  function pageInfo() {
    var title = (document.title || '').replace(/^ЦУП\s*·?\s*/i, '').replace(/^ProLabSupport[^·]*·?\s*/i, '').trim();
    return { page: location.pathname + location.search, module: title.slice(0, 120) };
  }

  function openModal() {
    if (document.getElementById('pls-fb-ov')) return;
    var sur = cssVar('--surface', '#fff'), text = cssVar('--text', '#101624'), line = cssVar('--line', '#e7eaf0'),
        accent = cssVar('--accent', '#C53B2F'), sub = cssVar('--text-3', '#6a7488'), sur2 = cssVar('--surface-2', '#f1f3f6');
    var info = pageInfo();
    var ov = el('div', ['position:fixed', 'inset:0', 'z-index:2147483601', 'background:rgba(0,0,0,.38)',
      'display:flex', 'align-items:center', 'justify-content:center', 'padding:16px'].join(';'));
    ov.id = 'pls-fb-ov';
    var box = el('div', ['width:100%', 'max-width:460px', 'background:' + sur, 'color:' + text,
      'border:1px solid ' + line, 'border-radius:16px', 'padding:18px 18px 16px',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif', 'box-shadow:0 20px 60px rgba(0,0,0,.3)'].join(';'));
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
        '<b style="font-size:16px">Обратная связь</b>' +
        '<span style="flex:1"></span>' +
        '<button id="pls-fb-x" style="background:none;border:0;color:' + sub + ';font-size:20px;cursor:pointer;line-height:1">×</button>' +
      '</div>' +
      '<div style="font-size:12px;color:' + sub + ';margin-bottom:12px">Модуль: «' + (info.module ? info.module.replace(/[<>&]/g, '') : '—') + '». Пишите что улучшить или что сломалось — всё увидит команда.</div>' +
      '<div id="pls-fb-seg" style="display:inline-flex;background:' + sur2 + ';border:1px solid ' + line + ';border-radius:10px;padding:3px;margin-bottom:10px">' +
        '<button data-k="idea" class="on" style="border:0;background:' + accent + ';color:#fff;font:inherit;font-weight:700;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer">💡 Идея</button>' +
        '<button data-k="problem" style="border:0;background:none;color:' + sub + ';font:inherit;font-weight:700;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer">🐞 Проблема</button>' +
      '</div>' +
      '<textarea id="pls-fb-text" rows="5" maxlength="4000" placeholder="Опишите идею или проблему…" style="width:100%;box-sizing:border-box;background:' + sur2 + ';border:1px solid ' + line + ';border-radius:10px;color:' + text + ';font:inherit;font-size:14px;padding:10px;outline:none;resize:vertical"></textarea>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
        '<button id="pls-fb-attach" type="button" style="background:none;border:1px solid ' + line + ';border-radius:9px;color:' + text + ';font:inherit;font-weight:600;font-size:12.5px;padding:7px 11px;cursor:pointer;white-space:nowrap">📎 Прикрепить</button>' +
        '<span style="font-size:11.5px;color:' + sub + '">или вставьте скрин через Ctrl+V</span>' +
      '</div>' +
      '<input id="pls-fb-file" type="file" accept="image/*,application/pdf" style="display:none">' +
      '<div id="pls-fb-att" style="margin-top:8px"></div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:12px">' +
        '<span id="pls-fb-msg" style="font-size:12px;color:' + sub + '"></span>' +
        '<span style="flex:1"></span>' +
        '<button id="pls-fb-cancel" style="background:none;border:1px solid ' + line + ';border-radius:9px;color:' + text + ';font:inherit;font-weight:600;font-size:13px;padding:8px 12px;cursor:pointer">Отмена</button>' +
        '<button id="pls-fb-send" style="background:' + accent + ';border:0;border-radius:9px;color:#fff;font:inherit;font-weight:700;font-size:13px;padding:8px 14px;cursor:pointer">Отправить</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);

    var kind = 'idea';
    box.querySelectorAll('#pls-fb-seg button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        kind = btn.getAttribute('data-k');
        box.querySelectorAll('#pls-fb-seg button').forEach(function (x) {
          var on = x === btn; x.className = on ? 'on' : '';
          x.style.background = on ? accent : 'none'; x.style.color = on ? '#fff' : sub;
        });
      });
    });
    function close() { ov.remove(); }
    box.querySelector('#pls-fb-x').addEventListener('click', close);
    box.querySelector('#pls-fb-cancel').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var ta = box.querySelector('#pls-fb-text'); setTimeout(function () { ta.focus(); }, 30);

    // ── Вложение (скрин/файл): кнопка, Ctrl+V, сжатие картинок, превью ──
    var attachment = null;
    var MAX_BYTES = 6 * 1024 * 1024;
    var fileInput = box.querySelector('#pls-fb-file');
    var attBox = box.querySelector('#pls-fb-att');
    function setMsg(t) { var m = box.querySelector('#pls-fb-msg'); m.textContent = t; m.style.color = accent; }
    function b64bytes(u) { var i = u.indexOf(','); return Math.floor((u.length - i - 1) * 3 / 4); }
    function renderAtt() {
      if (!attachment) { attBox.innerHTML = ''; return; }
      var isImg = /^image\//.test(attachment.type);
      var thumb = isImg ? ('<img src="' + attachment.data + '" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex:none">') : '<span style="font-size:22px">📄</span>';
      var kb = Math.round(b64bytes(attachment.data) / 1024);
      attBox.innerHTML = '<div style="display:flex;align-items:center;gap:10px;border:1px solid ' + line + ';border-radius:10px;padding:6px 8px">' +
        thumb +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">' + attachment.name.replace(/[<>&]/g, '') + ' <span style="color:' + sub + '">· ' + kb + ' КБ</span></span>' +
        '<button id="pls-fb-att-x" type="button" style="background:none;border:0;color:' + sub + ';font-size:18px;cursor:pointer;line-height:1">×</button></div>';
      attBox.querySelector('#pls-fb-att-x').addEventListener('click', function () { attachment = null; fileInput.value = ''; renderAtt(); });
    }
    function downscaleImage(file, cb) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var MAX = 1600, w = img.width, h = img.height;
          if (w > MAX || h > MAX) { var k = Math.min(MAX / w, MAX / h); w = Math.round(w * k); h = Math.round(h * k); }
          try {
            var c = document.createElement('canvas'); c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            cb(c.toDataURL('image/jpeg', 0.82), 'image/jpeg', (file.name || 'screenshot').replace(/\.[a-z0-9]+$/i, '') + '.jpg');
          } catch (e) { cb(reader.result, file.type, file.name || 'image'); }
        };
        img.onerror = function () { cb(reader.result, file.type, file.name || 'image'); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }
    function acceptFile(file) {
      if (!file) return;
      var isImg = /^image\//.test(file.type);
      if (!isImg && file.type !== 'application/pdf') { setMsg('Можно картинку или PDF'); return; }
      if (isImg) {
        downscaleImage(file, function (data, type, name) {
          if (b64bytes(data) > MAX_BYTES) { setMsg('Картинка слишком большая'); return; }
          attachment = { data: data, type: type, name: name }; renderAtt();
        });
      } else {
        if (file.size > MAX_BYTES) { setMsg('Файл больше 6 МБ'); return; }
        var fr = new FileReader();
        fr.onload = function () { attachment = { data: fr.result, type: 'application/pdf', name: file.name || 'file.pdf' }; renderAtt(); };
        fr.readAsDataURL(file);
      }
    }
    box.querySelector('#pls-fb-attach').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { acceptFile(fileInput.files && fileInput.files[0]); });
    ov.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) { var f = items[i].getAsFile(); if (f) { acceptFile(f); e.preventDefault(); break; } }
      }
    });

    box.querySelector('#pls-fb-send').addEventListener('click', function () {
      var txt = (ta.value || '').trim();
      var msg = box.querySelector('#pls-fb-msg');
      if (!txt) { msg.textContent = 'Напишите сообщение'; msg.style.color = accent; ta.focus(); return; }
      var send = box.querySelector('#pls-fb-send'); send.disabled = true; send.textContent = 'Отправляю…';
      fetch('/api/feedback', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, text: txt, page: info.page, module: info.module, attachment: attachment })
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (d) {
          if (d && d.ok) {
            box.innerHTML = '<div style="text-align:center;padding:14px 6px">' +
              '<div style="font-size:34px">🙏</div>' +
              '<div style="font-size:16px;font-weight:800;margin:6px 0 2px">Спасибо!</div>' +
              '<div style="font-size:13px;color:' + sub + '">Передали команде. Если нужно — вернёмся с вопросом.</div>' +
              '<button id="pls-fb-ok" style="margin-top:14px;background:' + accent + ';border:0;border-radius:9px;color:#fff;font:inherit;font-weight:700;font-size:13px;padding:8px 16px;cursor:pointer">Готово</button></div>';
            box.querySelector('#pls-fb-ok').addEventListener('click', close);
            setTimeout(close, 3500);
          } else {
            msg.textContent = (d && d.error) || 'Не удалось отправить'; msg.style.color = accent;
            send.disabled = false; send.textContent = 'Отправить';
          }
        }).catch(function () {
          msg.textContent = 'Сеть недоступна — попробуйте ещё раз'; msg.style.color = accent;
          send.disabled = false; send.textContent = 'Отправить';
        });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountButton);
  else mountButton();
})();
