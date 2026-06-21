'use strict';
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'teams',
    description: 'List all teams in the organization.',
    permission: 'EVERYONE',
    num_args: 0,
    options: [],

    async execute(message, args, extra) {
        const data  = extra.data;
        const teams = data.getTeams();
        const all   = Object.values(teams);

        if (all.length === 0) {
            await message.channel.send({ content: 'No teams have been created yet. Admins can create teams with `/create_team`.' });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Teams')
            .setColor(0x5865F2)
            .setTimestamp();

        for (const team of all) {
            const members = data.getTeamPlayers(team.id);
            const mains   = members.filter(p => p.team_type === 'Main').length;
            const subs    = members.filter(p => p.team_type === 'Substitute').length;
            const captain = team.captain_id ? `<@${team.captain_id}>` : '_No captain_';

            embed.addFields({
                name:  team.name,
                value: `Captain: ${captain}\nPlayers: ${mains} starter${mains !== 1 ? 's' : ''}, ${subs} sub${subs !== 1 ? 's' : ''}`
                       + (team.discord_role_id ? `\nRole: <@&${team.discord_role_id}>` : ''),
                inline: true,
            });
        }

        await message.channel.send({ embeds: [embed] });
    },
};
