# RemindBot

Discord reminder bot for a single posting channel, built with `discord.js` and `better-sqlite3`.

It supports:

- `/clock` to show the current Manila time
- `/remind` to create one-time or daily recurring reminders
- `/view` to list active reminders
- `/delete` to remove a reminder by ID
- `/test` to fire a reminder immediately

Reminders are stored in SQLite and dispatched by an in-memory scheduler that tracks the next fire time with a min-heap.

## Stack

- Node.js with native ESM (`"type": "module"`)
- `discord.js` for slash commands and message sending
- `better-sqlite3` for local persistence
- `dotenv` for environment configuration

## Files

- [bot.js](/home/charles/Documents/Projects/RemindBot/bot.js): Discord client, slash command handlers, scheduler, and heap implementation
- [db.js](/home/charles/Documents/Projects/RemindBot/db.js): SQLite schema and reminder queries
- [config.js](/home/charles/Documents/Projects/RemindBot/config.js): environment loading and validation
- [gifs.js](/home/charles/Documents/Projects/RemindBot/gifs.js): Tenor lookup for optional Mob Psycho GIFs
- [.env.example](/home/charles/Documents/Projects/RemindBot/.env.example): required environment variables

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create `.env` from `.env.example`

3. Fill in the required values:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
COMMAND_GUILD_IDS=guild_id_where_slash_commands_are_used
SEND_CHANNEL_ID=channel_id_where_reminders_are_posted
PRIVILEGED_VIEWER_ID=user_id_allowed_to_view_all_reminders
```

4. Start the bot:

```bash
pnpm start
```

## Command Behavior

### `/clock`

Replies with the current time in `Asia/Manila`.

### `/remind`

Creates a reminder with:

- required `time`
- required `reminder`
- optional `date`
- optional target user mention
- optional `recurring`
- optional `bomb`
- optional `announce`

The bot stores the reminder in SQLite, then inserts the new reminder into the in-memory heap. If the new reminder is earlier than the currently scheduled one, the scheduler cancels the old timeout and schedules a new one for the earlier fire time.

### `/view`

Shows active reminders sorted by `remind_at`.

- The privileged viewer can see all reminders in the server.
- Other users only see reminders they created.

### `/delete`

Deletes the reminder from SQLite. The scheduler uses lazy deletion, so deleted reminders may remain in the heap temporarily until they reach the top, at which point they are discarded before firing.

### `/test`

Sends an immediate test reminder into the configured send channel.

## Data Model

The SQLite `reminders` table stores:

- `id`
- `guild_id`
- `channel_id`
- `created_by`
- `mention_id`
- `reminder`
- `remind_at`
- `recurring`
- `bomb`
- `sent`

Note: the current scheduler no longer uses the `sent` column. It remains in the schema as legacy data from the earlier polling design.

## Scheduler Design

### Old approach

The older scheduler used `setInterval(..., 60_000)` and periodically scanned for reminders that were due. That design is simple, but it has two problems:

- it does work every minute even when nothing should fire
- it can only be as precise as the polling interval

### Current approach

The current scheduler keeps all active reminders in a min-heap ordered by:

1. earliest `remind_at`
2. lowest `id` as a tie-breaker

At runtime it does this:

1. Load all reminders from SQLite on startup
2. Push them into the heap
3. Schedule one `setTimeout` for the heap root
4. When the timeout fires, pop and process all reminders whose `remind_at <= Date.now()`
5. Reschedule the next timeout using the new heap root

When a new reminder is created:

1. Insert into SQLite
2. Push into the heap
3. If it becomes the new root, reschedule the active timeout

When a recurring reminder fires:

1. Pop it from the heap
2. Send the reminder
3. Update its next `remind_at` in SQLite
4. Push it back into the heap

When a reminder is deleted:

1. Remove it from SQLite
2. Mark its ID as deleted in memory
3. Drop it later when it reaches the top of the heap

### Why a min-heap is used

A min-heap is a good fit because the scheduler only needs fast access to the earliest reminder.

- `peek()` is `O(1)` for the next reminder to fire
- `push()` is `O(log n)` when a reminder is added
- `pop()` is `O(log n)` when a reminder fires

Compared with minute-by-minute polling:

- polling does repeated work over wall-clock time, even when idle
- the heap approach does work only when reminders are added, deleted, retried, or fired
- the heap approach can schedule much closer to the exact target time

For this bot, that means lower unnecessary CPU work and better timing behavior as the number of reminders grows.

## Boot Flow

1. `config.js` validates environment variables
2. `bot.js` creates the Discord client
3. `clientReady` registers slash commands
4. The bot loads all active reminders from SQLite
5. The scheduler builds the heap and arms the first timeout
6. Interactions update SQLite and the heap together

## Storage and State Flow

- Persistent state lives in `reminders.db`
- In-memory scheduling state lives in the heap plus a deleted-ID set
- SQLite is the source of truth
- The heap is an execution index used to efficiently find the next reminder to fire

Before firing a reminder, the bot re-checks the database by ID so a lazily deleted reminder is skipped instead of being sent.

## Development Notes

- Start command: `pnpm start`
- There are currently no configured test, lint, or build scripts beyond startup.
- `gifs.js` uses the public Tenor demo key and falls back to text-only messages if GIF lookup fails.

## Known Limitations

- The `sent` column is legacy schema and can be removed in a future migration.
- Scheduler state is rebuilt from SQLite on process start, so reminders persist across restarts, but in-memory heap state does not.
- There is no automated test suite yet.
- The bot currently posts reminders into one configured channel via `SEND_CHANNEL_ID`.

## Repo Knowledge

- Stack and runtime: Node.js ESM app using `discord.js`, `better-sqlite3`, and `dotenv`
- Entrypoint and boot flow: `bot.js` initializes the client, registers commands, loads reminders, and starts the heap-based scheduler
- Module map: `bot.js` owns app logic, `db.js` owns persistence, `config.js` owns env loading, `gifs.js` owns Tenor integration
- Data flow: slash commands write to SQLite and update the heap; fired reminders are read back from SQLite before send
- Important conventions: all user-facing times are handled in `Asia/Manila`; reminders are stored as UTC milliseconds
- Tooling: only `pnpm start` is defined; there is no lint or test setup yet
- Risk areas: scheduler correctness around retries and recurring reminders matters most; schema cleanup is still pending for `sent`
