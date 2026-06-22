'use strict';

module.exports = {
    name: 'reload',
    description: 'Hot-reload all command files without restarting the bot. (Owner only)',
    permission: 'OWNER',
    options: [],

    async execute(message, args, extra) {
        try {
            extra.module_handler.reload_all(extra.interaction.client);
            await message.channel.send({ content: 'Full reload complete — commands, libraries, event handlers, and slash definitions have been refreshed.' });
        } catch (err) {
            this.logger.error('[reload] ' + err.message);
            await message.channel.send({ content: 'Error during reload: ' + err.message });
        }
    },
};
