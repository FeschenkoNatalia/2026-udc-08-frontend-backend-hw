# Task A — UI архівування, перевірене в браузері

Реальний Chrome через DevTools Protocol: справжні події, DOM і дерево
доступності, а не лише скріншот.

## Дерево доступності (`Accessibility.getFullAXTree`)

```
role=main     name=""                       role=button name="Додати"
role=heading  name="Нотатки"                role=button name="Активні"
role=group    name="Які нотатки показувати" role=button name="Архів"
role=status   name=""                       role=button name="Архівувати: Список покупок"
role=combobox name="Я увійшов як "          role=button name="Видалити: Список покупок"
role=textbox  name="Заголовок"              role=button name="Архівувати: Ідеї для відпустки"
role=textbox  name="Текст"                  role=button name="Видалити: Ідеї для відпустки"
```

У вкладці «Архів»: `name="Повернути з архіву: Список покупок"`.

- справжні `<button>`, а не `<div role="button">`; назви полів з `<label for>`;
- заголовок нотатки в доступній назві — кнопки дій не звуться однаково;
- видима назва є префіксом доступної (**SC 2.5.3 Label in Name**);
- **кнопка архівування — без `aria-pressed`** (фільтри його мають): вона
  прибирає власний рядок зі списку, тож «перемикання на місці», заради якого
  існує правило APG, не відбувається. Стан показує бейдж «В архіві».

## Клавіатура

Дев'ять `Tab` від початку документа: порядок = DOM, пасток немає,
`:focus-visible` (`solid 2px`) на кожному стопі.

```
select "Оля / Тарас" → "Заголовок" → "Текст" → "Додати" → "Активні"
→ "Архів" → "Архівувати: Список покупок" → "Видалити: ..." → ...
```

`Enter` архівує, `Space` повертає з архіву (перевірено окремо — `Space`
спрацьовує на `keyup`). Після зникнення рядка фокус іде на контрол **того
самого класу** в сусідньому рядку, на порожньому списку — на фільтр, і лише
коли дію ініціювала клавіатура (`event.detail === 0`).

## Розміри цілей і контраст — виміряно, а не на око

Цілі (SC 2.5.8): найменша 59×36, на 320 px усі теж ≥ 24×24.

```
select 59x36 | input 292x41 | Додати 81x41 | Активні 83x41
Архів 68x41  | Архівувати 105x41 | Видалити 95x41
```

Контраст з обчислених стилів (межа поля до правок — **1.33:1**, порожнє поле
не мало видимих контурів):

| Елемент | Світла | Темна |
|---|---|---|
| Текст нотатки / бейдж / натиснутий фільтр | 21:1 | 18.73:1 |
| Ненатиснутий фільтр | 19.61:1 | 17.42:1 |
| Дата (`opacity: .65`) | 6.98:1 | 8.26:1 |
| Межа поля вводу | 4.53:1 | 4.53:1 |

## Автоматична перевірка станів

```
PASS  both form inputs have an associated <label>
PASS  the empty state appears exactly once on the page
PASS  form controls do not overlap and the two fields are even (292 and 292px)
PASS  active list: label is the action, title in the accessible name, no aria-pressed
PASS  visible text is a prefix of the accessible name (SC 2.5.3)
PASS  archive view: the label names the opposite action
PASS  the filter switch announces what is in the list — "В архіві нотаток: 1."
PASS  created_at renders as a localised <time> — 20.09.2026, 22:33:19
PASS  Space after a mouse delete does not archive a different note
PASS  no sideways scroll at 320px and the submit button is on screen
PASS  input boundary clears SC 1.4.11 (3:1) — 4.53:1 (was 1.33:1)
PASS  no console errors or uncaught exceptions
12/12 checks passed
```

XSS окремо: `<img src=x onerror="window.__XSS=1">` рендериться як текст,
`window.__XSS` лишається `undefined`, `#notes img` = 0.

## Регресійні тести UI (`app/test/ui.test.js`)

Прохід у браузері — одноразовий, тож те, що він виміряв, тримають 23 тести у
наборі. Без нових залежностей: DOM рівно на ту частину, яку `public/app.js`
справді чіпає, лежить у `app/test/dom-harness.js`.

Кожен перевірено на червоне — прибрати одну умову й подивитись, який тест
почервоніє:

| Прибрано | Почервонів |
|---|---|
| `if (!res.ok)` в обробнику створення | `keeps the text, says why...` (+1) |
| `aria-invalid` + фокус лише на 400 (ставились і на 500) | `distinguishes a 400 from a server that simply fell over` |
| повернення в активний список після створення | `shows the new note's own list when it was created from the archive tab` |
| клас контрола у `restoreFocus` (завжди `archive`) | `a keyboard delete lands on another delete button, never on archive` |
| клас контрола у `restoreFocus` (завжди `delete`) | `archiving from the keyboard keeps focus on an archive control` |
| `event.detail === 0` на видаленні | `a mouse delete does not move focus at all` |
| `event.detail === 0` на архівуванні | `a mouse archive does not move focus either` |
| фолбек на фільтр, коли список спорожнів | `falls back to the filter when the last row goes` |
| прив'язка `created_at` до UTC | `anchors SQLite's UTC timestamp instead of printing it raw` |
| `<label for="body">` | `every input has a <label for>, and the page has a <main>` |
| правило `border-color: color-mix(...)` | `overrides the 1.33:1 border, and does it after the rule that sets it` |
| збіг `maxlength` із серверним лімітом | `does not let the UI demand more or less than the server does` |
| перевірка застарілої відповіді в `load()` | `ignores an older list that answers after a newer one` (+2) |
| `STALE` в обробнику фільтра (застаріле як невдача — відкат) | `ignores an older list that answers after a newer one` (+2) |
| перевірка результату `load()` перед «заархівовано» | `does not report an archive as done when the list failed to reload` |
| шлях `/archive` у запиті архівування | `archiving from the keyboard keeps focus on an archive control` (+4) |
| «немає звʼязку» лише після перевірки застарілості | `does not let an older request that lost the network announce over a newer one` |
| «немає звʼязку» від найновішого завантаження | `says the network is gone when the newest list cannot be fetched` |
| перевірка «сторінка змінилась» в архівуванні | `an archive that finishes after the user switched neither moves focus nor announces` (+2) |
| тихе перезавантаження після зміни сторінки | `reloads, quietly, a list fetched before an in-flight archive landed` |
| «немає звʼязку» в архівуванні лише після перевірки «сторінка змінилась» | `an archive that lost the network after the user switched does not say so on the new page` |
| «немає звʼязку» від архівування на поточній сторінці | `says the network is gone when an archive on the current page cannot reach the server` |

Двадцять дві мутації — двадцять два рази червонів саме той тест, який мав.

## Скріншоти

Зняті з поточного коду в headless Chrome; стани клавіатури — справжніми
натисканнями `Tab` / `Space` / `Enter`, а не `focus()` зі скрипта.

[01](./screenshots/01-active-list.png) активні · [02](./screenshots/02-archive-empty-state.png) порожній архів ·
[03](./screenshots/03-archived-with-badge.png) бейдж «В архіві» + «Повернути з архіву» ·
[04](./screenshots/04-keyboard-focus-ring.png) кільце фокуса ·
[05](./screenshots/05-dark-scheme.png) темна схема ·
[06](./screenshots/06-reflow-320px.png) 320 px ·
[07](./screenshots/07-other-user.png) Тарас бачить лише своє ·
[08](./screenshots/08-create-refused-400.png) сервер відмовив (400): текст лишився, фокус у полі ·
[09](./screenshots/09-keyboard-delete-focus.png) видалення з клавіатури — фокус на наступному «Видалити»
