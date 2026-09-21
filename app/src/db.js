import Database from "better-sqlite3";

/**
 * Schema + seed data. In-memory by default so tests are isolated and nobody
 * has to run a migration to get started; `server.js` uses a file so the UI
 * keeps its data between restarts.
 *
 * Everything here is synthetic.
 */
export function createDb(file = ":memory:") {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      title     TEXT NOT NULL,
      body      TEXT NOT NULL DEFAULT '',
      archived  INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration for a notes.db created before the archive feature. ADD COLUMN
  // is additive: existing rows keep their data and get the default, so no
  // table is rewritten and nothing is dropped. Guarded by table_info, so it
  // runs once and a fresh database (which already has the column from the
  // CREATE TABLE above) skips it. The CHECK is repeated here on purpose —
  // without it a migrated database would end up with a weaker schema than a
  // freshly created one, which is the kind of drift nobody notices locally.
  const archived = db
    .prepare("PRAGMA table_info(notes)")
    .all()
    .find((column) => column.name === "archived");

  // table_info reports type, NOT NULL and DEFAULT but not CHECK; that one is
  // only visible in the table's own CREATE statement.
  const notesSql = archived
    ? db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get().sql
    : "";
  const hasCheck = /CHECK\s*\(\s*archived\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(notesSql);

  if (!archived) {
    db.exec(
      "ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))",
    );
  } else if (
    archived.type.toUpperCase() !== "INTEGER" ||
    archived.notnull !== 1 ||
    archived.dflt_value !== "0" ||
    !hasCheck
  ) {
    // "A column called archived exists" is not "the column we meant". A
    // database that got one from an earlier iteration can carry TEXT, or allow
    // NULL — and then `WHERE archived = 0` matches nothing, every note falls
    // out of both lists, and the app reports an empty archive and an empty
    // active list with no error anywhere. Without DEFAULT 0 every insert fails
    // NOT NULL (the INSERT never names the column); without the CHECK any
    // integer gets in. Refuse to start on a schema we cannot reason about
    // rather than silently showing the user nothing or failing on first write.
    // Close first: the caller never receives this handle, so nobody else can
    // close it, and on Windows an open handle keeps the file locked.
    db.close();
    const found = [
      archived.type,
      archived.notnull ? "NOT NULL" : "NULL",
      archived.dflt_value === null ? "no DEFAULT" : `DEFAULT ${archived.dflt_value}`,
      hasCheck ? "CHECK" : "no CHECK",
    ].join(" ");
    throw new Error(
      `notes.archived is ${found}, expected INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)). ` +
        "This database predates the current schema and needs migrating by hand.",
    );
  }

  // After the column is guaranteed to exist. Both list queries filter on
  // exactly this pair and order by id, and neither had an index to use — on
  // three seeded rows a full scan is instant, which is why it is easy to ship.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_notes_user_archived ON notes (user_id, archived, id)",
  );

  // All of it or none of it. The guard below keys on the `users` table, which
  // is also the first thing the seed writes: interrupt it halfway and the next
  // start sees a non-empty `users`, calls the database seeded, and leaves it
  // permanently short of Тарас and every note.
  const seeded = db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
  if (!seeded) {
    db.transaction(() => {
      db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(1, "Оля");
      db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(2, "Тарас");
      const ins = db.prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)");
      ins.run(1, "Список покупок", "хліб, кава");
      ins.run(1, "Ідеї для відпустки", "Карпати восени");
      ins.run(2, "Приватна нотатка Тараса", "пароль від сейфа: 1234");
    })();
  }

  return db;
}
