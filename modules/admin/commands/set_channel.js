'use strict';
const { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CHANNEL_TYPES = ['scrim', 'log', 'tryout_announcements'];

module.exports = {
    name: 'set_channel',
    description: 'Designate a channel for scrim requests, admin logs, or tryout announcements.',
    permission: 'ADMIN',
    ephemeral: true,
    options: [
        {
            name: 'type',
            description: 'Channel purpose',
            type: 'STRING',
            required: true,
            choices: [
                { name: 'Scrim',               value: 'scrim' },
                { name: 'Log',                 value: 'log' },
                { name: 'Tryout Announcements', value: 'tryout_announcements' },
            ],
        },
        {
            name: 'channel',
            description: 'The text channel to assign',
            type: 'CHANNEL',
            required: true,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const type    = interaction.options.getString('type');
        const channel = interaction.options.getChannel('channel');

        if (channel.type !== ChannelType.GuildText) {
            await message.channel.send({ content: 'Please select a text channel.' });
            return;
        }

        const config = data.getConfig();
        const key = type === 'tryout_announcements' ? 'tryout_announcements_channel_id' : type + '_channel_id';
        config[key] = channel.id;
        data.saveConfig(config);

        const typeLabel = type === 'tryout_announcements' ? 'tryout announcements' : type;
        const testRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ADMIN_SET_CHANNEL_TEST_${channel.id}`)
                .setLabel('Test')
                .setStyle(ButtonStyle.Secondary),
        );

        await message.channel.send({
            content: `The **${typeLabel}** channel has been set to <#${channel.id}>.`,
            components: [testRow],
        });
        this.logger.info(`[set_channel] ${key} set to ${channel.id}`);
    },
};
