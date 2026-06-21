'use strict';
const { ChannelType } = require('discord.js');

const CHANNEL_TYPES = ['scrim', 'log'];

module.exports = {
    name: 'set_channel',
    description: 'Designate a channel for scrim requests or admin logs.',
    permission: 'ADMIN',
    ephemeral: true,
    num_args: 0,
    options: [
        {
            name: 'type',
            description: 'Channel purpose',
            type: 'STRING',
            required: true,
            choices: CHANNEL_TYPES.map(t => ({ name: t.charAt(0).toUpperCase() + t.slice(1), value: t })),
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
        config[type + '_channel_id'] = channel.id;
        data.saveConfig(config);

        await message.channel.send({
            content: `The **${type}** channel has been set to <#${channel.id}>.`,
        });
        this.logger.info(`[set_channel] ${type}_channel_id set to ${channel.id}`);
    },
};
