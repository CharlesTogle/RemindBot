import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  InteractionType,
  MessageFlags,
} from "discord.js";
import {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  COMMAND_GUILD_IDS,
  PRIVILEGED_VIEWER_ID,
  SEND_CHANNEL_ID,
  TIMEZONE,
} from "./config.js";
import {
  addReminder,
  deleteReminder,
  deleteReminderById,
  getActiveReminders,
  getAllActiveReminders,
  getReminderById,
  reschedule,
} from "./db.js";
import { fetchMobGif } from "./gifs.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const VIEW_PAGE_SIZE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const RETRY_DELAY_MS = 60_000;

class MinHeap {
  constructor(compare) {
    this.compare = compare;
    this.items = [];
  }

  peek() {
    return this.items[0] ?? null;
  }

  push(value) {
    this.items.push(value);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return first;
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.items[index], this.items[parent]) >= 0) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  sinkDown(index) {
    const { items } = this;

    while (true) {
      let smallest = index;
      const left = index * 2 + 1;
      const right = index * 2 + 2;

      if (left < items.length && this.compare(items[left], items[smallest]) < 0) {
        smallest = left;
      }
      if (right < items.length && this.compare(items[right], items[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) break;

      [items[index], items[smallest]] = [items[smallest], items[index]];
      index = smallest;
    }
  }
}

const reminderHeap = new MinHeap((a, b) => {
  if (a.remind_at !== b.remind_at) {
    return a.remind_at - b.remind_at;
  }
  return a.id - b.id;
});

const deletedReminderIds = new Set();
let scheduledReminderId = null;
let scheduledFireTime = null;
let schedulerTimer = null;

// ── helpers ───────────────────────────────────────────────────────────────────

async function withRetry(fn, { retries = 3, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.httpStatus;
      if (status === 502 && attempt < retries) {
        console.warn(`[remind-bot] 502 from Discord, retrying (${attempt}/${retries})...`);
        await new Promise((res) => setTimeout(res, delayMs * attempt));
        continue;
      }
      throw err;
    }
  }
}

function manilaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** Convert YYYY-MM-DD + HH:MM (Asia/Manila) to UTC Unix ms */
function manilaToUtcMs(dateStr, timeStr) {
  // Build an ISO-like string then let Intl resolve Manila offset
  const isoLocal = `${dateStr}T${timeStr}:00`;

  // Use a hack: format a known UTC date in Manila time, binary-search the offset
  // Simpler: use the offset from Intl
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Approximate UTC by subtracting +8 offset (Manila is always UTC+8)
  const [datePart, timePart] = isoLocal.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  // UTC+8 means Manila time = UTC + 8h, so UTC = Manila - 8h
  const utcMs = Date.UTC(year, month - 1, day, hour - 8, minute, 0);
  return utcMs;
}

function formatFireTime(remind_at) {
  return manilaDate(new Date(remind_at));
}

function getTodayInManila(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatMention(mentionId) {
  return mentionId === "everyone" ? "@everyone" : `<@${mentionId}>`;
}

async function sendReminderMessage(channel, message, mention = "@everyone") {
  const gifUrl = await fetchMobGif().catch(() => null);
  const payload = {
    content: `${mention} ${message}`,
  };

  if (gifUrl) {
    payload.embeds = [{ image: { url: gifUrl } }];
  }

  await withRetry(() => channel.send(payload));
}

async function safeReply(interaction, payload) {
  try {
    await interaction.reply(payload);
  } catch (err) {
    if (err?.code === 40060 || err?.code === 10062) {
      console.warn(
        `[remind-bot] Ignoring duplicate interaction reply for ${interaction.id}: ${err.code}`
      );
      return;
    }
    throw err;
  }
}

function formatReminderRow(row) {
  return [
    `**ID:** \`${row.id}\``,
    `**Next:** ${formatFireTime(row.remind_at)}`,
    `**Created by:** ${formatMention(row.created_by)}`,
    `**Mention:** ${formatMention(row.mention_id)}`,
    `**Recurring:** ${row.recurring ? "yes" : "no"}`,
    `**Bomb:** ${row.bomb ? "yes" : "no"}`,
    `**Message:** ${row.reminder}`,
  ].join("\n");
}

function padCell(value, width) {
  return String(value).padEnd(width, " ");
}

function makeReminderTable(rows) {
  const headers = ["ID", "Next", "Creator", "Mention", "Recurring", "Bomb", "Message"];
  const tableRows = rows.map((row) => [
    row.id,
    formatFireTime(row.remind_at),
    row.created_by,
    row.mention_id,
    row.recurring ? "yes" : "no",
    row.bomb ? "yes" : "no",
    row.reminder,
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...tableRows.map((row) => String(row[i]).length))
  );

  const headerLine = headers.map((header, i) => padCell(header, widths[i])).join(" | ");
  const dividerLine = widths.map((width) => "-".repeat(width)).join("-|-");
  const bodyLines = tableRows.map((row) => row.map((cell, i) => padCell(cell, widths[i])).join(" | "));
  return ["```text", headerLine, dividerLine, ...bodyLines, "```"].join("\n");
}

async function replyWithReminderPages(interaction, rows) {
  const pages = [];
  for (let i = 0; i < rows.length; i += VIEW_PAGE_SIZE) {
    const slice = rows.slice(i, i + VIEW_PAGE_SIZE);
    pages.push(`**Page ${pages.length + 1}/${Math.ceil(rows.length / VIEW_PAGE_SIZE)}**\n${makeReminderTable(slice)}`);
  }

  await interaction.reply({
    content: pages[0],
    flags: MessageFlags.Ephemeral,
  });

  for (let i = 1; i < pages.length; i++) {
    await interaction.followUp({
      content: pages[i],
      flags: MessageFlags.Ephemeral,
    });
  }
}

function clearSchedulerTimer() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  scheduledReminderId = null;
  scheduledFireTime = null;
}

function pruneDeletedReminders() {
  while (true) {
    const nextReminder = reminderHeap.peek();
    if (!nextReminder || !deletedReminderIds.has(nextReminder.id)) {
      return;
    }

    reminderHeap.pop();
    deletedReminderIds.delete(nextReminder.id);
  }
}

function scheduleNextReminder() {
  clearSchedulerTimer();
  pruneDeletedReminders();

  const nextReminder = reminderHeap.peek();
  if (!nextReminder) return;

  scheduledReminderId = nextReminder.id;
  scheduledFireTime = nextReminder.remind_at;

  const delay = Math.max(0, nextReminder.remind_at - Date.now());
  schedulerTimer = setTimeout(fireNextReminders, Math.min(delay, MAX_TIMEOUT_MS));
}

function addToScheduler(reminder) {
  reminderHeap.push(reminder);

  const currentTop = reminderHeap.peek();
  if (
    currentTop &&
    (scheduledReminderId === null ||
      currentTop.id !== scheduledReminderId ||
      currentTop.remind_at !== scheduledFireTime)
  ) {
    scheduleNextReminder();
  }
}

function removeFromScheduler(id) {
  deletedReminderIds.add(id);
  scheduleNextReminder();
}

function getNextRecurringTime(remindAt, now = Date.now()) {
  let next = remindAt + DAY_MS;
  while (next <= now) {
    next += DAY_MS;
  }
  return next;
}

// ── slash commands ────────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("clock")
    .setDescription("Show current time in Asia/Manila"),

  new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a reminder")
    .addStringOption((opt) =>
      opt.setName("time").setDescription("Time in HH:MM (24h, Asia/Manila)").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("reminder").setDescription("What to remind about").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("date").setDescription("Date in YYYY-MM-DD (default: today)").setRequired(false)
    )
    .addUserOption((opt) =>
      opt.setName("who").setDescription("Who to mention (default: @everyone)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("recurring").setDescription("Repeat daily at the same time (default: false)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName("bomb").setDescription("Send the reminder 5 times (default: false)").setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("announce")
        .setDescription("Show the confirmation to everyone (default: false)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Fire a test reminder immediately in this channel")
    .addBooleanOption((opt) =>
      opt.setName("bomb").setDescription("Send it 5 times (default: false)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("view")
    .setDescription("View all active reminders in this server"),

  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete a reminder by ID")
    .addIntegerOption((opt) =>
      opt.setName("id").setDescription("Reminder ID from /view").setRequired(true)
    ),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  for (const guildId of COMMAND_GUILD_IDS) {
    try {
      await withRetry(() =>
        rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), {
          body: commands.map((c) => c.toJSON()),
        })
      );
      console.log(`[remind-bot] Commands registered in guild ${guildId}`);
    } catch (err) {
      if (err?.code === 50001) {
        console.error(
          `[remind-bot] Missing access while registering commands in guild ${guildId}. ` +
            `Check that COMMAND_GUILD_IDS contains server IDs, not channel IDs, and that the bot is installed in that server.`
        );
      }
      throw err;
    }
  }
}

async function fetchSendChannel() {
  const channel = await client.channels.fetch(SEND_CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error(`Configured SEND_CHANNEL_ID ${SEND_CHANNEL_ID} is not a text channel`);
  }
  return channel;
}

// ── interaction handler ───────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;

  if (interaction.commandName === "clock") {
    await safeReply(interaction, {
      content: `Current time: **${manilaDate()}** (Asia/Manila)`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "view") {
    const canViewAll = interaction.user.id === PRIVILEGED_VIEWER_ID;
    const rows = getActiveReminders(interaction.guildId, canViewAll ? null : interaction.user.id);
    if (!rows.length) {
      await safeReply(interaction, {
        content: canViewAll
          ? "No active reminders found for this server."
          : "You have no active reminders in this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (canViewAll) {
      await replyWithReminderPages(interaction, rows);
      return;
    }

    await safeReply(interaction, {
      content: rows.map((row) => formatReminderRow(row)).join("\n\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "delete") {
    const id = interaction.options.getInteger("id", true);
    const result = deleteReminder(id, interaction.guildId);
    if (result.changes) {
      removeFromScheduler(id);
    }

    await safeReply(interaction, {
      content: result.changes
        ? `Reminder \`${id}\` deleted.`
        : `No reminder found with ID \`${id}\` in this server.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "test") {
    const bomb = interaction.options.getBoolean("bomb") ?? false;
    const times = bomb ? 5 : 1;
    const sendChannel = await fetchSendChannel();
    await safeReply(interaction, {
      content: `Firing test reminder in <#${SEND_CHANNEL_ID}>...`,
      flags: MessageFlags.Ephemeral,
    });

    for (let i = 0; i < times; i++) {
      await sendReminderMessage(sendChannel, "This is a test reminder");
    }
    return;
  }

  if (interaction.commandName === "remind") {
    const timeStr = interaction.options.getString("time", true);
    const dateStr = interaction.options.getString("date") ?? getTodayInManila();
    const reminder = interaction.options.getString("reminder", true);
    const whoUser = interaction.options.getUser("who");
    const recurring = interaction.options.getBoolean("recurring") ?? false;
    const bomb = interaction.options.getBoolean("bomb") ?? false;
    const announce = interaction.options.getBoolean("announce") ?? false;

    if (!/^\d{2}:\d{2}$/.test(timeStr)) {
      await safeReply(interaction, {
        content: "Invalid time. Use HH:MM (24h).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await safeReply(interaction, {
        content: "Invalid date. Use YYYY-MM-DD.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const remindAt = manilaToUtcMs(dateStr, timeStr);
    if (isNaN(remindAt)) {
      await safeReply(interaction, {
        content: "Could not parse date/time.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (remindAt <= Date.now()) {
      await safeReply(interaction, {
        content: "That time is already in the past.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const mentionId = whoUser ? whoUser.id : "everyone";

    const result = addReminder({
      guild_id: interaction.guildId,
      channel_id: SEND_CHANNEL_ID,
      created_by: interaction.user.id,
      mention_id: mentionId,
      reminder,
      remind_at: remindAt,
      recurring,
      bomb,
      source_interaction_id: interaction.id,
    });
    if (!result.changes) {
      await safeReply(interaction, {
        content: "This reminder command was already processed.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    addToScheduler({
      id: Number(result.lastInsertRowid),
      guild_id: interaction.guildId,
      channel_id: SEND_CHANNEL_ID,
      created_by: interaction.user.id,
      mention_id: mentionId,
      reminder,
      remind_at: remindAt,
      recurring: recurring ? 1 : 0,
      bomb: bomb ? 1 : 0,
    });

    const mentionLabel = whoUser ? `<@${whoUser.id}>` : "@everyone";

    await safeReply(interaction, {
      content: [
        `Okay, Im reminding you on ${dateStr} at ${timeStr} that **${reminder}**`,
        `Mentions: ${mentionLabel}`,
        `Recurring: ${recurring ? "yes" : "no"}`,
        `Bomb: ${bomb ? "yes" : "no"}`,
        `Sending in: <#${SEND_CHANNEL_ID}>`,
      ].join("\n"),
      ...(announce ? {} : { flags: MessageFlags.Ephemeral }),
    });
    return;
  }
});

// ── scheduler ─────────────────────────────────────────────────────────────────

async function fireNextReminders() {
  clearSchedulerTimer();
  pruneDeletedReminders();

  try {
    const channel = await fetchSendChannel();

    while (true) {
      pruneDeletedReminders();

      const nextReminder = reminderHeap.peek();
      if (!nextReminder || nextReminder.remind_at > Date.now()) {
        break;
      }

      const queuedReminder = reminderHeap.pop();
      const row = getReminderById(queuedReminder.id);
      if (!row) {
        deletedReminderIds.delete(queuedReminder.id);
        continue;
      }

      try {
        const mention = formatMention(row.mention_id);
        const times = row.bomb ? 5 : 1;

        for (let i = 0; i < times; i++) {
          await sendReminderMessage(channel, row.reminder, mention);
        }

        if (row.recurring) {
          const nextRemindAt = getNextRecurringTime(row.remind_at);
          reschedule(row.id, nextRemindAt);
          reminderHeap.push({ ...row, remind_at: nextRemindAt });
        } else {
          deleteReminderById(row.id);
        }
      } catch (err) {
        reminderHeap.push({ ...row, remind_at: Date.now() + RETRY_DELAY_MS });
        console.error(`[remind-bot] Failed to fire reminder ${row.id}:`, err.message);
      }
    }
  } catch (err) {
    const nextReminder = reminderHeap.peek();
    if (nextReminder && nextReminder.remind_at <= Date.now()) {
      nextReminder.remind_at = Date.now() + RETRY_DELAY_MS;
      reminderHeap.sinkDown(0);
    }
    console.error("[remind-bot] Scheduler loop failed:", err.message);
  } finally {
    scheduleNextReminder();
  }
}

// ── startup ───────────────────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`[remind-bot] Online as ${client.user.tag}`);
  try {
    await registerCommands();
    for (const reminder of getAllActiveReminders()) {
      reminderHeap.push(reminder);
    }
    scheduleNextReminder();
  } catch (err) {
    console.error("[remind-bot] Startup failed:", err);
    client.destroy();
    process.exit(1);
  }
});

client.on("error", (err) => {
  console.error("[remind-bot] Client error:", err.message);
});

client.on("shardError", (err) => {
  console.error("[remind-bot] WebSocket error:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("[remind-bot] Unhandled rejection:", err);
  process.exit(1);
});

client.login(DISCORD_TOKEN);
