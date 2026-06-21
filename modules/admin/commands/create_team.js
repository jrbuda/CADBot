'use strict';
const { EmbedBuilder } = require('discord.js');
const { randomUUID }   = require('crypto');

module.exports = {
    name: 'create_team',
    description: 'Create a new team. Optionally link a Discord role to the team.',
    permission: 'ADMIN',
    num_args: 0,
    options: [
        {
            name: 'name',
            description: 'Display name for the team (e.g. "Team Liquid")',
            type: 'STRING',
            required: true,
        },
        {
            name: 'role',
            description: 'Discord role to associate with this team (optional)',
            type: 'ROLE',
            required: false,
        },
    ],

    async execute(message, args, extra) {
        const data      = extra.data;
        const interaction = extra.interaction;

        const teamName = interaction.options.getString('name').trim();
        const role     = interaction.options.getRole('role');

        if (!teamName) {
            await message.channel.send({ content: 'Team name cannot be empty.' });
            return;
        }

        const teams = data.getTeams();

        // Check for duplicate name
        const duplicate = Object.values(teams).find(
            t => t.name.toLowerCase() === teamName.toLowerCase()
        );
        if (duplicate) {
            await message.channel.send({ content: `A team named **${teamName}** already exists.` });
            return;
        }

        const team_id = randomUUID();
        teams[team_id] = {
            id:              team_id,
            name:            teamName,
            discord_role_id: role ? role.id : '',
            captain_id:      '',
            created_at:      new Date().toISOString(),
        };

        data.saveTeams(teams);

        const embed = new EmbedBuilder()
            .setTitle('Team Created')
            .setColor(0x57F287)
            .addFields(
                { name: 'Name',       value: teamName,         inline: true },
                { name: 'Team ID',    value: `\`${team_id}\``, inline: true },
                { name: 'Role',       value: role ? `<@&${role.id}>` : 'None assigned', inline: true },
            )
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
        this.logger.info(`[create_team] ${message.author.id} created team "${teamName}" (${team_id})`);
    },
};
