import "dotenv/config";

const required = (name) => {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
};

export const DISCORD_TOKEN = required("DISCORD_TOKEN");
export const DISCORD_CLIENT_ID = required("DISCORD_CLIENT_ID");
export const COMMAND_GUILD_IDS = required("COMMAND_GUILD_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const SEND_CHANNEL_ID = required("SEND_CHANNEL_ID");
export const ANNOUNCE_CHANNEL_ID = required("ANNOUNCE_CHANNEL_ID");
export const PRIVILEGED_VIEWER_ID = required("PRIVILEGED_VIEWER_ID");

export const TIMEZONE = "Asia/Manila";
