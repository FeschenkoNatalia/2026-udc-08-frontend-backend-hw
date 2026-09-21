import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Pretend session. A real app would verify a signed cookie or a JWT here;
 * that is deliberately out of scope — this workshop is about what happens
 * AFTER you know who the caller is.
 *
 * The caller identifies itself with the `x-user-id` header. Seeded users are
 * 1 (Оля) and 2 (Тарас).
 *
 * The header names a user; it does not conjure one. Without the lookup an
 * unknown id sails through here and surfaces on the first write as a
 * foreign-key crash instead of a refusal.
 */
function currentUser(db) {
  const findUser = db.prepare("SELECT id FROM users WHERE id = ?");
  return function currentUser(req, res, next) {
    const id = positiveInt(req.header("x-user-id"));
    if (id === null || !findUser.get(id)) {
      return res.status(401).json({ error: "not authenticated" });
    }
    req.userId = id;
    next();
  };
}

/**
 * A canonical positive decimal integer, or null. `Number()` on its own is a
 * JavaScript literal parser doing a strict parser's job: it also accepts
 * "0x2", "1e0", "+1", "03" and " 1 ". That gives six spellings of one id — and
 * an identity in the logs that disagrees with the one the SQL is scoped to.
 */
function positiveInt(raw) {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** A note id is a positive integer; anything else stops before it reaches SQL. */
function noteId(raw) {
  return positiveInt(raw);
}

/**
 * Keys the caller sent that this endpoint does not accept. The mirror of a
 * mass-assignment guard: the handler reads an explicit field list out of the
 * body, and this reports anything left over so it can be refused rather than
 * silently dropped.
 */
function unexpectedFields(body, allowed) {
  return Object.keys(body ?? {}).filter((key) => !allowed.includes(key));
}

/**
 * Field names come from the caller, and express.json() accepts 100KB of them.
 * Echoing the lot back — into the response and into the logs — is a free
 * amplifier, so say enough to be useful and no more.
 */
function describe(keys) {
  const shown = keys.slice(0, 5).join(", ");
  return keys.length > 5 ? `${shown} (+${keys.length - 5} more)` : shown;
}

/**
 * SQLite has no boolean type, so `archived` comes back as 0 or 1. The API
 * accepts a boolean, so it returns one too: otherwise the wire type depends on
 * what happens to be in the column, and every client writes its own cast.
 */
function toNote(row) {
  return { ...row, archived: row.archived === 1 };
}

// Long enough for any real note, short enough that a caller cannot park 100KB
// per row. The UI's maxlength is a convenience; this is the enforcement.
const MAX_TITLE = 200;
const MAX_BODY = 10_000;

export function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.static(resolve(here, "../public")));

  app.use("/api", currentUser(db));

  // Prepared once, not per request: better-sqlite3 does not cache, so building
  // these inside the handlers recompiled the same SQL on every call. Having
  // them in one place also makes the whole query surface readable at a glance.
  const COLUMNS = "id, title, body, archived, created_at";
  const q = {
    listByArchived: db.prepare(
      `SELECT ${COLUMNS} FROM notes WHERE user_id = ? AND archived = ? ORDER BY id`,
    ),
    listAll: db.prepare(`SELECT ${COLUMNS} FROM notes WHERE user_id = ? ORDER BY id`),
    one: db.prepare(`SELECT ${COLUMNS} FROM notes WHERE id = ? AND user_id = ?`),
    insert: db.prepare("INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)"),
    setArchived: db.prepare("UPDATE notes SET archived = ? WHERE id = ? AND user_id = ?"),
    remove: db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?"),
  };

  // List the caller's own notes: the active list by default, `?archived=1` for
  // the archive, `?archived=all` for both. Anything else — including a
  // misspelled parameter name — is a client error rather than a silent
  // fallback: `?ARCHIVED=1` quietly returning the active list is how a caller
  // ends up trusting a list it did not ask for.
  app.get("/api/notes", (req, res) => {
    const unknown = unexpectedFields(req.query, ["archived"]);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unexpected query parameters: ${describe(unknown)}` });
    }

    const wanted = req.query.archived === undefined ? "0" : req.query.archived;
    if (wanted !== "0" && wanted !== "1" && wanted !== "all") {
      return res.status(400).json({ error: "archived must be 0, 1 or all" });
    }

    const rows =
      wanted === "all"
        ? q.listAll.all(req.userId)
        : q.listByArchived.all(req.userId, Number(wanted));
    res.json(rows.map(toNote));
  });

  // Read one of the caller's own notes. The owner is part of the SELECT, not
  // a check after the fact: a note belonging to somebody else matches no row,
  // so there is nothing in hand to leak by mistake. Without `AND user_id = ?`
  // this is an IDOR — any authenticated caller could read any note by id.
  // A note that exists but is not yours answers 404, the same as one that
  // does not exist: "may this user have this row" is the only question, and
  // a 403 here would confirm the id is real.
  app.get("/api/notes/:id", (req, res) => {
    const id = noteId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid id" });

    const note = q.one.get(id, req.userId);
    if (!note) return res.status(404).json({ error: "not found" });
    res.json(toNote(note));
  });

  // Create a note for the caller. `title` and `body` are read out of the body
  // one by one and the owner comes from the session, so a `user_id` or `id`
  // riding along in the request never reaches the INSERT.
  app.post("/api/notes", (req, res) => {
    // One rule for the whole API: a field the endpoint does not accept is
    // refused, never quietly dropped. Ignoring it answers 201 and lets the
    // caller believe the server stored something it did not.
    const extra = unexpectedFields(req.body, ["title", "body"]);
    if (extra.length > 0) {
      return res.status(400).json({ error: `unexpected fields: ${describe(extra)}` });
    }

    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    if (!title) return res.status(400).json({ error: "title is required" });
    if (title.length > MAX_TITLE) {
      return res.status(400).json({ error: `title must be at most ${MAX_TITLE} characters` });
    }
    if (body.length > MAX_BODY) {
      return res.status(400).json({ error: `body must be at most ${MAX_BODY} characters` });
    }

    const info = q.insert.run(req.userId, title, body);
    // Scoped by owner like every other single-row read, so the rule holds by
    // inspection rather than by reasoning about where lastInsertRowid came from.
    const created = q.one.get(info.lastInsertRowid, req.userId);
    if (!created) throw new Error("the note just inserted did not read back");
    res.status(201).json(toNote(created));
  });

  // Archive or unarchive one of the caller's own notes. The owner is part of
  // the UPDATE itself: a note that belongs to somebody else matches nothing,
  // so there is no row to read and nothing to leak.
  app.patch("/api/notes/:id/archive", (req, res) => {
    const id = noteId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid id" });

    if (typeof req.body?.archived !== "boolean") {
      return res.status(400).json({ error: "archived must be a boolean" });
    }
    // `archived` is the only writable field here, so an extra key is refused
    // rather than ignored: it means the caller expects the server to set
    // something it will not set (`user_id`, `id`, `title`), and a silent 200
    // would confirm a write that never happened.
    const extra = unexpectedFields(req.body, ["archived"]);
    if (extra.length > 0) {
      return res.status(400).json({ error: `unexpected fields: ${describe(extra)}` });
    }

    const info = q.setArchived.run(req.body.archived ? 1 : 0, id, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });

    // The UPDATE already proved ownership, so this cannot miss — but if it
    // ever did, res.json(undefined) would answer 200 with an empty body and
    // report a write that did not happen as a success.
    const updated = q.one.get(id, req.userId);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(toNote(updated));
  });

  // The path exists; the verb does not. 404 would claim otherwise.
  app.all("/api/notes/:id/archive", (req, res) =>
    res.status(405).set("Allow", "PATCH").json({ error: "method not allowed" }),
  );

  // Delete one of the caller's own notes. The owner is in the WHERE clause.
  app.delete("/api/notes/:id", (req, res) => {
    const id = noteId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid id" });

    const info = q.remove.run(id, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });

  // An unknown path under /api answers in the API's own dialect.
  app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

  // Last: anything that threw — a malformed body, a payload over the limit, a
  // constraint violation — leaves as JSON. Express's default handler puts
  // `err.stack`, absolute paths and all, straight into the response body
  // whenever NODE_ENV is not "production", which is every `npm run dev`.
  // The four-argument signature is load-bearing: Express picks error
  // middleware by arity.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "malformed JSON body" });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "body too large" });
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
