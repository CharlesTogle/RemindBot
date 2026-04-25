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

export function addReminder({ guild_id, channel_id, created_by, mention_id, reminder, remind_at, recurring, bomb }) {
  return db
    .prepare(
      `INSERT INTO reminders (guild_id, channel_id, created_by, mention_id, reminder, remind_at, recurring, bomb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(guild_id, channel_id, created_by, mention_id, reminder, remind_at, recurring ? 1 : 0, bomb ? 1 : 0);
}

export function getDueReminders() {
  return db
    .prepare(`SELECT * FROM reminders WHERE remind_at <= ? AND sent = 0`)
    .all(Date.now());
}

export function getActiveReminders(guild_id, created_by = null) {
  if (created_by) {
    return db
      .prepare(
        `SELECT * FROM reminders
         WHERE guild_id = ? AND created_by = ? AND sent = 0
         ORDER BY remind_at ASC`
      )
      .all(guild_id, created_by);
  }

  return db
    .prepare(
      `SELECT * FROM reminders
       WHERE guild_id = ? AND sent = 0
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
  db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
}

export function deleteSentReminders() {
  return db.prepare(`DELETE FROM reminders WHERE sent = 1`).run();
}

export function reschedule(id, nextRemindAt) {
  db.prepare(`UPDATE reminders SET remind_at = ?, sent = 0 WHERE id = ?`).run(nextRemindAt, id);
}
