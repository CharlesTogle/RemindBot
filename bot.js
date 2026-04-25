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
import { addReminder, deleteReminder, deleteReminderById, deleteSentReminders, getActiveReminders, getDueReminders, reschedule } from "./db.js";
import { fetchMobGif } from "./gifs.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const VIEW_PAGE_SIZE = 10;

// ── helpers ───────────────────────────────────────────────────────────────────

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

  await channel.send(payload);
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

function cleanupSentReminderRecords() {
  const result = deleteSentReminders();
  if (result.changes > 0) {
    console.log(`[remind-bot] Deleted ${result.changes} sent reminder(s) from storage`);
  }
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
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), {
        body: commands.map((c) => c.toJSON()),
      });
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
    await interaction.reply({
      content: `Current time: **${manilaDate()}** (Asia/Manila)`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "view") {
    const canViewAll = interaction.user.id === PRIVILEGED_VIEWER_ID;
    const rows = getActiveReminders(interaction.guildId, canViewAll ? null : interaction.user.id);
    if (!rows.length) {
      await interaction.reply({
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

    await interaction.reply({
      content: rows.map((row) => formatReminderRow(row)).join("\n\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "delete") {
    const id = interaction.options.getInteger("id", true);
    const result = deleteReminder(id, interaction.guildId);

    await interaction.reply({
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
    await interaction.reply({
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
      await interaction.reply({ content: "Invalid time. Use HH:MM (24h).", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      await interaction.reply({ content: "Invalid date. Use YYYY-MM-DD.", flags: MessageFlags.Ephemeral });
      return;
    }

    const remindAt = manilaToUtcMs(dateStr, timeStr);
    if (isNaN(remindAt)) {
      await interaction.reply({ content: "Could not parse date/time.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (remindAt <= Date.now()) {
      await interaction.reply({ content: "That time is already in the past.", flags: MessageFlags.Ephemeral });
      return;
    }

    const mentionId = whoUser ? whoUser.id : "everyone";

    addReminder({
      guild_id: interaction.guildId,
      channel_id: SEND_CHANNEL_ID,
      created_by: interaction.user.id,
      mention_id: mentionId,
      reminder,
      remind_at: remindAt,
      recurring,
      bomb,
    });

    const mentionLabel = whoUser ? `<@${whoUser.id}>` : "@everyone";

    await interaction.reply({
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

async function checkReminders() {
  cleanupSentReminderRecords();
  const due = getDueReminders();
  for (const row of due) {
    try {
      const channel = await fetchSendChannel();

      const mention = formatMention(row.mention_id);
      const times = row.bomb ? 5 : 1;

      for (let i = 0; i < times; i++) {
        await sendReminderMessage(channel, row.reminder, mention);
      }

      if (row.recurring) {
        reschedule(row.id, row.remind_at + 24 * 60 * 60 * 1000);
      } else {
        deleteReminderById(row.id);
      }
    } catch (err) {
      console.error(`[remind-bot] Failed to fire reminder ${row.id}:`, err.message);
    }
  }
}

// ── startup ───────────────────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`[remind-bot] Online as ${client.user.tag}`);
  try {
    await registerCommands();
    cleanupSentReminderRecords();
    checkReminders();
    setInterval(checkReminders, 60_000);
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
