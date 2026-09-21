import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let app;
beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

const asOlya = (r) => r.set("x-user-id", "1");
const asTaras = (r) => r.set("x-user-id", "2");

// The one string that must never reach the wrong caller, in any shape.
const SECRET = "пароль від сейфа";
const OTHERS_TITLE = "Приватна нотатка Тараса";
const PUBLIC_COLUMNS = ["archived", "body", "created_at", "id", "title"];

const leaksNothing = (res) => {
  const wire = JSON.stringify(res.body);
  expect(wire).not.toContain(SECRET);
  expect(wire).not.toContain(OTHERS_TITLE);
};

// The archive view is a READ path with its own WHERE clause, so it needs the
// ownership question asked of it separately from the active list.
describe("GET /api/notes?archived=1 — someone else's archive", () => {
  it("does not show another user's archived notes", async () => {
    await asTaras(request(app).patch("/api/notes/3/archive"))
      .send({ archived: true })
      .expect(200);

    const res = await asOlya(request(app).get("/api/notes?archived=1")).expect(200);
    expect(res.body).toEqual([]);
    leaksNothing(res);
  });

  it("keeps the two users' archives apart once both have one", async () => {
    await asTaras(request(app).patch("/api/notes/3/archive")).send({ archived: true });
    await asOlya(request(app).patch("/api/notes/1/archive")).send({ archived: true });

    const olya = await asOlya(request(app).get("/api/notes?archived=1")).expect(200);
    expect(olya.body.map((n) => n.id)).toEqual([1]);
    leaksNothing(olya);

    const taras = await asTaras(request(app).get("/api/notes?archived=1")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });
});

// A 404 is only half the answer. These assert the other user's row is not in
// the payload either — a leak in a different shape still counts as a leak.
describe("cross-user refusals ship no data", () => {
  it("PATCH archive on someone else's note returns nothing about it", async () => {
    const res = await asOlya(request(app).patch("/api/notes/3/archive"))
      .send({ archived: true })
      .expect(404);
    leaksNothing(res);
  });

  it("DELETE on someone else's note returns nothing about it", async () => {
    const res = await asOlya(request(app).delete("/api/notes/3")).expect(404);
    leaksNothing(res);
  });

  it("a note that does not exist is indistinguishable from someone else's", async () => {
    const missing = await asOlya(request(app).get("/api/notes/999")).expect(404);
    const theirs = await asOlya(request(app).get("/api/notes/3")).expect(404);
    expect(theirs.body).toEqual(missing.body);
  });
});

// Every route, not just the one the original suite happened to pick.
describe("authentication covers every route", () => {
  const withoutHeader = [
    ["GET", (r) => r.get("/api/notes")],
    ["GET archive", (r) => r.get("/api/notes?archived=1")],
    ["GET one", (r) => r.get("/api/notes/3")],
    ["POST", (r) => r.post("/api/notes").send({ title: "x" })],
    ["PATCH archive", (r) => r.patch("/api/notes/3/archive").send({ archived: true })],
    ["DELETE", (r) => r.delete("/api/notes/3")],
  ];

  for (const [name, call] of withoutHeader) {
    it(`${name} refuses a request with no user header`, async () => {
      const res = await call(request(app));
      expect(res.status).toBe(401);
      leaksNothing(res);
    });
  }

  it("leaves the data untouched when the caller is anonymous", async () => {
    await request(app).delete("/api/notes/3");
    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });
});

// The owner column must not ship from ANY route, not only the two that were
// spot-checked.
describe("response shape on every route", () => {
  it("the list hands back no owner column", async () => {
    const res = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const note of res.body) {
      expect(note).not.toHaveProperty("user_id");
      expect(Object.keys(note).sort()).toEqual(PUBLIC_COLUMNS);
    }
  });

  it("the archive list hands back no owner column", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive")).send({ archived: true });
    const res = await asOlya(request(app).get("/api/notes?archived=1")).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const note of res.body) expect(Object.keys(note).sort()).toEqual(PUBLIC_COLUMNS);
  });

  it("the created note hands back no owner column", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Нова", body: "текст" })
      .expect(201);
    expect(res.body).not.toHaveProperty("user_id");
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_COLUMNS);
  });

  it("the archived note hands back no owner column", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1/archive"))
      .send({ archived: true })
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual(PUBLIC_COLUMNS);
  });
});

// DELETE validates its id like the other two routes claim to.
describe("DELETE /api/notes/:id — id validation", () => {
  for (const bad of ["abc", "0", "-1", "1.5", " "]) {
    it(`rejects ${JSON.stringify(bad)} with 400, not 404`, async () => {
      await asOlya(request(app).delete(`/api/notes/${encodeURIComponent(bad)}`)).expect(400);
    });
  }
});

// The invariant has to hold on a FRESHLY CREATED database too — the migration
// test only ever proves it for the migrated one.
describe("schema invariants on a fresh database", () => {
  it("refuses an archived value that is neither 0 nor 1", () => {
    const db = createDb(":memory:");
    expect(() => db.prepare("UPDATE notes SET archived = 7 WHERE id = 1").run()).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      db.prepare("INSERT INTO notes (user_id, title, archived) VALUES (?, ?, ?)").run(1, "x", 2),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("refuses a note owned by a user that does not exist", () => {
    const db = createDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO notes (user_id, title) VALUES (?, ?)").run(999, "orphan"),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });
});

// The migration fixture the original test needed: more than one row, more than
// one owner, and ids and timestamps pinned so a table rebuild cannot pass by
// keeping the text and losing everything else.
describe("archive migration preserves the whole table", () => {
  it("keeps every row, its owner, its id and its created_at", () => {
    const file = join(tmpdir(), `ws08-migration-full-${process.pid}-${Date.now()}.db`);
    let db;
    try {
      const before = new Database(file);
      before.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE notes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id),
          title      TEXT NOT NULL,
          body       TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const addUser = before.prepare("INSERT INTO users (id, name) VALUES (?, ?)");
      addUser.run(1, "Оля");
      addUser.run(2, "Тарас");
      const addNote = before.prepare(
        "INSERT INTO notes (id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      addNote.run(1, 1, "Стара нотатка Олі", "написана до фічі", "2019-01-01 10:00:00");
      addNote.run(2, 1, "Друга нотатка Олі", "теж важлива", "2019-02-02 11:00:00");
      addNote.run(3, 2, "Приватна нотатка Тараса", "пароль від сейфа: 1234", "2019-03-03 12:00:00");
      before.close();

      db = createDb(file); // runs the migration

      expect(
        db.prepare("SELECT id, user_id, title, body, archived, created_at FROM notes ORDER BY id").all(),
      ).toEqual([
        { id: 1, user_id: 1, title: "Стара нотатка Олі", body: "написана до фічі", archived: 0, created_at: "2019-01-01 10:00:00" },
        { id: 2, user_id: 1, title: "Друга нотатка Олі", body: "теж важлива", archived: 0, created_at: "2019-02-02 11:00:00" },
        { id: 3, user_id: 2, title: "Приватна нотатка Тараса", body: "пароль від сейфа: 1234", archived: 0, created_at: "2019-03-03 12:00:00" },
      ]);

      // The migrated column carries the same invariant as a fresh one.
      expect(() => db.prepare("UPDATE notes SET archived = 7 WHERE id = 1").run()).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      // close() belongs in the finally: on Windows an open handle makes the
      // rmSync below throw EPERM, which replaces the real assertion error.
      db?.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    }
  });

  it("is idempotent — a second createDb on the same file changes nothing", () => {
    const file = join(tmpdir(), `ws08-migration-twice-${process.pid}-${Date.now()}.db`);
    let first;
    let second;
    try {
      first = createDb(file);
      const before = first.prepare("SELECT id, title, archived FROM notes ORDER BY id").all();
      first.close();
      first = undefined;

      second = createDb(file);
      expect(second.prepare("SELECT id, title, archived FROM notes ORDER BY id").all()).toEqual(before);
    } finally {
      first?.close();
      second?.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    }
  });
});

// Mistake 5 in docs/ai-mistakes.md. The guard used to ask only whether a
// column NAMED archived existed, so a database that got `archived TEXT` from
// an earlier iteration started cleanly — and `WHERE archived = 0` matched
// nothing, leaving both lists empty with no error anywhere.
describe("archive migration refuses a column it did not create", () => {
  const drifted = [
    ["TEXT", "archived TEXT NOT NULL DEFAULT '0'"],
    ["nullable INTEGER", "archived INTEGER DEFAULT 0"],
  ];

  drifted.forEach(([label, column], index) => {
    it(`refuses to start on archived ${label}, and leaves the rows alone`, () => {
      const file = join(tmpdir(), `ws08-drift-${process.pid}-${Date.now()}-${index}.db`);
      let opened;
      let after;
      try {
        const before = new Database(file);
        before.exec(`
          CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
          CREATE TABLE notes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id),
            title      TEXT NOT NULL,
            body       TEXT NOT NULL DEFAULT '',
            ${column},
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
        before.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(1, "Оля");
        before
          .prepare("INSERT INTO notes (user_id, title) VALUES (?, ?)")
          .run(1, "Нотатка з дрейфової бази");
        before.close();

        // Assigned inside the callback so that if the guard ever waves this
        // schema through again, the handle is still closed in the finally and
        // the report shows this assertion rather than an EPERM from rmSync.
        expect(() => {
          opened = createDb(file);
        }).toThrow(/expected INTEGER NOT NULL/);

        // Refusing is not the same as repairing: nothing was dropped or rewritten.
        after = new Database(file, { readonly: true });
        expect(after.prepare("SELECT title FROM notes").all()).toEqual([
          { title: "Нотатка з дрейфової бази" },
        ]);
      } finally {
        opened?.close();
        after?.close();
        // On Windows this also proves createDb closed its own handle before
        // throwing: a leaked one keeps the file locked and rmSync fails.
        for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
      }
    });
  });
});

// From the authorization review: the principal itself was never validated, and
// anything that threw answered in Express's HTML with a stack trace in it.
describe("the caller must name a user that exists", () => {
  it("refuses an x-user-id that is not a seeded user", async () => {
    await request(app).get("/api/notes").set("x-user-id", "999").expect(401);
  });

  it("does not turn an unknown user into a 500 on the write path", async () => {
    const res = await request(app)
      .post("/api/notes")
      .set("x-user-id", "999")
      .send({ title: "привид" })
      .expect(401);
    expect(res.text).not.toMatch(/SqliteError|node_modules/);
  });

  it("refuses non-canonical spellings of a user id", async () => {
    for (const spelling of ["0x1", "1e0", "+1", "1.0", "01", "100000000000000000000"]) {
      await request(app).get("/api/notes").set("x-user-id", spelling).expect(401);
    }
  });
});

describe("errors do not describe the server", () => {
  it("answers a malformed JSON body with JSON, not a stack trace", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1/archive"))
      .set("content-type", "application/json")
      .send("{nope")
      .expect(400);
    expect(res.text).not.toMatch(/node_modules|SyntaxError|at JSON/);
    expect(res.body.error).toBe("malformed JSON body");
  });

  it("answers an unknown path under /api with JSON", async () => {
    const res = await asOlya(request(app).get("/api/nope")).expect(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  // The two cases above each hit a named branch of the error handler. This one
  // hits the catch-all — the branch that exists so a real crash does not ship
  // Express's HTML page with the stack trace in it.
  it("answers an unexpected failure with JSON, not a stack trace", async () => {
    // A database that has gone away is the simplest real failure to provoke:
    // the very first query, the user lookup, throws.
    const db = createDb(":memory:");
    const broken = createApp(db);
    db.close();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await asOlya(request(broken).get("/api/notes")).expect(500);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(res.body).toEqual({ error: "internal error" });
      expect(res.text).not.toMatch(/node_modules|file:\/\/|[A-Z]:\\|\bat \w/);
      expect(logged).toHaveBeenCalled(); // the detail goes to the log, not the wire
    } finally {
      logged.mockRestore();
    }
  });
});

// The list endpoint's contract, after the review widened it: a third value for
// "both lists", and a misspelled parameter that used to be a silent 200.
describe("GET /api/notes — the query contract", () => {
  it("returns both lists for archived=all", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive")).send({ archived: true });

    const all = await asOlya(request(app).get("/api/notes?archived=all")).expect(200);
    expect(all.body.map((n) => n.id)).toEqual([1, 2]);
    expect(all.body.map((n) => n.archived)).toEqual([true, false]);
  });

  it("still scopes archived=all to the caller", async () => {
    const res = await asOlya(request(app).get("/api/notes?archived=all")).expect(200);
    expect(JSON.stringify(res.body)).not.toContain("пароль від сейфа");
  });

  it("refuses a misspelled parameter instead of quietly answering 200", async () => {
    await asOlya(request(app).get("/api/notes?ARCHIVED=1")).expect(400);
    await asOlya(request(app).get("/api/notes?foo=bar")).expect(400);
  });
});

describe("archived crosses the wire as a boolean, in both directions", () => {
  it("accepts a boolean and returns a boolean", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1/archive"))
      .send({ archived: true })
      .expect(200);
    expect(res.body.archived).toBe(true);

    const list = await asOlya(request(app).get("/api/notes?archived=1")).expect(200);
    expect(list.body[0].archived).toBe(true);

    const one = await asOlya(request(app).get("/api/notes/1")).expect(200);
    expect(one.body.archived).toBe(true);

    const created = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Нова" })
      .expect(201);
    expect(created.body.archived).toBe(false);
  });
});

describe("a path that exists but a verb that does not", () => {
  it("answers 405 with Allow, not 404", async () => {
    const res = await asOlya(request(app).put("/api/notes/1/archive"))
      .send({ archived: true })
      .expect(405);
    expect(res.headers.allow).toBe("PATCH");
  });
});
