'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    name: 'unassign_player',
    description: 'Remove a player from their current team.',
    permission: 'ADMIN',
    options: [
        {
            name: 'player',
            description: 'The Discord user to unassign',
            type: 'USER',
            required: true,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target = interaction.options.getUser('player');
        const player = data.getPlayer(target.id);

        if (!player || !player.team_id) {
            await message.channel.send({ content: `<@${target.id}> is not currently assigned to any team.` });
            return;
        }

        const team     = data.getTeam(player.team_id);
        const teamName = team ? team.name : 'Unknown';
        const isCaptain = team && team.captain_id === target.id;

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ADMIN_UNASSIGN_CONFIRM_${target.id}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`ADMIN_UNASSIGN_CANCEL_${target.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary),
        );

        const embed = new EmbedBuilder()
            .setTitle('\u26A0\uFE0F Unassign Player?')
            .setDescription(
                `Remove <@${target.id}> from **${teamName}**?\n` +
                `Currently: **${player.team_role || '?'} ${player.team_type || '?'}**` +
                (isCaptain ? ' · **Team Captain**' : '') +
                `\nTheir team role${isCaptain ? ' and captain status' : ''} will be cleared.`
            )
            .setColor(0xFEE75C);

        await message.channel.send({ embeds: [embed], components: [confirmRow] });
    },
};
