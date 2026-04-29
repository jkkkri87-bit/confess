require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require('discord.js');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CONFESSION_CHANNEL_ID = process.env.CONFESSION_CHANNEL_ID;
const EXPOSE_CHANNEL_ID = '1490140096517767268';
const ADMIN_ID = process.env.ADMIN_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// --- In-memory data ---
const data = {
  users: {}, // maps userId -> fakeID
  threads: {}, // maps confessionNum -> threadId
  confessionCount: 0,
  dmChats: {}, // reply chains
  blacklist: [],
  perms: [] // users who get confessions in DMs
};

// --- Helper functions ---
function getRandomID() {
  return Math.floor(1000 + Math.random() * 9000);
}

async function dmAdmin(message) {
  try {
    const admin = await client.users.fetch(ADMIN_ID);
    await admin.send(message);
  } catch {}
}

// --- Slash commands registration ---
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('confess')
      .setDescription('Send an anonymous confession'),

    new SlashCommandBuilder()
      .setName('reply')
      .setDescription('Reply to a confession')
      .addIntegerOption(opt => opt.setName('confnum').setDescription('Confession number').setRequired(true)),

    new SlashCommandBuilder()
      .setName('report')
      .setDescription('Report a confession')
      .addIntegerOption(opt => opt.setName('confnum').setDescription('Confession number').setRequired(true)),

    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Show confession stats'),

    new SlashCommandBuilder()
      .setName('blacklist')
      .setDescription('Blacklist a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to blacklist').setRequired(true)),

    new SlashCommandBuilder()
      .setName('unblacklist')
      .setDescription('Unblacklist a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),

    new SlashCommandBuilder()
      .setName('perms')
      .setDescription('Give a user perms to receive confessions in DMs')
      .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)),

    new SlashCommandBuilder()
      .setName('removepr')
      .setDescription('Remove a user from receiving confessions')
      .addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)),

    new SlashCommandBuilder()
      .setName('listperms')
      .setDescription('List users with confession perms')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Registered slash commands.');
}

// --- Interaction handler ---
client.on('interactionCreate', async interaction => {
  const channel = await client.channels.fetch(CONFESSION_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return;

  // --- /confess ---
  if (interaction.isChatInputCommand() && interaction.commandName === 'confess') {
    // Show modal for typing
    const modal = new ModalBuilder().setCustomId('modal_confess').setTitle('Send your confession');
    const input = new TextInputBuilder()
      .setCustomId('confess_input')
      .setLabel('Your confession')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  }

  // --- Modal submit for confession ---
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'modal_confess') {
    const msg = interaction.fields.getTextInputValue('confess_input');
    if (data.blacklist.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You are blacklisted.', ephemeral: true });
    }

    const fakeID = getRandomID();
    data.users[interaction.user.id] = fakeID;
    data.confessionCount++;
    const confNum = data.confessionCount;

    // send to channel
    const confMessage = await channel.send({
      content: `📩 **Confession #${confNum}**\n👤 User #${fakeID}\n\n${msg}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`reply_${confNum}`).setLabel('Reply').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`report_${confNum}`).setLabel('Report').setStyle(ButtonStyle.Danger)
        )
      ]
    });

    const thread = await confMessage.startThread({ name: `Confession #${confNum}`, autoArchiveDuration: 1440 });
    data.threads[confNum] = thread.id;

    dmAdmin(`👀 CONFESSION #${confNum}\nFrom: ${interaction.user.tag} (${interaction.user.id})\nFake ID: #${fakeID}\n\n${msg}`);

    // send to users with perms
    for (const userId of data.perms) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`📩 **Confession #${confNum}**\n👤 User #${fakeID}\n\n${msg}`);
      } catch {}
    }

    await interaction.reply({ content: `✅ Sent as Confession #${confNum}`, ephemeral: true });
  }

  // --- Buttons (Reply / Report) ---
  if (interaction.isButton()) {
    const [action, confNum] = interaction.customId.split('_');

    // --- Reply button ---
    if (action === 'reply') {
      const modal = new ModalBuilder()
        .setCustomId(`modal_reply_${confNum}`)
        .setTitle(`Reply to Confession #${confNum}`);

      const input = new TextInputBuilder()
        .setCustomId('reply_input')
        .setLabel('Your anonymous reply')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }

    // --- Report button ---
    if (action === 'report') {
      const confThreadId = data.threads[confNum];
      const confThread = await client.channels.fetch(confThreadId).catch(() => null);
      const confUserId = Object.entries(data.users).find(([uid, fid]) => fid === parseInt(confNum))?.[0];
      if (!confUserId) return interaction.reply({ content: '❌ Original poster not found.', ephemeral: true });

      data.blacklist.push(confUserId);
      const exposeChannel = await client.channels.fetch(EXPOSE_CHANNEL_ID);
      await exposeChannel.send(`⚠️ **Exposed Confession #${confNum}**\n<@${confUserId}> don't ever do this again!`);
      if (confThread) confThread.delete().catch(() => {});
      await interaction.reply({ content: `✅ User blacklisted and confession exposed.`, ephemeral: true });
    }
  }

  // --- Modal submit for reply ---
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('modal_reply_')) {
    const confNum = interaction.customId.split('_')[2];
    const replyMsg = interaction.fields.getTextInputValue('reply_input');
    const senderFakeID = getRandomID();

    const threadId = data.threads[confNum];
    if (!threadId) return interaction.reply({ content: '❌ Confession thread not found.', ephemeral: true });
    const thread = await client.channels.fetch(threadId);
    await thread.send(`💬 **Reply to Confession #${confNum}**\n👤 User #${senderFakeID}\n\n${replyMsg}`);

    dmAdmin(`👀 REPLY to #${confNum}\nFrom: ${interaction.user.tag} (${interaction.user.id})\nFake ID: #${senderFakeID}\n\n${replyMsg}`);

    await interaction.reply({ content: '✅ Your reply was sent anonymously!', ephemeral: true });
  }

  // --- Command handlers for perms / removepr / listperms ---
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'perms') {
      const user = interaction.options.getUser('user');
      if (!data.perms.includes(user.id)) data.perms.push(user.id);
      await interaction.reply({ content: `✅ ${user.tag} will now receive confessions in DMs.`, ephemeral: true });
    }

    if (interaction.commandName === 'removepr') {
      const user = interaction.options.getUser('user');
      data.perms = data.perms.filter(id => id !== user.id);
      await interaction.reply({ content: `✅ ${user.tag} will no longer receive confessions in DMs.`, ephemeral: true });
    }

    if (interaction.commandName === 'listperms') {
      if (data.perms.length === 0) return interaction.reply({ content: 'No one has perms.', ephemeral: true });
      const mentions = data.perms.map(id => `<@${id}>`).join('\n');
      await interaction.reply({ content: `Users with perms:\n${mentions}`, ephemeral: true });
    }
  }
});

// --- Ready event ---
client.on('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// --- Start bot ---
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
