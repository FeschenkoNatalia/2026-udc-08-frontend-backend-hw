# Task C — авторизація

## 1. Витік, відтворений руками

`GET /api/notes/:id` шукав нотатку **лише за `id`**. Оля просить нотатку Тараса:

```
GET /api/notes/3   x-user-id: 1
-> 200 {"id":3,"user_id":2,"title":"Приватна нотатка Тараса",
        "body":"пароль від сейфа: 1234","created_at":"..."}
```

Витекли дві речі: чуже тіло і внутрішня колонка `user_id`.

## 2. Правка — умова в самому запиті

```sql
SELECT id, title, body, archived, created_at FROM notes WHERE id = ? AND user_id = ?
```

Власник у `SELECT`, а не перевірка після читання: чужа нотатка не збігається
ні з чим, тож у руках немає даних, які можна випадково віддати.

**404, а не 403** — 403 підтвердив би, що нотатка з таким `id` існує, а `id`
тут одна глобальна послідовність. Перевірено: «чужа» і «неіснуюча» відповіді
байт-у-байт однакові, різниця в часі 6.3 мкс (0.8%, шум).

```
GET /api/notes/3   x-user-id: 1   -> 404 {"error":"not found"}
GET /api/notes/3   x-user-id: 2   -> 200 (власник, без user_id)
```

## 3. Тест, який червоніє до правки

Засіяний `will not delete someone else's note` зелений і до фіксу — він про
**видалення**. Новий тест — на **читання**, і не лише про статус:

```js
const res = await asOlya(request(app).get("/api/notes/3")).expect(404);
expect(JSON.stringify(res.body)).not.toContain("пароль від сейфа");
```

З поверненою дірою (у пісочниці):

```
× GET /api/notes/:id > will not read someone else's note
    → expected 404 "Not Found", got 200 "OK"
× cross-user refusals ship no data > a note that does not exist is
  indistinguishable from someone else's
Tests  2 failed | 87 passed (89)
```

**Дев'ять засіяних тестів були зелені й з відкритою дірою.**

## 4. Прохід усіма маршрутами

«Звідки береться межа даних, які поверне цей маршрут?»

| Маршрут | Межа | Чужим заголовком |
|---|---|---|
| `GET /api/notes` | `WHERE user_id = ? AND archived = ?` | два різні списки |
| `GET /api/notes?archived=all` | `WHERE user_id = ?` | лише свої |
| `GET /api/notes/:id` | `WHERE id = ? AND user_id = ?` ← **була діра** | **404** |
| `POST /api/notes` | власник із сесії, поля поіменно | **400**, нотатки немає |
| `PATCH /api/notes/:id/archive` | `UPDATE ... WHERE id = ? AND user_id = ?` | **404**, чужа не зачеплена |
| `DELETE /api/notes/:id` | `DELETE ... WHERE id = ? AND user_id = ?` | **404**, рядок на місці |
| статика `/` | користувацьких даних немає | `/notes.db`, `/../notes.db`, `/.env` → 404 |

Жоден маршрут не бере межу лише з `id`, ніде немає перевірки після читання.

## 5. Сам користувач — теж межа

```
GET /api/notes  (без заголовка)  -> 401
GET /api/notes  x-user-id: 999   -> 401
GET /api/notes  x-user-id: 0x2   -> 401
```

До правки `999` проходив як повноцінна сесія (`200 []` на читанні, `500` з
`FOREIGN KEY constraint failed` на записі), а `0x2` **автентифікувався як
Тарас**. Повторений заголовок Node склеює у `"1, 2"` → 401, тобто падає в
безпечний бік.

## 6. Та сама діра на один маршрут правіше — гілка `archived=1`

Мутація, що прибирає умову по власнику лише в гілці `archived=1`, віддавала
чужий архів і лишала набір повністю зеленим: наявний тест архівував нотатку
Олі й читав її ж як Оля — питав «чи працює фільтр», а не «чий це архів».
Закрито двома тестами в `app/test/authz.test.js`, перевіреними на червоне під
цією мутацією; знятий вивід — у [ai-mistakes.md, запис 7](../ai-mistakes.md).

## 7. Кожен новий тест перевірено на червоне

Guard прибирався по одному в пісочниці — чотирнадцять мутацій, і щоразу
червонів саме той тест, який мав:

| Прибрано | Почервонів |
|---|---|
| умова по власнику в гілці архіву | `does not show another user's archived notes` |
| `PATCH` віддає 404 разом з рядком | `PATCH archive ... returns nothing about it` |
| `SELECT *` у списку | `the list hands back no owner column` |
| валідація `id` на `DELETE` | `rejects "abc" with 400, not 404` (+9) |
| `CHECK` у свіжій схемі | `refuses an archived value that is neither 0 nor 1` |
| перевірка існування користувача | `refuses an x-user-id that is not a seeded user` |
| канонічний розбір `id` | `refuses non-canonical spellings of a user id` |
| JSON-обробник помилок | `answers a malformed JSON body with JSON, ...` |
| catch-all гілка JSON-обробника (`next(err)` замість JSON 500) | `answers an unexpected failure with JSON, not a stack trace` |
| перевірка `type` в охоронці міграції | `refuses to start on archived TEXT, ...` |
| перевірка `notnull` в охоронці міграції | `refuses to start on archived nullable INTEGER, ...` |
| перевірка `DEFAULT 0` в охоронці міграції | `refuses to start on archived INTEGER NOT NULL without DEFAULT, ...` |
| перевірка `CHECK` в охоронці міграції | `refuses to start on archived INTEGER NOT NULL DEFAULT 0 without CHECK, ...` |
| `db.close()` перед відмовою міграції | усі чотири тести на «дрейфові» бази — на Windows `rmSync` падає з `EPERM` |

Окремо: маршрути були закриті лише **позицією** в ланцюжку middleware —
підставний маршрут вище за `app.use("/api", currentUser)` віддавав чужу нотатку
анонімно, а набір лишався зеленим, бо 401 перевірявся на одному маршруті з
шести. Тепер — на всіх шести.

## Скріншоти

Справжній вивід `curl -si` проти живого сервера на :3080 (свіжа база в пам'яті
на кожен кадр) і `vitest`, відрендерений як термінал.

[13](./screenshots/13-idor-read-fixed.png) засіяна діра: чужа нотатка і неіснуюча відповідають однаково (404) ·
[14](./screenshots/14-cross-user-writes.png) PATCH / DELETE / POST чужим користувачем — відмова, дані Тараса без змін ·
[15](./screenshots/15-archive-read-path.png) архів Олі не бачить архіву Тараса ·
[16](./screenshots/16-authentication.png) без заголовка, `999`, `0x2` → 401 ·
[17](./screenshots/17-test-red-with-hole.png) діру повернуто в копії `app/` — два тести червоні; діру знову закрито — усі 89 зелені ·
[07](./screenshots/07-other-user.png) в інтерфейсі Тарас бачить лише своє
