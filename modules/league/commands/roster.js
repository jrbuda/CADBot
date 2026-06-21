'use strict';
const { EmbedBuilder } = require('discord.js');

const POSITION_EMOJI = {
    Top:     '🛡️',
    Jungle:  '🌿',
    Mid:     '⚡',
    Bot:     '🏹',
    Support: '💊',
};

module.exports = {
    name: 'roster',
    description: 'View the full roster of a team.',
    permission: 'EVERYONE',
    num_args: 0,
    options: [
        {
            name: 'team',
            description: 'Team to view (defaults to your own team)',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

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

        let team_id = interaction.options.getString('team');

        // Default to the requester's own team
        if (!team_id) {
            const player = data.getPlayer(message.author.id);
            if (player?.team_id) {
                team_id = player.team_id;
            } else {
                // Try captain
                const captainTeam = data.getTeamByCaptain(message.author.id);
                if (captainTeam) team_id = captainTeam.id;
            }
        }

        if (!team_id) {
            await message.channel.send({
                content: 'You are not on a team. Specify a `team` option or join a team first.',
            });
            return;
        }

        const team    = data.getTeam(team_id);
        if (!team) {
            await message.channel.send({ content: 'Team not found.' });
            return;
        }

        const members = data.getTeamPlayers(team_id);
        if (members.length === 0) {
            await message.channel.send({ content: `**${team.name}** has no players assigned yet.` });
            return;
        }

        // Sort: mains first, then by position order
        const posOrder = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];
        members.sort((a, b) => {
            if (a.team_type !== b.team_type) return a.team_type === 'Main' ? -1 : 1;
            return posOrder.indexOf(a.team_role) - posOrder.indexOf(b.team_role);
        });

        const mainLines = members
            .filter(p => p.team_type === 'Main')
            .map(p => {
                const emoji = POSITION_EMOJI[p.team_role] || '▪️';
                const riot  = p.riot_id ? ` — \`${p.riot_id}\`` : '';
                return `${emoji} **${p.team_role || '?'}** — <@${p.discord_id}>${riot}`;
            });

        const subLines = members
            .filter(p => p.team_type === 'Substitute')
            .map(p => {
                const emoji = POSITION_EMOJI[p.team_role] || '▪️';
                const riot  = p.riot_id ? ` — \`${p.riot_id}\`` : '';
                return `${emoji} **${p.team_role || '?'}** — <@${p.discord_id}>${riot}`;
            });

        const embed = new EmbedBuilder()
            .setTitle(team.name + ' — Roster')
            .setColor(0x5865F2)
            .setTimestamp();

        if (team.captain_id) {
            embed.addFields({ name: 'Captain', value: `<@${team.captain_id}>` });
        }
        if (mainLines.length > 0) {
            embed.addFields({ name: `Starters (${mainLines.length})`, value: mainLines.join('\n') });
        }
        if (subLines.length > 0) {
            embed.addFields({ name: `Substitutes (${subLines.length})`, value: subLines.join('\n') });
        }
        if (team.discord_role_id) {
            embed.addFields({ name: 'Team Role', value: `<@&${team.discord_role_id}>` });
        }

        await message.channel.send({ embeds: [embed] });
    },
};
