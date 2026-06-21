'use strict';

module.exports = {
    name: 'reload',
    description: 'Hot-reload all command files without restarting the bot. (Owner only)',
    permission: 'OWNER',
    num_args: 0,
    options: [],

    async execute(message, args, extra) {
        try {
            extra.module_handler.reload_commands();
            await message.channel.send({ content: 'All commands have been reloaded.' });
        } catch (err) {
            this.logger.error('[reload] ' + err.message);
            await message.channel.send({ content: 'Error during reload: ' + err.message });
        }
    },
};
