import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { handleUserReply } from './study-nudge.js';

let _client = null;
let _ready = false;

export function getDiscordClient() {
  return _client;
}

export function isBotReady() {
  return _ready;
}

export async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[discord-bot] DISCORD_BOT_TOKEN not set — bot disabled.');
    return;
  }

  _client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  _client.once('ready', () => {
    _ready = true;
    console.log(`[discord-bot] Logged in as ${_client.user.tag}`);
  });

  _client.on('messageCreate', async (message) => {
    // Only process DMs from non-bot users
    if (message.author.bot) return;
    if (message.channel.type !== 1 /* DM */) return;

    const discordUserId = message.author.id;
    const configuredId = process.env.DISCORD_USER_ID;
    if (configuredId && discordUserId !== configuredId) return;

    try {
      await handleUserReply({
        discordUserId,
        replyText: message.content,
        channelId: message.channel.id,
        messageId: message.id
      });
    } catch (err) {
      console.error('[discord-bot] Error handling reply:', err.message);
    }
  });

  await _client.login(token);
}

export async function sendDM(text) {
  if (!_client || !_ready) {
    console.warn('[discord-bot] Bot not ready — cannot send DM.');
    return;
  }

  const userId = process.env.DISCORD_USER_ID;
  if (!userId) {
    console.warn('[discord-bot] DISCORD_USER_ID not set — cannot send DM.');
    return;
  }

  try {
    const user = await _client.users.fetch(userId);
    const dmChannel = await user.createDM();
    return await dmChannel.send(text);
  } catch (err) {
    console.error('[discord-bot] Failed to send DM:', err.message);
  }
}
