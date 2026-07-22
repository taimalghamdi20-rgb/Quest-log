// سكربت تسجيل الأوامر (يشتغل مرة وحدة، أو كل ما تعدل الأوامر)
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const { BOT_TOKEN, GUILD_ID } = process.env;

const commands = [
  new SlashCommandBuilder()
    .setName('سحب')
    .setDescription('يسحب لك أول مواطن مؤهل من روم الانتظار (لازم تكون لحالك بالروم)')
    .toJSON(),
];

// نحتاج آيدي التطبيق (Application ID) — نجيبه تلقائي من التوكن عبر REST
const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    const clientId = app.id;

    console.log('⏳ جاري تسجيل الأوامر...');
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), {
      body: commands,
    });
    console.log('✅ تم تسجيل أمر /سحب بنجاح.');
  } catch (err) {
    console.error('❌ فشل تسجيل الأوامر:', err);
  }
})();
