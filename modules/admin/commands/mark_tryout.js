'use strict';

module.exports = {
    name: 'mark_tryout',
    description: 'Mark or unmark a player as a tryout.',
    permission: 'ADMIN',
    ephemeral: true,
    options: [
        {
            name: 'player',
            description: 'The Discord user to mark',
            type: 'USER',
            required: true,
        },
        {
            name: 'status',
            description: 'Set as tryout or remove tryout status',
            type: 'BOOLEAN',
            required: true,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target    = interaction.options.getUser('player');
        const isTryout  = interaction.options.getBoolean('status');

        const players = data.getPlayers();
        if (!players[target.id]) {
            await message.channel.send({
                content: `<@${target.id}> hasn't linked their Riot account yet — they need to use \`/link\` first.`,
            });
            return;
        }

        players[target.id].is_tryout = isTryout;
        data.savePlayers(players);

        const config = data.getConfig();

        // Assign or remove tryout role if configured
        if (config.tryout_role_id) {
            try {
                const member = await message.guild.members.fetch(target.id);
                if (isTryout) {
                    await member.roles.add(config.tryout_role_id);
                } else {
                    await member.roles.remove(config.tryout_role_id);
                }
            } catch (err) {
                this.logger.warn(`[mark_tryout] Could not modify tryout role for ${target.id}: ${err.message}`);
            }
        }

        const statusStr = isTryout ? 'marked as a **tryout**' : 'removed from tryout status';
        await message.channel.send({ content: `<@${target.id}> has been ${statusStr}.` });
        this.logger.info(`[mark_tryout] ${target.id} tryout=${isTryout}`);
    },
};
