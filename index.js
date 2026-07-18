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

if (!process.env.DISCORD_TOKEN || !API_KEY || !LOG_CHANNEL_ID) {
  console.error('❌ Missing required environment variables. Check DISCORD_TOKEN, API_KEY, and LOG_CHANNEL_ID in your .env file.');
  process.exit(1);
}

// ===== Persistent whitelist (accounts that are already approved) =====
// Stored as a JSON file so approved accounts don't need to ask again.
// NOTE: On most free hosting plans the filesystem resets when the service is
// redeployed (not on every restart, but on new deploys). For a fully durable
// solution across redeploys, this could later be swapped for a small database.
const WHITELIST_FILE = path.join(__dirname, 'whitelist.json');

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    return new Map(); // file doesn't exist yet or is empty/corrupted
  }
}

function saveWhitelist() {
  const obj = Object.fromEntries(whitelist);
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

const whitelist = loadWhitelist();
// whitelist.set(discordId, { username, approvedAt, approvedBy })

// ===== In-memory store of pending/decided login requests =====
// This can safely stay in-memory since requests only need to live for a few minutes.
const requests = new Map();
// requests.set(requestId, { discordId, username, country, createdAt, status: 'pending' | 'accepted' | 'rejected' })

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

  // If accepted, remember this account so they won't need to ask again next time
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

// ===== Text commands: !list and !adduser =====
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
    // Discord embeds have a description length limit, so we chunk into pages of 20
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

  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🔐 Login Approval Bot — Commands')
      .setDescription(
        `\`${PREFIX}list\` - Show all approved accounts\n` +
        `\`${PREFIX}adduser <discordId> [note]\` - Manually approve an account\n` +
        `\`${PREFIX}removeuser <discordId>\` - Remove an account from the approved list`
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

// 1) Website calls this when someone tries to log in
// POST /api/login-attempt
// body: { discordId, username, country }
app.post('/api/login-attempt', requireApiKey, async (req, res) => {
  const { discordId, username, country, avatarUrl } = req.body;

  if (!discordId || !username) {
    return res.status(400).json({ error: 'discordId and username are required' });
  }

  // Already approved before? Let them straight in, no need to ask again.
  if (whitelist.has(discordId)) {
    return res.json({ requestId: null, status: 'accepted', alreadyApproved: true });
  }

  const requestId = crypto.randomUUID();
  requests.set(requestId, {
    discordId,
    username,
    country: country || 'Unknown',
    avatarUrl: avatarUrl || null,
    createdAt: Date.now(),
    status: 'pending',
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

    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Failed to post log message:', err);
    return res.status(500).json({ error: 'Failed to send log message to Discord' });
  }

  res.json({ requestId, status: 'pending' });
});

// 2) Website polls this to check the decision
// GET /api/login-attempt/:requestId
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

// 3) (Optional but handy) Website can directly check if a Discord ID is already approved
// GET /api/check/:discordId
app.get('/api/check/:discordId', requireApiKey, (req, res) => {
  const approved = whitelist.has(req.params.discordId);
  res.json({ approved });
});

app.listen(PORT, () => {
  console.log(`🌐 API server running on port ${PORT}`);
});
