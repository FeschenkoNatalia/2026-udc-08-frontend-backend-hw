# Task B — API і база даних

## Схема і міграція

```sql
archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
```

Є **і** в `CREATE TABLE` (нова база), **і** окремою міграцією під охоронцем
`PRAGMA table_info(notes)`:

```sql
ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
```

- `ADD COLUMN` адитивна: таблиця не переписується, наявний `notes.db`
  переживає оновлення коду;
- `CHECK` продубльовано навмисно — інакше мігрована база мала б **слабшу**
  схему, ніж свіжа. Зв'язується справді: `UPDATE notes SET archived = 7`
  падає з `CHECK constraint failed`;
- охоронець перевіряє весь контракт колонки — `type`, `notnull`, `DEFAULT 0` і
  `CHECK`, а не лише назву: база з `archived TEXT` раніше проходила мовчки, і
  обидва списки віддавали `200 []`. Тепер старт відмовляє — це тримають чотири
  тести на «дрейфові» бази (`TEXT`, `INTEGER` без `NOT NULL`, без `DEFAULT`, без
  `CHECK`);
- сід загорнуто в `db.transaction(...)`: без транзакції обрив посеред сідування
  лишив би базу без Тараса назавжди, а з нею сід або виконується повністю, або
  не зберігається жоден його запис.

```
EXPLAIN QUERY PLAN SELECT id FROM notes WHERE user_id = 1 AND archived = 0 ORDER BY id
-> SEARCH notes USING COVERING INDEX idx_notes_user_archived
```

До індексу тут було `SCAN notes`.

## Форма ендпоінта

```
PATCH /api/notes/:id/archive   {"archived": true|false}
```

**Явне значення, не перемикач:** toggle не ідемпотентний — повторений після
таймауту запит поверне нотатку назад. Перевірено: три однакові
`{"archived": true}` → `200/200/200` без подвійного перекидання; 20
конкурентних запитів з чергуванням → усі 200, без `SQLITE_BUSY`. Окремий
підресурс, щоб єдине змінюване поле не тягнуло загальний `PATCH /api/notes/:id`.

## Серверна валідація (запити повз інтерфейс)

```
PATCH /api/notes/1/archive  {}                        -> 400 archived must be a boolean
PATCH /api/notes/1/archive  {"archived":"yes"}        -> 400 archived must be a boolean
PATCH /api/notes/1/archive  {"archived":true,"user_id":2} -> 400 unexpected fields: user_id
PATCH /api/notes/abc/archive                          -> 400 invalid id
PUT   /api/notes/1/archive                            -> 405 method not allowed  (Allow: PATCH)
PATCH /api/notes/1/archive  {nope                     -> 400 malformed JSON body
GET   /api/notes?archived=maybe                       -> 400 archived must be 0, 1 or all
GET   /api/notes?ARCHIVED=1                           -> 400 unexpected query parameters: ARCHIVED
POST  /api/notes  {"title":"x","user_id":2}           -> 400 unexpected fields: user_id
POST  /api/notes  заголовок на 201 символ             -> 400 title must be at most 200 characters
```

Жоден випадок не валить процес і не віддає HTML — до правок некоректний JSON
повертав сторінку Express зі `SyntaxError` і абсолютними шляхами.

**Зайві поля відхиляються, а не ігноруються** (тихий `200` підтвердив би
запис, якого не було). Mass assignment перевірено на обох шляхах — `user_id`,
`id`, `archived`, `created_at`, `__proto__`, вкладені об'єкти: скрізь відмова.

## Відповідь не віддає зайвого

```
GET /api/notes  x-user-id: 1
-> 200 [{"id":1,"title":"Список покупок","body":"хліб, кава",
         "archived":false,"created_at":"2026-09-20 19:33:19"}, ...]
```

Колонки перелічені явно на всіх маршрутах, жодного `SELECT *`; `user_id` не
віддається ніде — зокрема з засіяного `GET /api/notes/:id`, який раніше його
показував. Тест перевіряє точний набір ключів:

```js
expect(Object.keys(res.body).sort()).toEqual(["archived", "body", "created_at", "id", "title"]);
```

`archived` перетинає межу булевим в обидва боки: 0/1 — деталь зберігання
SQLite, без нормалізації тип у відповіді залежав би від вмісту колонки.

## Тести

```
cd app && npm test    ->    Test Files 3 passed (3)    Tests 87 passed (87)
```

Дев'ять засіяних тестів не змінені — діф складається лише з додавань.

## Скріншоти

Справжній вивід `curl -si` проти живого сервера на :3080 (свіжа база в пам'яті
на кожен кадр) і `vitest`, відрендерений як термінал.

[10](./screenshots/10-api-archive-endpoint.png) ендпоінт архівування: булевий `archived`, без `user_id`, повторний запит ·
[11](./screenshots/11-api-validation.png) серверна валідація повз інтерфейс: 400 / 405, JSON замість HTML ·
[12](./screenshots/12-migration-tests.png) тести міграції, включно з відмовою на чужій схемі ·
[18](./screenshots/18-npm-test-green.png) `npm test` — 87 зелених
