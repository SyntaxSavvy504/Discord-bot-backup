const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { MongoClient } = require('mongodb');
const fs = require('fs');

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json'));

// Connect to MongoDB
const clientMongo = new MongoClient(config.mongoUri);
let db;
clientMongo.connect().then(() => {
  db = clientMongo.db('discordBot'); // Choose the database name
  console.log('Connected to MongoDB.');
});

// Create a new Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // Added to check user roles
    GatewayIntentBits.DirectMessages, // Added to handle DMs
  ],
});

let logChannelId = config.logChannelId; // Initialize log channel ID
let responseChannelId = config.responseChannelId; // Initialize response channel ID

// Register slash commands
const commands = [
  {
    name: 'apply',
    description: 'Handle visa applications (accept/reject)',
    options: [
      {
        type: 1, // Sub-command
        name: 'accept',
        description: 'Accept an application',
        options: [
          {
            type: 6, // USER type
            name: 'applicant',
            description: 'The applicant to accept',
            required: true,
          },
          {
            type: 8, // ROLE type
            name: 'role',
            description: 'Role to assign to the applicant',
            required: true,
          },
        ],
      },
      {
        type: 1, // Sub-command
        name: 'reject',
        description: 'Reject an application',
        options: [
          {
            type: 6, // USER type
            name: 'applicant',
            description: 'The applicant to reject',
            required: true,
          },
          // Removed the reason option
        ],
      },
      {
        type: 1, // Sub-command
        name: 'status',
        description: 'Check the status of your application',
      },
    ],
  },
  {
    name: 'setlog',
    description: 'Set the logging channel for application events',
    options: [
      {
        type: 7, // CHANNEL type
        name: 'channel',
        description: 'The channel to log application events',
        required: true,
      },
    ],
  },
  {
    name: 'setresponse',
    description: 'Set the response channel for application messages',
    options: [
      {
        type: 7, // CHANNEL type
        name: 'channel',
        description: 'The channel to send application responses',
        required: true,
      },
    ],
  },
];

const rest = new REST({ version: '10' }).setToken(config.botToken);

// Log the bot in and register commands
client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  try {
    console.log('Started refreshing application (/) commands.');

    // Register commands with Discord
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

// Handle interactions (slash commands)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options, member } = interaction;

  // Check if the user has the allowed role
  const hasRole = member.roles.cache.some(role => config.allowedRoles.includes(role.id));
  if (!hasRole) {
    return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
  }

  try {
    const applicant = options.getUser('applicant');
    let embed;

    // Acknowledge the interaction immediately
    await interaction.deferReply();

    if (commandName === 'apply') {
      if (options.getSubcommand() === 'accept') {
        // Store application data in MongoDB
        await db.collection('applications').updateOne(
          { userId: applicant.id },
          { $set: { status: 'accepted' } },
          { upsert: true }
        );

        // Assign the specified role
        const role = options.getRole('role');
        const memberToUpdate = await interaction.guild.members.fetch(applicant.id);
        await memberToUpdate.roles.add(role);

        // Get the name of the user who executed the command
        const executorName = member.displayName;

        // Create the embed
        embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('__Application Accepted__') // Underlined title
          .setDescription(`__Status:__ Accepted\n\n__Details:__ Your visa application has been approved.\n\n`) // Underlined status and details
          .setImage('https://media.discordapp.net/attachments/865619411770933288/1294375223361015849/rejected_visa.png?ex=670cc29d&is=670b711d&hm=b56f787d5b9c88a30b187c33fec64ce4f3bc571eb43c8d627af1969507eaf6f2&=&format=webp&quality=lossless&width=375&height=150')
          .setFooter({ text: 'Congratulations!', iconURL: client.user.displayAvatarURL() })
          .setThumbnail(applicant.displayAvatarURL({ dynamic: true })) // Applicant's avatar
          .setAuthor({
            name: interaction.guild.name, // Server name
            iconURL: interaction.guild.iconURL({ dynamic: true }), // Server icon
          });

        // Send the acceptance message separately
        const acceptMessage = `<@${applicant.id}>, your application has been accepted.`;

        // DM the user with the embed
        const dmChannel = await applicant.createDM();
        await dmChannel.send({ content: acceptMessage, embeds: [embed] });

        // Log the acceptance
        await logEvent('Application Accepted', `✅ An application has been accepted for <@${applicant.id}> by **${executorName}**.`);

        // Send the message to the response channel
        const targetChannel = client.channels.cache.get(responseChannelId);
        if (targetChannel && embed) {
          await targetChannel.send({ content: acceptMessage, embeds: [embed] });
        } else {
          console.error('Response channel not found or embed is not defined.');
        }

        // Reply to the interaction
        await interaction.editReply({ content: 'Application accepted and the user has been notified!', ephemeral: true });

      } else if (options.getSubcommand() === 'reject') {
        // Store application data in MongoDB
        await db.collection('applications').updateOne(
          { userId: applicant.id },
          { $set: { status: 'rejected' } }, // Keep it in the database if needed
          { upsert: true }
        );

        // Get the name of the user who executed the command
        const executorName = member.displayName;

        // Create the embed without displaying the reason
        embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('__Application Rejected__') // Underlined title
          .setDescription(`**__Status__:** Rejected\n\n**__Details__:** Your Visa Application has been rejected. Please check the website for more info.\n\n`) // Bold and underlined status and details
          .setImage('https://media.discordapp.net/attachments/865619411770933288/1294375240289484952/rejected_visa_a.png?ex=670cc2a1&is=670b7121&hm=c3f90eb09fa2a28be8dae85f1118f82d1eddeeb78707a73db5d427c5061f58b5&=&format=webp&quality=lossless&width=375&height=150')
          .setFooter({ text: 'Thank you for your interest in our server.', iconURL: client.user.displayAvatarURL() })
          .setThumbnail(applicant.displayAvatarURL({ dynamic: true })) // Applicant's avatar
          .setAuthor({
            name: interaction.guild.name, // Server name
            iconURL: interaction.guild.iconURL({ dynamic: true }), // Server icon
          });

        // Send the rejection message separately
        const rejectMessage = `<@${applicant.id}>, your application has been rejected.`;

        // DM the user with the embed
        const dmChannel = await applicant.createDM();
        await dmChannel.send({ content: rejectMessage, embeds: [embed] });

        // Log the rejection
        await logEvent('Application Rejected', `❌ An application has been rejected for <@${applicant.id}> by **${executorName}**.`);

        // Send the message to the response channel
        const targetChannel = client.channels.cache.get(responseChannelId);
        if (targetChannel && embed) {
          await targetChannel.send({ content: rejectMessage, embeds: [embed] });
        } else {
          console.error('Response channel not found or embed is not defined.');
        }

        // Reply to the interaction
        await interaction.editReply({ content: 'Application rejected and the user has been notified!', ephemeral: true });
      }
    } else if (commandName === 'setlog') {
      // Set the log channel and save to MongoDB
      const newLogChannel = options.getChannel('channel');
      logChannelId = newLogChannel.id; // Update the variable
      await db.collection('settings').updateOne(
        { guildId: interaction.guild.id },
        { $set: { logChannelId: logChannelId } },
        { upsert: true }
      );

      await interaction.editReply({ content: `Log channel has been set to ${newLogChannel}`, ephemeral: true });
    } else if (commandName === 'setresponse') {
      // Set the response channel and save to MongoDB
      const newResponseChannel = options.getChannel('channel');
      responseChannelId = newResponseChannel.id; // Update the variable
      await db.collection('settings').updateOne(
        { guildId: interaction.guild.id },
        { $set: { responseChannelId: responseChannelId } },
        { upsert: true }
      );

      await interaction.editReply({ content: `Response channel has been set to ${newResponseChannel}`, ephemeral: true });
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    await interaction.editReply({ content: 'There was an error while handling your command!', ephemeral: true });
  }
});

// Function to log events
async function logEvent(eventTitle, eventDescription) {
  if (!logChannelId) return; // Do not log if the log channel ID is not set
  const logChannel = await client.channels.fetch(logChannelId);
  if (logChannel) {
    const logEmbed = new EmbedBuilder()
      .setColor('#3498db')
      .setTitle(eventTitle)
      .setDescription(eventDescription)
      .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });
  } else {
    console.error('Log channel not found.');
  }
}

// Log in to Discord
client.login(config.botToken).catch(console.error);
