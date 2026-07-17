require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
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

if (!process.env.DISCORD_TOKEN || !API_KEY || !LOG_CHANNEL_ID) {
  console.error('❌ Missing required environment variables. Check DISCORD_TOKEN, API_KEY, and LOG_CHANNEL_ID in your .env file.');
  process.exit(1);
}

// ===== In-memory store of pending/decided login requests =====
// NOTE: This resets if the process restarts. That's fine for typical usage,
// since login attempts are meant to be approved/rejected within a short window.
const requests = new Map();
// requests.set(requestId, { discordId, username, country, createdAt, status: 'pending' | 'accepted' | 'rejected' })

// Clean up old entries every 10 minutes so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of requests.entries()) {
    if (now - req.createdAt > 1000 * 60 * 30) requests.delete(id); // remove after 30 min
  }
}, 1000 * 60 * 10);

// ===== Discord bot =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, , requestId] = interaction.customId.split(':'); // "login:accept:<id>" or "login:reject:<id>"
  if (action !== 'login') return;

  const decision = interaction.customId.split(':')[1]; // "accept" or "reject"
  const req = requests.get(requestId);

  if (!req) {
    return interaction.reply({ content: '⚠️ This login request no longer exists (it may have expired).', ephemeral: true });
  }

  if (req.status !== 'pending') {
    return interaction.reply({ content: `⚠️ This request was already **${req.status}**.`, ephemeral: true });
  }

  if (ADMIN_ROLE_ID && !interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
    return interaction.reply({ content: '❌ You do not have permission to approve or reject login requests.', ephemeral: true });
  }

  req.status = decision === 'accept' ? 'accepted' : 'rejected';
  req.decidedBy = interaction.user.tag;
  req.decidedAt = Date.now();

  const resultEmbed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(decision === 'accept' ? 0x57f287 : 0xed4245)
    .addFields({
      name: decision === 'accept' ? '✅ Accepted by' : '❌ Rejected by',
      value: interaction.user.tag,
    });

  await interaction.update({
    embeds: [resultEmbed],
    components: [], // remove the buttons after a decision is made
  });
});

client.login(process.env.DISCORD_TOKEN);

// ===== HTTP API =====
const app = express();
app.use(express.json());

// Simple API key check for every request
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// Health check (also keeps hosting platforms like Railway happy)
app.get('/', (req, res) => {
  res.send('Login approval bot is running ✅');
});

// 1) Website calls this when someone tries to log in
// POST /api/login-attempt
// body: { discordId, username, country }
app.post('/api/login-attempt', requireApiKey, async (req, res) => {
  const { discordId, username, country } = req.body;

  if (!discordId || !username) {
    return res.status(400).json({ error: 'discordId and username are required' });
  }

  const requestId = crypto.randomUUID();
  requests.set(requestId, {
    discordId,
    username,
    country: country || 'Unknown',
    createdAt: Date.now(),
    status: 'pending',
  });

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🔐 New Login Attempt')
      .addFields(
        { name: 'Discord Account', value: username, inline: true },
        { name: 'Discord ID', value: discordId, inline: true },
        { name: 'Country', value: country || 'Unknown', inline: true },
        { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
      )
      .setFooter({ text: `Request ID: ${requestId}` });

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

app.listen(PORT, () => {
  console.log(`🌐 API server running on port ${PORT}`);
});
