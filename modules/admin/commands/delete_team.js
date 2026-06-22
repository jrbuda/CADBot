'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    name: 'delete_team',
    description: 'Delete a team and unassign all of its players.',
    permission: 'ADMIN',
    options: [
        {
            name: 'team',
            description: 'Name of the team to delete',
            type: 'STRING',
            required: true,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction) {
        const DataManager = require('../../../core/js/data_manager.js');
        const path = require('path');
        const data_path = path.join(__dirname, '../../../data');
        const data = new DataManager(data_path, { error: () => {}, info: () => {} });

        const focused = interaction.options.getFocused().toLowerCase();
        const teams   = data.getTeams();
        const choices = Object.values(teams)
            .filter(t => t.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(t => ({ name: t.name, value: t.id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const team_id = interaction.options.getString('team');
        const team    = data.getTeam(team_id);

        if (!team) {
            await message.channel.send({ content: 'Team not found.' });
            return;
        }

        // Count affected players
        const players = data.getPlayers();
        let playerCount = 0;
        for (const p of Object.values(players)) {
            if (p.team_id === team_id) playerCount++;
        }

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ADMIN_DELETE_TEAM_CONFIRM_${team_id}`)
                .setLabel('Confirm Delete')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`ADMIN_DELETE_TEAM_CANCEL_${team_id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary),
        );

        const embed = new EmbedBuilder()
            .setTitle('\u26A0\uFE0F Delete Team?')
            .setDescription(
                `Delete **${team.name}**?\n\n` +
                `\u2022 ${playerCount} player(s) will be unassigned\n` +
                `\u2022 The team role <@&${team.discord_role_id}> will be deleted\n` +
                (team.captain_id ? `\u2022 Captain status will be cleared for <@${team.captain_id}>\n` : '') +
                `\nThis is **permanent** and cannot be undone.`
            )
            .setColor(0xED4245);

        await message.channel.send({ embeds: [embed], components: [confirmRow] });
    },
};
