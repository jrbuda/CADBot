'use strict';

module.exports = {
    name: 'set_captain',
    description: "Set the captain of a team. Optionally assigns the captain Discord role.",
    permission: 'ADMIN',
    num_args: 0,
    options: [
        {
            name: 'player',
            description: 'Discord user to promote as captain',
            type: 'USER',
            required: true,
        },
        {
            name: 'team',
            description: 'The team this player will captain',
            type: 'STRING',
            required: true,
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

        const target  = interaction.options.getUser('player');
        const team_id = interaction.options.getString('team');
        const team    = data.getTeam(team_id);

        if (!team) {
            await message.channel.send({ content: 'Team not found.' });
            return;
        }

        // Ensure the target player has a linked account
        const player = data.getPlayer(target.id);
        if (!player) {
            await message.channel.send({
                content: `<@${target.id}> has not linked their League of Legends account yet.`,
            });
            return;
        }

        const config = data.getConfig();
        const teams  = data.getTeams();
        teams[team_id].captain_id = target.id;
        data.saveTeams(teams);

        // Assign captain role if configured
        if (config.captain_role_id) {
            try {
                const member = await message.guild.members.fetch(target.id);
                await member.roles.add(config.captain_role_id);
            } catch (err) {
                this.logger.warn(`[set_captain] Could not assign captain role to ${target.id}: ${err.message}`);
            }
        }

        await message.channel.send({
            content: `<@${target.id}> is now the captain of **${team.name}**.`,
        });
        this.logger.info(`[set_captain] ${target.id} set as captain of "${team.name}"`);
    },
};
