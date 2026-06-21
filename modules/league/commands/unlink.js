'use strict';

module.exports = {
    name: 'unlink',
    description: 'Unlink your (or another user\'s) League of Legends account.',
    permission: 'EVERYONE',
    options: [
        {
            name: 'player',
            description: 'Admin only: unlink another user\'s account',
            type: 'USER',
            required: false,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const permissions = extra.permissions;
        const interaction = extra.interaction;

        const target = interaction.options.getUser('player');

        // If targeting another user, must be admin
        if (target && target.id !== message.author.id) {
            if (!permissions.check('ADMIN', message.member, message.author.id)) {
                await message.channel.send({ content: 'Only admins can unlink another user\'s account.' });
                return;
            }
        }

        const targetId = target ? target.id : message.author.id;
        const players  = data.getPlayers();

        if (!players[targetId]) {
            await message.channel.send({ content: `<@${targetId}> does not have a linked account.` });
            return;
        }

        delete players[targetId];
        data.savePlayers(players);

        const mention = targetId === message.author.id ? 'Your account has' : `<@${targetId}>'s account has`;
        await message.channel.send({ content: `${mention} been unlinked.` });
        this.logger.info(`[unlink] ${targetId} account unlinked by ${message.author.id}`);
    },
};
