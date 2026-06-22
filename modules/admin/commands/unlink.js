'use strict';

module.exports = {
    name: 'admin_unlink',
    description: 'Unlink another user\'s League of Legends account.',
    permission: 'ADMIN',
    options: [
        {
            name: 'player',
            description: 'User to unlink',
            type: 'USER',
            required: true,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target   = interaction.options.getUser('player');
        const targetId = target.id;
        const players  = data.getPlayers();

        if (!players[targetId]) {
            await message.channel.send({ content: `<@${targetId}> does not have a linked account.` });
            return;
        }

        delete players[targetId];
        data.savePlayers(players);

        await message.channel.send({ content: `<@${targetId}>'s account has been unlinked.` });
        this.logger.info(`[admin_unlink] ${targetId} account unlinked by ${message.author.id}`);
    },
};
