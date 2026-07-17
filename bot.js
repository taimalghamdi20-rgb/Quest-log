require('dotenv').config();

const express = require('express');
const cors = require('cors');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const APPROVER_ROLE_ID = process.env.APPROVER_ROLE_ID || null;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !LOG_CHANNEL_ID) {
  console.error('Missing BOT_TOKEN or LOG_CHANNEL_ID in your .env file. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// In-memory store of pending/decided requests.
// NOTE: this resets if the process restarts. For long-term history, replace
// this with a real database (SQLite, Postgres, etc.) if you need it.
const requests = new Map();

function makeRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function buildEmbed(entry, decisionInfo) {
  const embed = new EmbedBuilder()
    .addFields(
      { name: 'Discord Account', value: entry.tag, inline: true },
      { name: 'Discord ID', value: entry.discordId, inline: true },
      { name: 'Country', value: entry.country || 'Unknown', inline: true },
      { name: 'Device', value: entry.device || 'Unknown', inline: true },
      { name: 'Time', value: entry.time, inline: false }
    )
    .setFooter({ text: `Request ID: ${entry.requestId}` })
    .setTimestamp();

  if (!decisionInfo) {
    embed.setTitle('New Access Request').setColor(0xffa500); // orange = pending
  } else if (decisionInfo.action === 'accept') {
    embed.setTitle('Access Approved').setColor(0x2ecc71); // green
    embed.addFields({ name: 'Decided by', value: decisionInfo.byTag, inline: false });
  } else {
    embed.setTitle('Access Rejected').setColor(0xe74c3c); // red
    embed.addFields({ name: 'Decided by', value: decisionInfo.byTag, inline: false });
  }

  return embed;
}

function buildButtons(requestId, disabled) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${requestId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!!disabled),
    new ButtonBuilder()
      .setCustomId(`reject_${requestId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!!disabled)
  );
  return [row];
}

// ---------- Discord client ----------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const separatorIndex = interaction.customId.indexOf('_');
  const action = interaction.customId.slice(0, separatorIndex);
  const requestId = interaction.customId.slice(separatorIndex + 1);

  if (action !== 'accept' && action !== 'reject') return;

  const entry = requests.get(requestId);
  if (!entry) {
    return interaction.reply({ content: 'This request no longer exists.', ephemeral: true });
  }

  if (entry.status !== 'pending') {
    return interaction.reply({ content: 'This request has already been decided.', ephemeral: true });
  }

  if (APPROVER_ROLE_ID && !interaction.member.roles.cache.has(APPROVER_ROLE_ID)) {
    return interaction.reply({ content: 'You do not have permission to approve or reject requests.', ephemeral: true });
  }

  entry.status = action === 'accept' ? 'approved' : 'rejected';

  const decidedEmbed = buildEmbed(entry, { action, byTag: `<@${interaction.user.id}>` });
  await interaction.update({ embeds: [decidedEmbed], components: buildButtons(requestId, true) });
});

client.login('MTQ5ODA2MTUwMTk4NTA2MzAyMg.G8tchD.X809kei7fhnbyFSak1icFycVodwqlaA3lvDMiU');

// ---------- HTTP API ----------

const app = express();
app.use(cors());
app.use(express.json());

// Called by the website right after a successful Discord OAuth login.
// Posts a pending request to the log channel and returns a requestId to poll.
app.post('/api/verify', async (req, res) => {
  const { discordId, tag, country, device } = req.body || {};

  if (!discordId || !tag) {
    return res.status(400).json({ error: 'Missing discordId or tag' });
  }

  const requestId = makeRequestId();
  const entry = {
    requestId,
    status: 'pending',
    discordId: String(discordId),
    tag: String(tag),
    country: country ? String(country) : 'Unknown',
    device: device ? String(device) : 'Unknown',
    time: new Date().toUTCString()
  };
  requests.set(requestId, entry);

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    const message = await channel.send({
      embeds: [buildEmbed(entry)],
      components: buildButtons(requestId, false)
    });
    entry.messageId = message.id;
    return res.json({ requestId });
  } catch (err) {
    console.error('Failed to post log message:', err);
    requests.delete(requestId);
    return res.status(500).json({ error: 'Failed to send log message' });
  }
});

// Called by the website every few seconds while waiting for a decision.
app.get('/api/status/:id', (req, res) => {
  const entry = requests.get(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.json({ status: entry.status });
});

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
