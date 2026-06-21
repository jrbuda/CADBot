'use strict';

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
        // Access the shared data instance via the module_handler path isn't available in autocomplete,
        // so we construct a temporary reader.
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

        const teamName = team.name;

        // Unassign all players on this team
        const players = data.getPlayers();
        const config  = data.getConfig();
        let unassigned = 0;
        for (const [id, player] of Object.entries(players)) {
            if (player.team_id === team_id) {
                players[id].team_id    = '';
                players[id].team_role  = '';
                players[id].team_type  = '';
                unassigned++;

                if (config.captain_role_id && team.captain_id === id) {
                    try {
                        const member = await message.guild.members.fetch(id);
                        await member.roles.remove(config.captain_role_id);
                    } catch (_) {}
                }
            }
        }
        data.savePlayers(players);

        // Delete the team
        const teams = data.getTeams();
        delete teams[team_id];
        data.saveTeams(teams);

        await message.channel.send({
            content: `Team **${teamName}** has been deleted. ${unassigned} player(s) unassigned.`,
        });
        this.logger.info(`[delete_team] ${message.author.id} deleted team "${teamName}" (${team_id}), ${unassigned} players unassigned`);
    },
};
