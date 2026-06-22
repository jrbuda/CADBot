'use strict';

module.exports = {
    name: 'unlink',
    description: 'Unlink your League of Legends account.',
    permission: 'EVERYONE',
    options: [],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const targetId = message.author.id;
        const players  = data.getPlayers();

        if (!players[targetId]) {
            await message.channel.send({ content: 'You do not have a linked account.' });
            return;
        }

        delete players[targetId];
        data.savePlayers(players);

        await message.channel.send({ content: 'Your account has been unlinked.' });
        this.logger.info(`[unlink] ${targetId} account unlinked`);
    },
};
