// Minimal UI. No framework and no build step on purpose: the point of this
// homework is the seam between UI, API, database and authorization, not the
// view layer. Keep it that way — do not introduce a bundler.

const userSelect = document.querySelector("#user");
const list = document.querySelector("#notes");
const empty = document.querySelector("#empty");
const form = document.querySelector("#new-note");
const statusLine = document.querySelector("#status");
const filters = [...document.querySelectorAll(".filter")];

// Which of the two lists is on screen. The server decides what belongs in
// each one; this is only the question we ask it.
let showArchived = false;

const EMPTY_TEXT = {
  active: "Активних нотаток поки немає.",
  archived: "В архіві порожньо. Заархівуйте нотатку — і вона зʼявиться тут.",
};

function currentView() {
  return showArchived ? "archived" : "active";
}

function headers() {
  return { "content-type": "application/json", "x-user-id": userSelect.value };
}

function announce(text) {
  statusLine.textContent = text;
}

function syncFilters() {
  for (const filter of filters) {
    filter.setAttribute("aria-pressed", String(filter.dataset.view === currentView()));
  }
}

// An empty list says so through #empty, which is a live region of its own.
// Repeating it here would print the same sentence twice on the page.
function summary(notes) {
  if (notes.length === 0) return "";
  return showArchived
    ? `В архіві нотаток: ${notes.length}.`
    : `Активних нотаток: ${notes.length}.`;
}

const OFFLINE = "Немає звʼязку з сервером. Спробуйте ще раз.";

// The one place the network can fail. `fetch` rejects outright when the
// connection is gone — an unguarded await is an uncaught TypeError and a UI
// that says nothing at all, which is worse than an error message. `send` only
// reports it (null); `request` also says so. load() uses `send` and speaks
// only once it knows its answer is still the newest one.
async function send(path, init = {}) {
  try {
    return await fetch(path, { ...init, headers: headers() });
  } catch {
    return null;
  }
}

async function request(path, init = {}) {
  const res = await send(path, init);
  if (!res) announce(OFFLINE);
  return res;
}

// A real <button> with a text label, so the keyboard and the accessibility
// tree get it for free. The label names the action the button performs; the
// note's state is carried by the badge next to its title. (An aria-pressed
// toggle would be the canonical pattern for a control that stays on screen —
// this one removes its own row, and its pressed state would be identical for
// every button in the view, so it would repeat the filter and say nothing
// about the note.) The title rides in the accessible name so a screen reader
// can tell a list of identically-labelled buttons apart.
function archiveButton(note, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "archive";
  button.textContent = note.archived ? "Повернути з архіву" : "Архівувати";
  button.setAttribute("aria-label", `${button.textContent}: ${note.title}`);
  button.addEventListener("click", (event) =>
    toggleArchive(note, index, event.detail === 0),
  );
  return button;
}

function noteItem(note, index) {
  const li = document.createElement("li");

  const grow = document.createElement("div");
  grow.className = "grow";

  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("strong");
  title.textContent = note.title;
  head.append(title);
  if (note.archived) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "В архіві";
    head.append(badge);
  }
  grow.append(head);

  // The body is optional: render nothing rather than an empty element and a
  // reserved blank line.
  if (note.body) {
    const body = document.createElement("span");
    body.textContent = note.body;
    grow.append(body);
  }

  // SQLite's datetime('now') is UTC. Printed raw it shows every note hours in
  // the past; <time> also gives a screen reader a date instead of digit soup.
  const when = document.createElement("time");
  const iso = `${note.created_at.replace(" ", "T")}Z`;
  when.dateTime = iso;
  when.textContent = new Date(iso).toLocaleString("uk-UA");
  grow.append(when);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.textContent = "Видалити";
  del.setAttribute("aria-label", `Видалити: ${note.title}`);
  del.addEventListener("click", async (event) => {
    const res = await request(`/api/notes/${note.id}`, { method: "DELETE" });
    if (!res) return;
    announce(
      res.ok ? `Нотатку «${note.title}» видалено.` : "Не вдалося видалити нотатку.",
    );
    load({ focusIndex: index, focusKind: "delete", focus: event.detail === 0 });
  });

  li.append(grow, archiveButton(note, index), del);
  return li;
}

// Archiving or deleting takes the row out of the list you are standing in,
// which would drop focus onto <body>. Put it back on the same KIND of control
// in the row that took its place: landing on a different action is how a
// stray Space turns into an archive you never asked for. Only move focus when
// the keyboard was driving — a mouse user who has not focused anything should
// not suddenly have a button under their spacebar.
function restoreFocus(index, kind) {
  const buttons = list.querySelectorAll(`button.${kind}`);
  const target = buttons.length ? buttons[Math.min(index, buttons.length - 1)] : null;
  (target ?? filters.find((filter) => filter.dataset.view === currentView())).focus();
}

// Responses can land out of order: switch the filter or the user quickly and
// the earlier request may answer last. Only the newest load may touch the
// page. An older one returns STALE rather than null, so its caller neither
// rolls the filter back nor announces a result that is no longer on screen.
const STALE = Symbol("stale load");
let latestLoad = 0;

async function load({ focusIndex = null, focusKind = "archive", focus = true } = {}) {
  const ticket = ++latestLoad;
  const view = currentView();
  const res = await send(`/api/notes?archived=${view === "archived" ? 1 : 0}`);
  const notes = res?.ok ? await res.json() : null;
  // One check after the last await covers both outcomes: a stale failure must
  // not announce or roll the filter back any more than a stale success may
  // repaint the list.
  if (ticket !== latestLoad) return STALE;
  if (!res) {
    announce(OFFLINE);
    return null;
  }
  if (!res.ok) {
    announce("Не вдалося завантажити нотатки.");
    return null;
  }

  list.replaceChildren(...notes.map(noteItem));
  empty.textContent = EMPTY_TEXT[view];
  empty.hidden = notes.length > 0;
  if (focusIndex !== null && focus) restoreFocus(focusIndex, focusKind);
  return notes;
}

async function toggleArchive(note, index, byKeyboard) {
  // Switching the user or the filter while the PATCH is in flight starts a
  // newer load, and the page this click belonged to is gone: no focus move and
  // no announcement belong on the new one. Its list, though, may have been
  // fetched before the server applied this change — so reload it, quietly.
  const pageVersion = latestLoad;
  const res = await request(`/api/notes/${note.id}/archive`, {
    method: "PATCH",
    body: JSON.stringify({ archived: !note.archived }),
  });
  if (pageVersion !== latestLoad) {
    if (res?.ok) await load();
    return;
  }
  if (!res) return;
  if (!res.ok) {
    announce("Не вдалося змінити стан нотатки.");
    return;
  }

  const updated = await res.json();
  const notes = await load({ focusIndex: index, focusKind: "archive", focus: byKeyboard });
  // A failed reload has already said so; a stale one was overtaken. Either
  // way a success message here would describe a list that is not on screen.
  if (!Array.isArray(notes)) return;
  // If the list just emptied, #empty announces that itself.
  announce(
    updated.archived
      ? `Нотатку «${updated.title}» заархівовано.`
      : `Нотатку «${updated.title}» повернуто з архіву.`,
  );
}

for (const button of filters) {
  button.addEventListener("click", async () => {
    const wanted = button.dataset.view === "archived";
    if (wanted === showArchived) return; // no refetch, no repeated announcement

    const previous = showArchived;
    showArchived = wanted;
    syncFilters();

    const notes = await load();
    if (notes === STALE) return; // a newer click owns the page now
    if (!notes) {
      // The list never arrived. Put the filter back rather than leaving the
      // UI claiming to show an archive it does not have.
      showArchived = previous;
      syncFilters();
      return;
    }
    announce(summary(notes));
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.querySelector("#title");
  const body = document.querySelector("#body");
  const res = await request("/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: title.value, body: body.value }),
  });
  if (!res) return;
  if (!res.ok) {
    // The server decides what a valid note is. Only a 400 is about the title:
    // telling the user to check a field that visibly has text in it would be
    // its own bug — and so would marking it invalid, which a screen reader
    // announces just as loudly as the message.
    if (res.status === 400) {
      announce("Не вдалося створити нотатку — потрібен заголовок.");
      title.setAttribute("aria-invalid", "true");
      title.focus();
    } else {
      announce("Не вдалося створити нотатку.");
    }
    return;
  }

  title.removeAttribute("aria-invalid");
  title.value = "";
  body.value = "";
  // A new note is always active, so show the list it actually landed in rather
  // than leaving the archive on screen with nothing new in it.
  if (showArchived) {
    showArchived = false;
    syncFilters();
  }
  announce("Нотатку створено.");
  load();
});

userSelect.addEventListener("change", () => {
  announce("");
  load();
});
load();
