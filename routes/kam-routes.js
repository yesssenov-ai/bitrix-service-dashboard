// ─────────────────────────────────────────────────────────────────────────────
// Модуль «КАМ» (ключевые клиенты). Иерархия:
//   Группа компаний → Компания → [Отдел/Лаборатория/Факультет]? → КАМ → Проекты → сделки
// Слой подразделения опциональный (нет слоя → проекты сразу под компанией).
// КАМ назначается гибко на любом уровне, наследуется вниз, переопределяется.
// Реестр подразделений ведём в ЦУП (зависимость «компания → её подразделения»),
// значение пишем в текстовое поле сделки Битрикса; всё зеркалится в Б24.
//
// Статус: сборка. Этот файл стартует с диагностики полей (field-probe), затем
// обрастёт чтением дерева/портфеля и админкой с записью в Битрикс.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { b24 } = require('../bitrix');

const ADMIN_ROLES = ['admin', 'superadmin', 'coordinator'];

// GET /api/kam/field-probe — найти коды полей сделки по названию (разовая разведка).
// Нужно подтвердить: «Группа компаний (УС)», «Название отдела/лаборатории/факультета»,
// КАМ, «В рамках проекта». Убрать после фиксации кодов в kam-calc.
router.get('/field-probe', requireAuth(ADMIN_ROLES), async (req, res) => {
  try {
    const { result } = await b24('crm.deal.fields', {});
    const rx = /групп|отдел|лаборатор|факультет|\bкам\b|key ?account|рамк|проект|конечн/i;
    const KNOWN = /1731862481|1791972186|1731862784|1731862784/;
    const out = {};
    for (const [code, f] of Object.entries(result || {})) {
      const title = f.formLabel || f.title || f.listLabel || f.filterLabel || '';
      if (rx.test(title) || KNOWN.test(code)) {
        out[code] = {
          title,
          type: f.type,
          isList: !!(f.items && f.items.length),
          isMultiple: !!f.isMultiple,
          items: (f.items || []).slice(0, 12).map(i => ({ id: i.ID, v: i.VALUE })),
        };
      }
    }
    res.json({ count: Object.keys(out).length, fields: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };
