require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || null;
const PREFIX = process.env.PREFIX || '!';
const REMINDER_AFTER_MS = 5 * 60 * 1000; // 5 minutes

if (!process.env.DISCORD_TOKEN || !API_KEY || !LOG_CHANNEL_ID) {
  console.error('❌ Missing required environment variables. Check DISCORD_TOKEN, API_KEY, and LOG_CHANNEL_ID in your .env file.');
  process.exit(1);
}

// ===== Persistent whitelist (accounts that are already approved) =====
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    return new Map();
  }
}

function saveWhitelist() {
  const obj = Object.fromEntries(whitelist);
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

const whitelist = loadWhitelist();
// whitelist.set(discordId, { username, approvedAt, approvedBy })

// ===== Persistent banned list (accounts permanently blocked from applying) =====
const BANNED_FILE = path.join(__dirname, 'banned.json');

function loadBanned() {
  try {
    const raw = fs.readFileSync(BANNED_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    return new Map();
  }
}

function saveBanned() {
  const obj = Object.fromEntries(banned);
  fs.writeFileSync(BANNED_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

const banned = loadBanned();
// banned.set(discordId, { username, bannedAt, bannedBy, reason })

// ===== Persistent history (every login attempt ever made, accepted or not) =====
const HISTORY_FILE = path.join(__dirname, 'history.json');

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

let history = loadHistory();
// history: [{ requestId, discordId, username, country, avatarUrl, createdAt, status, decidedBy, decidedAt, source }]

function addHistoryEntry(entry) {
  history.push(entry);
  // Keep the file from growing forever — cap at last 2000 entries
  if (history.length > 2000) history = history.slice(history.length - 2000);
  saveHistory();
}

function updateHistoryEntry(requestId, updates) {
  const entry = history.find((h) => h.requestId === requestId);
  if (entry) {
    Object.assign(entry, updates);
    saveHistory();
  }
}

// ===== In-memory store of pending/decided login requests (short-lived) =====
const requests = new Map();
// requests.set(requestId, { discordId, username, country, createdAt, status, messageId, reminded })

setInterval(() => {
  const now = Date.now();
  for (const [id, req] of requests.entries()) {
    if (now - req.createdAt > 1000 * 60 * 30) requests.delete(id); // remove after 30 min
  }
}, 1000 * 60 * 10);

// ===== Discord bot =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

function hasPermission(member) {
  if (!ADMIN_ROLE_ID) return true;
  return member.roles.cache.has(ADMIN_ROLE_ID);
}

// ===== Reminder: ping if a request has been pending too long =====
setInterval(async () => {
  const now = Date.now();
  for (const [requestId, req] of requests.entries()) {
    if (req.status === 'pending' && !req.reminded && now - req.createdAt > REMINDER_AFTER_MS) {
      req.reminded = true;
      try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);
        const mention = ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}>` : '@here';
        const link = req.messageId ? `https://discord.com/channels/${channel.guildId}/${LOG_CHANNEL_ID}/${req.messageId}` : '';
        await channel.send(`⏰ ${mention} A login request from **${req.username}** has been waiting for ${Math.round((now - req.createdAt) / 60000)} minutes. ${link}`);
      } catch (err) {
        console.error('Failed to send reminder:', err);
      }
    }
  }
}, 60 * 1000);

// ===== Button clicks (Accept / Reject) =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const parts = interaction.customId.split(':'); // "login:accept:<id>" or "login:reject:<id>"
  if (parts[0] !== 'login') return;

  const decision = parts[1]; // "accept" or "reject"
  const requestId = parts[2];
  const req = requests.get(requestId);

  if (!req) {
    return interaction.reply({ content: '⚠️ This login request no longer exists (it may have expired).', ephemeral: true });
  }

  if (req.status !== 'pending') {
    return interaction.reply({ content: `⚠️ This request was already **${req.status}**.`, ephemeral: true });
  }

  if (!hasPermission(interaction.member)) {
    return interaction.reply({ content: '❌ You do not have permission to approve or reject login requests.', ephemeral: true });
  }

  req.status = decision === 'accept' ? 'accepted' : 'rejected';
  req.decidedBy = interaction.user.tag;
  req.decidedAt = Date.now();

  updateHistoryEntry(requestId, {
    status: req.status,
    decidedBy: req.decidedBy,
    decidedAt: req.decidedAt,
  });

  if (decision === 'accept') {
    whitelist.set(req.discordId, {
      username: req.username,
      approvedAt: Date.now(),
      approvedBy: interaction.user.tag,
    });
    saveWhitelist();
  }

  const resultEmbed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(decision === 'accept' ? 0x57f287 : 0xed4245)
    .addFields({
      name: decision === 'accept' ? '✅ Accepted by' : '❌ Rejected by',
      value: interaction.user.tag,
    });

  await interaction.update({
    embeds: [resultEmbed],
    components: [],
  });
});

// ===== Text commands =====
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'list') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    if (whitelist.size === 0) {
      return message.reply('📋 No approved accounts yet.');
    }

    const entries = [...whitelist.entries()];
    const chunkSize = 20;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const description = chunk
        .map(([id, info], idx) => `**${i + idx + 1}.** ${info.username} — \`${id}\`\nApproved by ${info.approvedBy} • <t:${Math.floor(info.approvedAt / 1000)}:R>`)
        .join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📋 Approved Accounts (${whitelist.size} total)`)
        .setDescription(description);

      await message.channel.send({ embeds: [embed] });
    }
    return;
  }

  if (command === 'adduser') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    const discordId = args[0];
    const username = args.slice(1).join(' ') || 'Manually added';

    if (!discordId || !/^\d{15,25}$/.test(discordId)) {
      return message.reply(`⚠️ Usage: \`${PREFIX}adduser <discordId> [note]\`\nExample: \`${PREFIX}adduser 123456789012345678 John#1234\``);
    }

    whitelist.set(discordId, {
      username,
      approvedAt: Date.now(),
      approvedBy: message.author.tag,
    });
    saveWhitelist();

    addHistoryEntry({
      requestId: crypto.randomUUID(),
      discordId,
      username,
      country: 'N/A',
      avatarUrl: null,
      createdAt: Date.now(),
      status: 'accepted',
      decidedBy: message.author.tag,
      decidedAt: Date.now(),
      source: 'manual',
    });

    return message.reply(`✅ Added \`${discordId}\` (${username}) to the approved list.`);
  }

  if (command === 'removeuser') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    const discordId = args[0];
    if (!discordId || !whitelist.has(discordId)) {
      return message.reply(`⚠️ That Discord ID isn't in the approved list.`);
    }

    whitelist.delete(discordId);
    saveWhitelist();
    return message.reply(`✅ Removed \`${discordId}\` from the approved list.`);
  }

  if (command === 'stats') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    const accepted = history.filter((h) => h.status === 'accepted').length;
    const rejected = history.filter((h) => h.status === 'rejected').length;
    const pending = [...requests.values()].filter((r) => r.status === 'pending').length;
    const total = history.length;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📊 Login Approval Stats')
      .addFields(
        { name: '✅ Accepted', value: `${accepted}`, inline: true },
        { name: '❌ Rejected', value: `${rejected}`, inline: true },
        { name: '⏳ Pending now', value: `${pending}`, inline: true },
        { name: '📁 Total attempts logged', value: `${total}`, inline: false },
      );

    return message.reply({ embeds: [embed] });
  }

  if (command === 'banuser') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    const discordId = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';

    if (!discordId || !/^\d{15,25}$/.test(discordId)) {
      return message.reply(`⚠️ Usage: \`${PREFIX}banuser <discordId> [reason]\`\nExample: \`${PREFIX}banuser 123456789012345678 Repeated spam attempts\``);
    }

    // Banning overrides any prior approval
    whitelist.delete(discordId);
    saveWhitelist();

    const priorEntry = [...history].reverse().find((h) => h.discordId === discordId);
    const username = priorEntry ? priorEntry.username : 'Unknown';

    banned.set(discordId, {
      username,
      bannedAt: Date.now(),
      bannedBy: message.author.tag,
      reason,
    });
    saveBanned();

    addHistoryEntry({
      requestId: crypto.randomUUID(),
      discordId,
      username,
      country: 'N/A',
      avatarUrl: null,
      createdAt: Date.now(),
      status: 'banned',
      decidedBy: message.author.tag,
      decidedAt: Date.now(),
      source: 'manual',
    });

    return message.reply(`🚫 Banned \`${discordId}\` (${username}).\nReason: ${reason}\nThey will be auto-rejected on any future login attempt.`);
  }

  if (command === 'unbanuser') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    const discordId = args[0];
    if (!discordId || !banned.has(discordId)) {
      return message.reply(`⚠️ That Discord ID isn't currently banned.`);
    }

    banned.delete(discordId);
    saveBanned();
    return message.reply(`✅ Unbanned \`${discordId}\`. They can apply again normally.`);
  }

  if (command === 'search') {
    if (!hasPermission(message.member)) {
      return message.reply('❌ You do not have permission to use this command.');
    }

    const discordId = args[0];
    if (!discordId || !/^\d{15,25}$/.test(discordId)) {
      return message.reply(`⚠️ Usage: \`${PREFIX}search <discordId>\`\nExample: \`${PREFIX}search 123456789012345678\``);
    }

    const entries = history.filter((h) => h.discordId === discordId).sort((a, b) => a.createdAt - b.createdAt);

    if (entries.length === 0) {
      return message.reply(`📭 No history found for \`${discordId}\`.`);
    }

    const username = entries[entries.length - 1].username;
    const isWhitelisted = whitelist.has(discordId);
    const isBanned = banned.has(discordId);

    let currentStatus = '⏳ No active approval';
    if (isBanned) currentStatus = `🚫 Banned (${banned.get(discordId).reason})`;
    else if (isWhitelisted) currentStatus = '✅ Currently approved';

    const timeline = entries
      .slice(-10) // last 10 attempts
      .map((h, i) => {
        const statusEmoji = { accepted: '✅', rejected: '❌', pending: '⏳', banned: '🚫' }[h.status] || '❔';
        const decided = h.decidedBy ? ` by ${h.decidedBy}` : '';
        return `${statusEmoji} <t:${Math.floor(h.createdAt / 1000)}:f> — **${h.status}**${decided} (${h.country || 'Unknown'})`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor(isBanned ? 0xed4245 : isWhitelisted ? 0x57f287 : 0x5865f2)
      .setTitle(`🔍 Search Report — ${username}`)
      .addFields(
        { name: 'Discord ID', value: discordId, inline: true },
        { name: 'Total attempts', value: `${entries.length}`, inline: true },
        { name: 'Current status', value: currentStatus, inline: true },
        { name: `Timeline (last ${Math.min(10, entries.length)})`, value: timeline || '—', inline: false },
      );

    return message.reply({ embeds: [embed] });
  }

  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🔐 Login Approval Bot — Commands')
      .setDescription(
        `\`${PREFIX}list\` - Show all approved accounts\n` +
        `\`${PREFIX}adduser <discordId> [note]\` - Manually approve an account\n` +
        `\`${PREFIX}removeuser <discordId>\` - Remove an account from the approved list\n` +
        `\`${PREFIX}stats\` - Show accepted/rejected/pending counts\n` +
        `\`${PREFIX}search <discordId>\` - Show full history report for an account\n` +
        `\`${PREFIX}banuser <discordId> [reason]\` - Permanently block an account\n` +
        `\`${PREFIX}unbanuser <discordId>\` - Remove a ban`
      );
    return message.reply({ embeds: [embed] });
  }
});

client.login(process.env.DISCORD_TOKEN);

// ===== HTTP API =====
const app = express();
app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

app.get('/', (req, res) => {
  res.send('Login approval bot is running ✅');
});

app.post('/api/login-attempt', requireApiKey, async (req, res) => {
  const { discordId, username, country, avatarUrl } = req.body;

  if (!discordId || !username) {
    return res.status(400).json({ error: 'discordId and username are required' });
  }

  // Banned accounts are auto-rejected instantly, without bothering admins
  if (banned.has(discordId)) {
    addHistoryEntry({
      requestId: crypto.randomUUID(),
      discordId,
      username,
      country: country || 'Unknown',
      avatarUrl: avatarUrl || null,
      createdAt: Date.now(),
      status: 'rejected',
      decidedBy: 'auto (banned)',
      decidedAt: Date.now(),
      source: 'website',
    });
    return res.json({ requestId: null, status: 'rejected', banned: true });
  }

  if (whitelist.has(discordId)) {
    return res.json({ requestId: null, status: 'accepted', alreadyApproved: true });
  }

  const requestId = crypto.randomUUID();
  const createdAt = Date.now();

  requests.set(requestId, {
    discordId,
    username,
    country: country || 'Unknown',
    avatarUrl: avatarUrl || null,
    createdAt,
    status: 'pending',
    messageId: null,
    reminded: false,
  });

  addHistoryEntry({
    requestId,
    discordId,
    username,
    country: country || 'Unknown',
    avatarUrl: avatarUrl || null,
    createdAt,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    source: 'website',
  });

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🔐 New Login Attempt')
      .setThumbnail(avatarUrl || null)
      .addFields(
        { name: 'Discord Account', value: username, inline: true },
        { name: 'Discord ID', value: discordId, inline: true },
        { name: 'Country', value: country || 'Unknown', inline: true },
      )
      .setFooter({ text: `Request ID: ${requestId}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`login:accept:${requestId}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`login:reject:${requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    );

    const sentMessage = await channel.send({ embeds: [embed], components: [row] });
    const stored = requests.get(requestId);
    if (stored) stored.messageId = sentMessage.id;
  } catch (err) {
    console.error('Failed to post log message:', err);
    return res.status(500).json({ error: 'Failed to send log message to Discord' });
  }

  res.json({ requestId, status: 'pending' });
});

app.get('/api/login-attempt/:requestId', requireApiKey, (req, res) => {
  const request = requests.get(req.params.requestId);
  if (!request) {
    return res.status(404).json({ error: 'Request not found (it may have expired)' });
  }
  res.json({
    status: request.status,
    discordId: request.discordId,
    username: request.username,
    country: request.country,
    decidedBy: request.decidedBy || null,
  });
});

app.get('/api/check/:discordId', requireApiKey, (req, res) => {
  const approved = whitelist.has(req.params.discordId);
  res.json({ approved });
});

app.listen(PORT, () => {
  console.log(`🌐 API server running on port ${PORT}`);
});
