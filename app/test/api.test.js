import { describe, it, expect, beforeEach } from "vitest";
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

describe("authentication", () => {
  it("rejects a request with no user header", async () => {
    await request(app).get("/api/notes").expect(401);
  });
});

describe("GET /api/notes", () => {
  it("returns only the caller's own notes", async () => {
    const res = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((n) => n.title)).toEqual([
      "Список покупок",
      "Ідеї для відпустки",
    ]);
  });

  it("gives a different user a different list", async () => {
    const res = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("POST /api/notes", () => {
  it("creates a note owned by the caller", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Нова", body: "текст" })
      .expect(201);
    expect(res.body.title).toBe("Нова");

    const list = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(list.body).toHaveLength(3);
  });

  it("rejects an empty title", async () => {
    await asOlya(request(app).post("/api/notes")).send({ title: "  " }).expect(400);
  });

  // Mass assignment: the body carries fields the form never sends. They are
  // refused rather than silently dropped — one rule for every write in this
  // API — because a 201 would confirm a `user_id` the server never honoured.
  // The follow-up assertions read both users' lists rather than trusting the
  // response body.
  it("will not let the request body choose the owner or the archive flag", async () => {
    const res = await asOlya(request(app).post("/api/notes"))
      .send({ title: "Підкинута", body: "", user_id: 2, id: 999, archived: 1 })
      .expect(400);
    expect(res.body.error).toMatch(/unexpected fields/);

    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.title)).not.toContain("Підкинута");
    const olya = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(olya.body.map((n) => n.title)).not.toContain("Підкинута");
  });

  it("rejects a title longer than the server allows", async () => {
    await asOlya(request(app).post("/api/notes"))
      .send({ title: "б".repeat(201) })
      .expect(400);
  });

  it("rejects a body longer than the server allows", async () => {
    await asOlya(request(app).post("/api/notes"))
      .send({ title: "Довга", body: "б".repeat(10_001) })
      .expect(400);
  });
});

describe("GET /api/notes/:id", () => {
  it("returns the caller's own note", async () => {
    const res = await asOlya(request(app).get("/api/notes/1")).expect(200);
    expect(res.body.title).toBe("Список покупок");
  });

  it("404s for a note that does not exist", async () => {
    await asOlya(request(app).get("/api/notes/999")).expect(404);
  });

  // The authorization question on the READ path. The suite already asked it
  // for DELETE ("will not delete someone else's note") and stayed green while
  // this endpoint handed Тарас's note to anyone who knew the id.
  it("will not read someone else's note", async () => {
    const res = await asOlya(request(app).get("/api/notes/3")).expect(404);
    // Status alone is not enough: assert the private content never shipped.
    // The string below is synthetic seed data from db.js, not a real secret —
    // here it is a canary, so a leak in any shape makes this test fail.
    expect(JSON.stringify(res.body)).not.toContain("пароль від сейфа");
  });

  it("does not hand back the owner column", async () => {
    const res = await asOlya(request(app).get("/api/notes/1")).expect(200);
    expect(res.body).not.toHaveProperty("user_id");
    expect(Object.keys(res.body).sort()).toEqual([
      "archived",
      "body",
      "created_at",
      "id",
      "title",
    ]);
  });

  it("rejects an id that is not a positive integer", async () => {
    await asOlya(request(app).get("/api/notes/abc")).expect(400);
  });
});

describe("DELETE /api/notes/:id", () => {
  it("deletes the caller's own note", async () => {
    await asOlya(request(app).delete("/api/notes/1")).expect(204);
    const list = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("will not delete someone else's note", async () => {
    await asOlya(request(app).delete("/api/notes/3")).expect(404);
    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body).toHaveLength(1);
  });
});

describe("PATCH /api/notes/:id/archive", () => {
  it("archives the caller's own note and takes it out of the active list", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1/archive"))
      .send({ archived: true })
      .expect(200);
    expect(res.body.archived).toBe(true);

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(active.body.map((n) => n.id)).toEqual([2]);
  });

  it("brings a note back from the archive", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive")).send({ archived: true });
    await asOlya(request(app).patch("/api/notes/1/archive"))
      .send({ archived: false })
      .expect(200);

    const active = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(active.body.map((n) => n.id)).toEqual([1, 2]);
  });

  it("will not archive someone else's note", async () => {
    await asOlya(request(app).patch("/api/notes/3/archive"))
      .send({ archived: true })
      .expect(404);

    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });

  it("rejects a flag that is not a boolean", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive")).send({ archived: "yes" }).expect(400);
  });

  it("rejects a missing body", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive")).expect(400);
  });

  it("rejects an id that is not a positive integer", async () => {
    await asOlya(request(app).patch("/api/notes/abc/archive"))
      .send({ archived: true })
      .expect(400);
  });

  // Mass assignment on the write path: `user_id` in the body must not become
  // part of the UPDATE. Refused outright, and the note stays where it was.
  it("refuses a body carrying fields it did not ask for", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive"))
      .send({ archived: true, user_id: 2 })
      .expect(400);

    const olya = await asOlya(request(app).get("/api/notes")).expect(200);
    expect(olya.body.map((n) => n.id)).toEqual([1, 2]);
    const taras = await asTaras(request(app).get("/api/notes")).expect(200);
    expect(taras.body.map((n) => n.id)).toEqual([3]);
  });

  it("does not hand back the owner column", async () => {
    const res = await asOlya(request(app).patch("/api/notes/1/archive"))
      .send({ archived: true })
      .expect(200);
    expect(res.body).not.toHaveProperty("user_id");
  });
});

describe("GET /api/notes?archived=1", () => {
  it("lists the archive apart from the active notes", async () => {
    await asOlya(request(app).patch("/api/notes/1/archive")).send({ archived: true });

    const archived = await asOlya(request(app).get("/api/notes?archived=1")).expect(200);
    expect(archived.body.map((n) => n.title)).toEqual(["Список покупок"]);
  });

  it("rejects a value that is neither 0 nor 1", async () => {
    await asOlya(request(app).get("/api/notes?archived=maybe")).expect(400);
  });
});

// Slide 38: the schema change has to be a migration, not a silent edit to
// CREATE TABLE — an existing notes.db must survive the code update. The
// in-memory tests never exercise that path, because they always start from
// the new schema.
describe("archive migration over an existing database", () => {
  it("adds the column to a pre-feature database without touching its rows", () => {
    const file = join(tmpdir(), `ws08-migration-${process.pid}-${Date.now()}.db`);
    let db;
    try {
      // The schema exactly as it was before the archive feature: no `archived`.
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
      before.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(1, "Оля");
      before
        .prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)")
        .run(1, "Нотатка з минулої версії", "написана до фічі");
      before.close();

      db = createDb(file); // runs the migration
      const rows = db.prepare("SELECT title, body, archived FROM notes").all();
      expect(rows).toEqual([
        { title: "Нотатка з минулої версії", body: "написана до фічі", archived: 0 },
      ]);

      // And the migrated database serves the feature like any other.
      const list = db
        .prepare("SELECT id FROM notes WHERE user_id = ? AND archived = ?")
        .all(1, 0);
      expect(list).toHaveLength(1);

      // The migrated column carries the same invariant as a freshly created
      // one, rather than quietly being the looser version of the schema.
      expect(() => db.prepare("UPDATE notes SET archived = 7").run()).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      // close() belongs here, not in the try: a failing assertion above would
      // otherwise skip it, and rmSync on a still-open handle throws EPERM on
      // Windows — which then replaces the real assertion error in the report.
      db?.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    }
  });
});
