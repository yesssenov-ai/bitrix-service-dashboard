# ProLabSupport — Bitrix24 Service Dashboard

Дашборд сервисных тикетов из смарт-процесса Bitrix24.

## Стек
- **Backend:** Node.js + Express (прокси к Bitrix24 REST API)
- **Frontend:** Vanilla JS + CSS (один HTML файл, без фреймворков)
- **Deploy:** Railway

## Быстрый старт (локально)

```bash
npm install
cp .env.example .env
# Заполни BITRIX_WEBHOOK в .env
node server.js
```

Открой http://localhost:3000

## Деплой на Railway

1. Запушь репо в GitHub:
```bash
git init
git add .
git commit -m "init: bitrix service dashboard"
git remote add origin https://github.com/yesssenov-ai/bitrix-service-dashboard.git
git push -u origin main
```

2. В Railway → New Project → Deploy from GitHub repo

3. В Railway → Variables добавь:
```
BITRIX_WEBHOOK=https://crm.prolabsupport.kz/rest/4/ВАШ_ТОКЕН/
```

4. Railway автоматически запустит `npm start`

## Переменные окружения

| Переменная | Описание |
|---|---|
| `BITRIX_WEBHOOK` | URL вебхука Bitrix24 (с trailing slash) |
| `PORT` | Порт (Railway ставит автоматически) |

## Функционал

- **KPI карточки:** Активные / Срочные / Просроченные
- **Фильтры по стадии:** таблетки по всем 7 активным стадиям с живыми счётчиками
- **Фильтр по срочности:** Срочная / Не срочная / Обучение ТЦ
- **Фильтр просроченных**
- **Поиск** по названию, описанию, инженеру
- **Ссылки** на карточку в Битриксе
- **Авто-обновление** каждые 5 минут
