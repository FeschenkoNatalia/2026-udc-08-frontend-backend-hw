import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { installPage, installServer, settle, fire, note } from "./dom-harness.js";

// The API suite drives app/src; nothing drove app/public, so the three UI
// defects in docs/ai-mistakes.md (1: a swallowed 400, 2: focus landing on the
// wrong action, 3: accessibility checked by eye) could all come back green.
// These are the tests that ask those questions.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, "..", relative), "utf8");

async function boot(notes = []) {
  const page = installPage();
  const server = installServer(notes);
  vi.resetModules();
  await import("../public/app.js");
  await settle();
  return { page, server, list: page.body.querySelector("#notes") };
}

describe("the create form reports a refusal instead of swallowing it", () => {
  it("keeps the text, says why, and marks the field when the server answers 400", async () => {
    const { page, server } = await boot();
    server.postStatus = 400;
    const title = page.body.querySelector("#title");
    title.value = "   ";

    await fire(page.form, "submit");

    const status = page.body.querySelector("#status");
    expect(status.textContent).toMatch(/заголовок/i);
    expect(title.value).toBe("   "); // not cleared out from under the user
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(globalThis.document.activeElement).toBe(title);
  });

  it("distinguishes a 400 from a server that simply fell over", async () => {
    const { page, server } = await boot();
    server.postStatus = 500;
    const title = page.body.querySelector("#title");
    title.value = "Нотатка";

    await fire(page.form, "submit");

    const status = page.body.querySelector("#status");
    expect(status.textContent).toContain("Не вдалося створити нотатку");
    expect(status.textContent).not.toMatch(/потрібен заголовок/i);
    // The field is not at fault, so it is not marked as if it were: a screen
    // reader would announce "invalid entry" on a title with valid text in it.
    expect(title.value).toBe("Нотатка");
    expect(title.getAttribute("aria-invalid")).toBe(null);
    expect(globalThis.document.activeElement).not.toBe(title);
  });

  it("shows the new note's own list when it was created from the archive tab", async () => {
    const { page, server } = await boot([note(1, "Архівна", true)]);
    await fire(page.filters.archived, "click", { detail: 1 });
    page.body.querySelector("#title").value = "Свіжа";
    server.calls.length = 0;

    await fire(page.form, "submit");

    expect(page.filters.active.getAttribute("aria-pressed")).toBe("true");
    expect(server.calls.at(-1)).toBe("GET /api/notes?archived=0");
    expect(page.body.querySelector("#status").textContent).toBe("Нотатку створено.");
  });
});

describe("focus after the row you were standing in disappears", () => {
  it("a keyboard delete lands on another delete button, never on archive", async () => {
    const { page, list } = await boot([note(1, "Перша"), note(2, "Друга")]);

    await fire(list.querySelectorAll("button.delete")[0], "click", { detail: 0 });

    // The defect this guards: focus moved to button.archive of the next row,
    // so the next Space archived a note the user never chose.
    expect(globalThis.document.activeElement.className).toBe("delete");
  });

  it("a mouse delete does not move focus at all", async () => {
    const { page, list } = await boot([note(1, "Перша"), note(2, "Друга")]);

    await fire(list.querySelectorAll("button.delete")[0], "click", { detail: 1 });

    expect(globalThis.document.activeElement).toBe(null);
  });

  it("falls back to the filter when the last row goes", async () => {
    const { page, list } = await boot([note(1, "Єдина")]);

    await fire(list.querySelectorAll("button.delete")[0], "click", { detail: 0 });

    expect(globalThis.document.activeElement).toBe(page.filters.active);
  });

  it("archiving from the keyboard keeps focus on an archive control", async () => {
    const { page, list } = await boot([note(1, "Перша"), note(2, "Друга")]);

    await fire(list.querySelectorAll("button.archive")[0], "click", { detail: 0 });

    expect(globalThis.document.activeElement.className).toBe("archive");
  });

  it("a mouse archive does not move focus either", async () => {
    const { list } = await boot([note(1, "Перша"), note(2, "Друга")]);

    await fire(list.querySelectorAll("button.archive")[0], "click", { detail: 1 });

    expect(globalThis.document.activeElement).toBe(null);
  });
});

describe("a list that arrives late, or not at all", () => {
  it("ignores an older list that answers after a newer one", async () => {
    const { page, server, list } = await boot([note(1, "Активна"), note(2, "Архівна", true)]);
    server.holdGets = true;
    // Handlers are called directly: fire() would wait on a reply that is held.
    const click = (button) => button.listeners.get("click")[0]({ type: "click", detail: 1 });

    const toArchive = click(page.filters.archived);
    const toActive = click(page.filters.active);
    server.held[1](); // the newer request answers first...
    await toActive;
    server.held[0](); // ...and the older one last
    await toArchive;
    await settle();

    expect(list.querySelector("strong").textContent).toBe("Активна");
    expect(page.filters.active.getAttribute("aria-pressed")).toBe("true");
    expect(page.body.querySelector("#status").textContent).toBe("Активних нотаток: 1.");
  });

  it("does not let an older request that failed roll back or report over a newer one", async () => {
    const { page, server, list } = await boot([note(1, "Активна"), note(2, "Архівна", true)]);
    server.holdGets = true;
    const click = (button) => button.listeners.get("click")[0]({ type: "click", detail: 1 });

    server.getStatus = 500;
    const toArchive = click(page.filters.archived); // this one will fail...
    server.getStatus = 200;
    const toActive = click(page.filters.active);
    server.held[1]();
    await toActive;
    server.held[0](); // ...and its failure lands after the newer success
    await toArchive;
    await settle();

    expect(list.querySelector("strong").textContent).toBe("Активна");
    expect(page.filters.active.getAttribute("aria-pressed")).toBe("true");
    expect(page.body.querySelector("#status").textContent).toBe("Активних нотаток: 1.");
  });

  it("says the network is gone when the newest list cannot be fetched", async () => {
    const { page, server } = await boot([note(1, "Активна")]);
    server.getStatus = 0; // fetch rejects, as it does with no connection

    await fire(page.filters.archived, "click", { detail: 1 });

    expect(page.body.querySelector("#status").textContent).toBe("Немає звʼязку з сервером. Спробуйте ще раз.");
    expect(page.filters.active.getAttribute("aria-pressed")).toBe("true"); // filter put back
  });

  it("does not let an older request that lost the network announce over a newer one", async () => {
    const { page, server, list } = await boot([note(1, "Активна"), note(2, "Архівна", true)]);
    server.holdGets = true;
    const click = (button) => button.listeners.get("click")[0]({ type: "click", detail: 1 });

    server.getStatus = 0;
    const toArchive = click(page.filters.archived); // this fetch will reject...
    server.getStatus = 200;
    const toActive = click(page.filters.active);
    server.held[1]();
    await toActive;
    server.held[0](); // ...after the newer list is already on screen
    await toArchive;
    await settle();

    expect(list.querySelector("strong").textContent).toBe("Активна");
    expect(page.body.querySelector("#status").textContent).toBe("Активних нотаток: 1.");
  });

  it("an archive that finishes after the user switched neither moves focus nor announces", async () => {
    const { page, server, list } = await boot([note(1, "Перша"), note(2, "Друга")]);
    server.holdPatches = true;
    // From the keyboard, so a stale reload would also try to move focus.
    const archiving = list.querySelectorAll("button.archive")[0].listeners.get("click")[0]({ type: "click", detail: 0 });

    page.user.value = "2";
    await fire(page.user, "change");
    server.held[0](); // the PATCH answers for a page that is no longer there
    await archiving;
    await settle();

    expect(page.body.querySelector("#status").textContent).toBe("");
    expect(globalThis.document.activeElement).toBe(null);
  });

  it("reloads, quietly, a list fetched before an in-flight archive landed", async () => {
    const { page, server, list } = await boot([note(1, "Перша")]);
    server.holdPatches = true;
    const archiving = list.querySelectorAll("button.archive")[0].listeners.get("click")[0]({ type: "click", detail: 0 });

    await fire(page.filters.archived, "click", { detail: 1 });
    expect(list.querySelectorAll("li").length).toBe(0); // fetched before the PATCH landed
    server.held[0]();
    await archiving;
    await settle();

    expect(list.querySelector("strong").textContent).toBe("Перша");
    expect(page.body.querySelector("#status").textContent).toBe("");
    expect(globalThis.document.activeElement).toBe(null);
  });

  it("an archive that lost the network after the user switched does not say so on the new page", async () => {
    const { page, server, list } = await boot([note(1, "Перша")]);
    server.holdPatches = true;
    server.patchStatus = 0; // this PATCH will reject...
    const archiving = list.querySelectorAll("button.archive")[0].listeners.get("click")[0]({ type: "click", detail: 0 });

    page.user.value = "2";
    await fire(page.user, "change");
    server.held[0](); // ...after the page it belonged to is gone
    await archiving;
    await settle();

    expect(page.body.querySelector("#status").textContent).toBe("");
  });

  it("says the network is gone when an archive on the current page cannot reach the server", async () => {
    const { page, server, list } = await boot([note(1, "Перша")]);
    server.patchStatus = 0;

    await fire(list.querySelectorAll("button.archive")[0], "click", { detail: 1 });

    expect(page.body.querySelector("#status").textContent).toBe("Немає звʼязку з сервером. Спробуйте ще раз.");
    expect(list.querySelector("strong").textContent).toBe("Перша"); // still in the active list
  });

  it("does not report an archive as done when the list failed to reload", async () => {
    const { page, server, list } = await boot([note(1, "Перша")]);
    server.getStatus = 500;

    await fire(list.querySelectorAll("button.archive")[0], "click", { detail: 1 });

    expect(page.body.querySelector("#status").textContent).toBe("Не вдалося завантажити нотатки.");
  });
});

describe("created_at reaches the page as a localised <time>", () => {
  it("anchors SQLite's UTC timestamp instead of printing it raw", async () => {
    const { list } = await boot([note(1, "Перша")]);

    const when = list.querySelectorAll("time")[0];
    expect(when.dateTime).toBe("2026-09-20T19:33:19Z");
    expect(when.textContent).toBe(new Date("2026-09-20T19:33:19Z").toLocaleString("uk-UA"));
    expect(when.textContent).not.toBe("2026-09-20 19:33:19");
  });
});

// The parts of defect 3 that live in the markup and the stylesheet. Read as
// text on purpose: these are the exact properties the browser pass measured,
// and they are the ones that silently rot when somebody edits the page.
describe("the accessibility fixes are still in the page", () => {
  it("every input has a <label for>, and the page has a <main>", () => {
    const html = read("public/index.html");
    const ids = [...html.matchAll(/<input[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html).toContain(`<label for="${id}"`);
    expect(html).toMatch(/<main[\s>]/);
  });

  it("overrides the 1.33:1 border, and does it after the rule that sets it", () => {
    const css = read("public/style.css");
    const override = css.lastIndexOf("border-color: color-mix");
    const thinBorder = css.lastIndexOf("border: 1px solid #8884");

    // Same specificity, so the later rule is the one that paints. Moving this
    // up the file puts the invisible boundary back without changing a colour.
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(thinBorder);
    expect(css.slice(override - 60, override)).toMatch(/input,\s*button,\s*li/);
  });

  it("keeps inputs border-box, so a field cannot outgrow its cell", () => {
    expect(read("public/style.css")).toMatch(/input\s*\{[^}]*box-sizing:\s*border-box/);
  });

  it("leaves a visible focus ring on every control", () => {
    const css = read("public/style.css");

    expect(css).toContain(":focus-visible");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/);
  });

  it("does not let the UI demand more or less than the server does", () => {
    const html = read("public/index.html");
    const server = read("src/app.js");
    const limit = (name) => Number(server.match(new RegExp(`${name} = ([0-9_]+)`))[1].replace(/_/g, ""));

    expect(html).toContain(`id="title" name="title" maxlength="${limit("MAX_TITLE")}"`);
    expect(html).toContain(`id="body" name="body" maxlength="${limit("MAX_BODY")}"`);
  });
});
