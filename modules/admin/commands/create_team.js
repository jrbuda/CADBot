'use strict';
const { EmbedBuilder } = require('discord.js');
const { randomUUID }   = require('crypto');

module.exports = {
    name: 'create_team',
    description: 'Create a new team. Optionally link a Discord role to the team.',
    permission: 'ADMIN',
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
        let   discord_role_id = role ? role.id : '';

        // If no role was specified, create one for the team
        if (!role) {
            try {
                const newRole = await message.guild.roles.create({
                    name: teamName,
                    mentionable: true,
                    reason: `Team role for ${teamName}`,
                });
                discord_role_id = newRole.id;
            } catch (err) {
                this.logger.warn(`[create_team] Could not create Discord role for "${teamName}": ${err.message}`);
            }
        }

        // Create a captain role if one doesn't exist yet
        const config = data.getConfig();
        if (!config.captain_role_id) {
            try {
                const capRole = await message.guild.roles.create({
                    name: 'Captain',
                    color: 0xF1C40F,
                    mentionable: true,
                    reason: 'Auto-created captain role for CADBot',
                });
                config.captain_role_id = capRole.id;
                data.saveConfig(config);
            } catch (err) {
                this.logger.warn('[create_team] Could not auto-create captain role: ' + err.message);
            }
        }

        teams[team_id] = {
            id:              team_id,
            name:            teamName,
            discord_role_id,
            captain_id:      '',
            created_at:      new Date().toISOString(),
        };

        data.saveTeams(teams);

        const embed = new EmbedBuilder()
            .setTitle('Team Created')
            .setColor(0x57F287)
            .addFields(
                { name: 'Name',       value: teamName,              inline: true },
                { name: 'Team ID',    value: `\`${team_id}\``,      inline: true },
                { name: 'Role',       value: discord_role_id ? `<@&${discord_role_id}>` : 'None', inline: true },
            )
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
        this.logger.info(`[create_team] ${message.author.id} created team "${teamName}" (${team_id})`);
    },
};
