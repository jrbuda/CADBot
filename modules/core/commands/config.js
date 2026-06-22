'use strict';
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'config',
    description: 'View the current CADBot configuration — roles, channels, timezone, and region.',
    permission: 'ADMIN',
    ephemeral: true,
    options: [],

    async execute(message, args, extra) {
        const data = extra.data;
        const config = data.getConfig();

        const embed = new EmbedBuilder()
            .setTitle('CADBot Configuration')
            .setColor(0x5865F2)
            .addFields(
                { name: '\uD83D\uDD27 Admin Role',      value: config.admin_role_id ? `<@&${config.admin_role_id}>` : '_Not set_', inline: true },
                { name: '\u2694\uFE0F Captain Role',    value: config.captain_role_id ? `<@&${config.captain_role_id}>` : '_Not set_', inline: true },
                { name: '\uD83D\uDD0E Tryout Role',      value: config.tryout_role_id ? `<@&${config.tryout_role_id}>` : '_Not set_', inline: true },
                { name: '\uD83D\uDCCB Scrim Channel',    value: config.scrim_channel_id ? `<#${config.scrim_channel_id}>` : '_Not set_', inline: true },
                { name: '\uD83D\uDCCA Log Channel',      value: config.log_channel_id ? `<#${config.log_channel_id}>` : '_Not set_', inline: true },
                { name: '\uD83D\uDCE2 Tryout Channel',   value: config.tryout_announcements_channel_id ? `<#${config.tryout_announcements_channel_id}>` : '_Not set_', inline: true },
                { name: '\uD83D\uDD50 Timezone',         value: config.timezone || 'America/New_York', inline: true },
                { name: '\uD83C\uDF0D Region',           value: config.region || 'na1', inline: true },
            )
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
    },
};
