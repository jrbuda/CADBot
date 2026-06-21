'use strict';
const { EmbedBuilder } = require('discord.js');

const POSITION_EMOJI = {
    Top: '🛡️', Jungle: '🌿', Mid: '⚡', Bot: '🏹', Support: '💊',
};

module.exports = {
    name: 'roster',
    description: 'View a team\'s roster, or list all teams if no team is specified.',
    permission: 'EVERYONE',
    num_args: 0,
    options: [
        {
            name: 'team',
            description: 'Team to view — leave blank to list all teams',
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

        // If no team specified, try to default to the requester's own team
        if (!team_id) {
            const player      = data.getPlayer(message.author.id);
            const captainTeam = data.getTeamByCaptain(message.author.id);
            if (player?.team_id) {
                team_id = player.team_id;
            } else if (captainTeam) {
                team_id = captainTeam.id;
            }
        }

        // ── No team resolved → show all-teams overview ────────────────────────
        if (!team_id) {
            const all = Object.values(data.getTeams());
            if (all.length === 0) {
                await message.channel.send({ content: 'No teams have been created yet.' });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('All Teams')
                .setColor(0x5865F2)
                .setTimestamp();

            for (const team of all) {
                const members = data.getTeamPlayers(team.id);
                const mains   = members.filter(p => p.team_type === 'Main').length;
                const subs    = members.filter(p => p.team_type === 'Substitute').length;
                const captain = team.captain_id ? `<@${team.captain_id}>` : '_No captain_';
                embed.addFields({
                    name:   team.name,
                    value:  `Captain: ${captain}\nRoster: ${mains} starter${mains !== 1 ? 's' : ''}, ${subs} sub${subs !== 1 ? 's' : ''}` +
                            (team.discord_role_id ? `\nRole: <@&${team.discord_role_id}>` : ''),
                    inline: true,
                });
            }

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── Team resolved → show full roster ──────────────────────────────────
        const team = data.getTeam(team_id);
        if (!team) {
            await message.channel.send({ content: 'Team not found.' });
            return;
        }

        const members = data.getTeamPlayers(team_id);
        if (members.length === 0) {
            await message.channel.send({ content: `**${team.name}** has no players assigned yet.` });
            return;
        }

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

        if (team.captain_id) embed.addFields({ name: 'Captain', value: `<@${team.captain_id}>` });
        if (mainLines.length > 0) embed.addFields({ name: `Starters (${mainLines.length})`, value: mainLines.join('\n') });
        if (subLines.length > 0) embed.addFields({ name: `Substitutes (${subLines.length})`, value: subLines.join('\n') });
        if (team.discord_role_id) embed.addFields({ name: 'Team Role', value: `<@&${team.discord_role_id}>` });

        await message.channel.send({ embeds: [embed] });
    },
};
