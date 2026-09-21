// A DOM small enough to read in one sitting: exactly the slice of the browser
// that app/public/app.js touches, and nothing else. Dependency-free on
// purpose — AGENTS.md says no new packages, and jsdom would be one.
//
// The risk of a hand-written DOM is a test that passes because the fake is
// wrong. Every test in ui.test.js was therefore run against a mutated
// app.js first and watched go red; see docs/ai-mistakes.md on why a green
// test proves nothing until you have seen it fail.

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.parent = null;
    this.own = "";
  }

  get textContent() {
    return this.own + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.own = String(value);
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-(.)/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  // Only the three selector shapes app.js actually uses: "#id", ".class"
  // and "tag.class".
  matches(selector) {
    if (selector.startsWith("#")) return this.getAttribute("id") === selector.slice(1);
    const [tag, className] = selector.split(".");
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (className && !this.className.split(/\s+/).includes(className)) return false;
    return true;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function el(tag, attributes = {}) {
  const node = new El(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/**
 * The same ids, classes and data-attributes as app/public/index.html. The
 * markup itself is checked separately, by ui.test.js reading index.html — so
 * a page that drifts from this fixture fails there rather than silently
 * making these tests test nothing.
 */
export function installPage() {
  const body = el("body");
  const user = el("select", { id: "user" });
  user.value = "1";

  const form = el("form", { id: "new-note" });
  form.append(el("input", { id: "title" }), el("input", { id: "body" }), el("button", {}));

  const filters = el("div", { class: "filters" });
  const active = el("button", { class: "filter", "data-view": "active", "aria-pressed": "true" });
  const archived = el("button", { class: "filter", "data-view": "archived", "aria-pressed": "false" });
  filters.append(active, archived);

  body.append(
    user,
    form,
    filters,
    el("p", { id: "status" }),
    el("p", { id: "empty" }),
    el("ul", { id: "notes" }),
  );

  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new El(tag),
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
  return { body, user, form, filters: { active, archived } };
}

/**
 * A stand-in for the API that answers the way app/src/app.js answers, so the
 * UI is driven by the shape of the real contract. Tests override a status to
 * make the server refuse.
 */
export function installServer(notes = []) {
  const server = {
    notes,
    calls: [],
    postStatus: 201,
    deleteStatus: 204,
    patchStatus: 200,
  };

  globalThis.fetch = async (path, init = {}) => {
    const method = init.method ?? "GET";
    server.calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    const id = Number(path.match(/\/api\/notes\/(\d+)/)?.[1]);
    const reply = (status, payload) => ({
      ok: status < 400,
      status,
      json: async () => payload,
    });

    if (method === "GET") {
      const wanted = path.includes("archived=1");
      return reply(200, server.notes.filter((note) => note.archived === wanted));
    }
    if (method === "POST") {
      if (server.postStatus >= 400) return reply(server.postStatus, { error: "title is required" });
      const created = { id: 99, title: body.title, body: body.body, archived: false, created_at: "2026-09-20 19:33:19" };
      server.notes.push(created);
      return reply(201, created);
    }
    if (method === "DELETE") {
      if (server.deleteStatus >= 400) return reply(server.deleteStatus, { error: "not found" });
      server.notes = server.notes.filter((note) => note.id !== id);
      return reply(204, null);
    }
    if (method === "PATCH") {
      if (server.patchStatus >= 400) return reply(server.patchStatus, { error: "not found" });
      const note = server.notes.find((candidate) => candidate.id === id);
      note.archived = body.archived;
      return reply(200, note);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return server;
}

/** Let the handler's awaits resolve — two macrotask turns is plenty. */
export async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `detail: 0` is how a real click event reports that the keyboard fired it. */
export async function fire(node, type, extra = {}) {
  const event = { type, detail: 0, preventDefault() {}, ...extra };
  for (const handler of node.listeners.get(type) ?? []) await handler(event);
  await settle();
}

export function note(id, title, archived = false) {
  return { id, title, body: "", archived, created_at: "2026-09-20 19:33:19" };
}
