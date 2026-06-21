'use strict';

module.exports = {
    name: 'unassign_player',
    description: 'Remove a player from their current team.',
    permission: 'ADMIN',
    num_args: 0,
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

        const players = data.getPlayers();
        players[target.id].team_id   = '';
        players[target.id].team_role = '';
        players[target.id].team_type = '';
        data.savePlayers(players);

        // Remove the team Discord role if configured
        if (team && team.discord_role_id) {
            try {
                const member = await message.guild.members.fetch(target.id);
                await member.roles.remove(team.discord_role_id);
            } catch (err) {
                this.logger.warn(`[unassign_player] Could not remove team role from ${target.id}: ${err.message}`);
            }
        }

        await message.channel.send({
            content: `<@${target.id}> has been removed from **${teamName}**.`,
        });
        this.logger.info(`[unassign_player] ${target.id} unassigned from team "${teamName}"`);
    },
};
