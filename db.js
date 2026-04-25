import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "reminders.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT    NOT NULL,
    channel_id  TEXT    NOT NULL,
    created_by  TEXT    NOT NULL,
    mention_id  TEXT    NOT NULL,
    reminder    TEXT    NOT NULL,
    remind_at   INTEGER NOT NULL,
    recurring   INTEGER NOT NULL DEFAULT 0,
    bomb        INTEGER NOT NULL DEFAULT 0,
    sent        INTEGER NOT NULL DEFAULT 0
  )
`);

const columns = db.prepare(`PRAGMA table_info(reminders)`).all();
const hasSourceInteractionId = columns.some((column) => column.name === "source_interaction_id");

if (!hasSourceInteractionId) {
  db.exec(`ALTER TABLE reminders ADD COLUMN source_interaction_id TEXT`);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS reminders_source_interaction_id_unique
  ON reminders(source_interaction_id)
`);

export function addReminder({
  guild_id,
  channel_id,
  created_by,
  mention_id,
  reminder,
  remind_at,
  recurring,
  bomb,
  source_interaction_id,
}) {
  return db
    .prepare(
      `INSERT INTO reminders (
         guild_id,
         channel_id,
         created_by,
         mention_id,
         reminder,
         remind_at,
         recurring,
         bomb,
         source_interaction_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_interaction_id) DO NOTHING`
    )
    .run(
      guild_id,
      channel_id,
      created_by,
      mention_id,
      reminder,
      remind_at,
      recurring ? 1 : 0,
      bomb ? 1 : 0,
      source_interaction_id
    );
}

export function getAllActiveReminders() {
  return db
    .prepare(`SELECT * FROM reminders ORDER BY remind_at ASC`)
    .all();
}

export function getReminderById(id) {
  return db
    .prepare(`SELECT * FROM reminders WHERE id = ?`)
    .get(id);
}

export function getActiveReminders(guild_id, created_by = null) {
  if (created_by) {
    return db
      .prepare(
        `SELECT * FROM reminders
         WHERE guild_id = ? AND created_by = ?
         ORDER BY remind_at ASC`
      )
      .all(guild_id, created_by);
  }

  return db
    .prepare(
      `SELECT * FROM reminders
       WHERE guild_id = ?
       ORDER BY remind_at ASC`
    )
    .all(guild_id);
}

export function deleteReminder(id, guild_id) {
  return db
    .prepare(`DELETE FROM reminders WHERE id = ? AND guild_id = ?`)
    .run(id, guild_id);
}

export function deleteReminderById(id) {
  return db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
}

export function reschedule(id, nextRemindAt) {
  return db.prepare(`UPDATE reminders SET remind_at = ? WHERE id = ?`).run(nextRemindAt, id);
}
