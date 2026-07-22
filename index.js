// ============================================================
//  بوت سحب المواطنين من روم الانتظار إلى روم الإداري
// ============================================================
// الفكرة:
//  1) فيه روم واحد "روم الانتظار" يجلس فيه المواطنين اللي يبون مساعدة.
//  2) لما إداري (عنده الرتبة المحددة) يدخل روم صوتي ويكون "لحاله" فيه
//     (ما فيه أحد ثاني) -> يصير مؤهل يتسحب له مواطن.
//  3) البوت يدور على أول شخص بروم الانتظار مو حاطّ ميوت أو ديفن
//     (لا سيلف ولا سيرفر) ويسحبه لروم الإداري تلقائيًا.
//  4) اللي حاطين ميوت/ديفن يتم تجاوزهم (ما ينسحبون).
//  5) فيه أمر /سحب يقدر الإداري يستخدمه يدوي لو حب يسحب هو بنفسه.
// ============================================================

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
  ADMIN_CATEGORY_ID,
  CITIZEN_ROLE_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ لازم تعبي BOT_TOKEN و GUILD_ID و WAITING_CHANNEL_ID و ADMIN_ROLE_ID في ملف .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// لمنع تكرار السحب لنفس الروم بنفس اللحظة (debounce بسيط)
const pullLocks = new Set();

/**
 * يتحقق هل العضو حاطّ ميوت أو ديفن (سواء بنفسه أو من السيرفر)
 */
function isMutedOrDeafened(voiceState) {
  return (
    voiceState.selfMute ||
    voiceState.selfDeaf ||
    voiceState.serverMute ||
    voiceState.serverDeaf
  );
}

/**
 * يرجع أول عضو مؤهل بروم الانتظار (مو ميوت/ديفن)
 */
function getNextEligibleWaitingMember(guild) {
  const waitingChannel = guild.channels.cache.get(WAITING_CHANNEL_ID);
  if (!waitingChannel || !waitingChannel.members) return null;

  for (const [, member] of waitingChannel.members) {
    // لو محدد رتبة مواطن، لازم العضو يكون عنده هالرتبة عشان يصير مؤهل
    if (CITIZEN_ROLE_ID && !member.roles.cache.has(CITIZEN_ROLE_ID)) continue;

    const vs = member.voice;
    if (!isMutedOrDeafened(vs)) {
      return member;
    }
  }
  return null;
}

/**
 * يتحقق هل قناة صوتية معينة هي "روم إداري فاضي":
 * فيها إداري واحد بس (لحاله) وما فيها غيره
 */
function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2 /* GuildVoice */) return false;
  if (ADMIN_CATEGORY_ID && channel.parentId !== ADMIN_CATEGORY_ID) return false;
  if (channel.id === WAITING_CHANNEL_ID) return false;

  const members = [...channel.members.values()];
  if (members.length !== 1) return false;

  const onlyMember = members[0];
  return onlyMember.roles.cache.has(ADMIN_ROLE_ID);
}

/**
 * يسوي عملية السحب: يدور على كل الرومات، يلقى أي روم إداري فاضي،
 * ويسحب له أول مواطن مؤهل من روم الانتظار.
 */
async function tryPullForAllFreeAdmins(guild) {
  const voiceChannels = guild.channels.cache.filter((c) => c.type === 2);

  for (const [, channel] of voiceChannels) {
    if (!isFreeAdminRoom(channel)) continue;
    if (pullLocks.has(channel.id)) continue;

    const candidate = getNextEligibleWaitingMember(guild);
    if (!candidate) continue; // ما فيه أحد مؤهل بروم الانتظار

    pullLocks.add(channel.id);
    try {
      await candidate.voice.setChannel(channel.id, 'سحب تلقائي لمواطن إلى إداري فاضي');
      console.log(`✅ تم سحب ${candidate.user.tag} إلى روم ${channel.name}`);
    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

// ============================================================
// أحداث البوت
// ============================================================

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
});

// أي تغيير بالحالة الصوتية (دخول/خروج/ميوت/ديفن) يعيد فحص الأدوار
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  try {
    await tryPullForAllFreeAdmins(guild);
  } catch (err) {
    console.error('خطأ أثناء محاولة السحب:', err);
  }
});

// ============================================================
// أمر /سحب — يسحب الإداري نفسه مواطن يدويًا
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'سحب') return;

  const member = interaction.member;

  if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
    return interaction.reply({
      content: '❌ هذا الأمر خاص بالإداريين بس.',
      ephemeral: true,
    });
  }

  const voiceState = member.voice;
  if (!voiceState.channelId) {
    return interaction.reply({
      content: '❌ لازم تكون داخل روم صوتي عشان تستخدم الأمر.',
      ephemeral: true,
    });
  }

  const channel = voiceState.channel;
  const membersInChannel = [...channel.members.values()];
  if (membersInChannel.length > 1) {
    return interaction.reply({
      content: '❌ لازم تكون لحالك بالروم عشان ينسحب لك مواطن.',
      ephemeral: true,
    });
  }

  const candidate = getNextEligibleWaitingMember(interaction.guild);
  if (!candidate) {
    return interaction.reply({
      content: 'ℹ️ ما فيه أحد مؤهل حاليًا بروم الانتظار (يمكن الكل حاطين ميوت/ديفن أو الروم فاضي).',
      ephemeral: true,
    });
  }

  try {
    await candidate.voice.setChannel(channel.id, `سحب يدوي بواسطة ${member.user.tag}`);
    return interaction.reply({
      content: `✅ تم سحب <@${candidate.id}> إلى روومك.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error(err);
    return interaction.reply({
      content: '⚠️ صار خطأ أثناء محاولة السحب. تأكد إن البوت عنده صلاحية Move Members.',
      ephemeral: true,
    });
  }
});
