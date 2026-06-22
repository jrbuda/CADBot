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
            name: 'short_name',
            description: 'Abbreviation \u2014 up to 3 characters (e.g. "ALS")',
            type: 'STRING',
            required: false,
            max_length: 3,
        },
        {
            name: 'role',
            description: 'Discord role to use as the main team role (optional \u2014 auto-creates otherwise)',
            type: 'ROLE',
            required: false,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const teamName  = interaction.options.getString('name').trim();
        const shortName = (interaction.options.getString('short_name') || '').trim().toUpperCase();
        const role      = interaction.options.getRole('role');

        if (!teamName) {
            await message.channel.send({ content: 'Team name cannot be empty.' });
            return;
        }

        if (shortName.length > 3) {
            await message.channel.send({ content: 'Short name must be at most 3 characters.' });
            return;
        }

        const teams = data.getTeams();

        const duplicate = Object.values(teams).find(
            t => t.name.toLowerCase() === teamName.toLowerCase()
        );
        if (duplicate) {
            await message.channel.send({ content: `A team named **${teamName}** already exists.` });
            return;
        }

        const team_id = randomUUID();
        let discord_role_id           = role ? role.id : '';
        let captain_discord_role_id   = '';
        let sub_discord_role_id       = '';

        if (!role) {
            try {
                const newRole = await message.guild.roles.create({
                    name: teamName,
                    mentionable: true,
                    reason: `Team role for ${teamName}`,
                });
                discord_role_id = newRole.id;
            } catch (err) {
                this.logger.warn(`[create_team] Could not create main team role for "${teamName}": ${err.message}`);
            }
        }

        try {
            const capRole = await message.guild.roles.create({
                name: `${teamName} Captain`,
                color: 0xF1C40F,
                mentionable: true,
                reason: `Captain role for ${teamName}`,
            });
            captain_discord_role_id = capRole.id;
        } catch (err) {
            this.logger.warn(`[create_team] Could not create captain role for "${teamName}": ${err.message}`);
        }

        try {
            const subRole = await message.guild.roles.create({
                name: `${teamName} Sub`,
                color: 0x95A5A6,
                mentionable: true,
                reason: `Substitute role for ${teamName}`,
            });
            sub_discord_role_id = subRole.id;
        } catch (err) {
            this.logger.warn(`[create_team] Could not create sub role for "${teamName}": ${err.message}`);
        }

        const config = data.getConfig();
        if (!config.captain_role_id) {
            try {
                const capRole = await message.guild.roles.create({
                    name: 'Captain',
                    color: 0xF1C40F,
                    mentionable: true,
                    reason: 'Auto-created server-wide captain role for CADBot',
                });
                config.captain_role_id = capRole.id;
                data.saveConfig(config);
            } catch (err) {
                this.logger.warn('[create_team] Could not auto-create server-wide captain role: ' + err.message);
            }
        }

        teams[team_id] = {
            id:                      team_id,
            name:                    teamName,
            short_name:              shortName,
            discord_role_id,
            captain_discord_role_id,
            sub_discord_role_id,
            captain_id:              '',
            created_at:              new Date().toISOString(),
        };

        data.saveTeams(teams);

        const title = shortName
            ? `Team Created \u2014 ${teamName} [${shortName}]`
            : `Team Created \u2014 ${teamName}`;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(0x57F287)
            .addFields(
                { name: 'Main Role',   value: discord_role_id           ? `<@&${discord_role_id}>`           : 'None', inline: true },
                { name: 'Captain Role', value: captain_discord_role_id  ? `<@&${captain_discord_role_id}>`   : 'None', inline: true },
                { name: 'Sub Role',     value: sub_discord_role_id      ? `<@&${sub_discord_role_id}>`       : 'None', inline: true },
            )
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
        this.logger.info(`[create_team] ${message.author.id} created team "${teamName}" (${team_id}) short=${shortName || 'none'}`);
    },
};
