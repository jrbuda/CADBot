'use strict';
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'help',
    description: 'List all available commands.',
    permission: 'EVERYONE',
    num_args: 0,
    options: [],

    async execute(message, args, extra) {
        const module_handler = extra.module_handler;

        const embed = new EmbedBuilder()
            .setTitle('CADBot Commands')
            .setColor(0x5865F2)
            .setTimestamp();

        for (const [, mod] of module_handler.modules) {
            const lines = [];
            for (const [, cmd] of mod.commands) {
                if (cmd.no_slash) continue;
                lines.push(`\`/${cmd._resolved_slash_name || cmd.name}\` — ${cmd.description || 'No description'}`);
            }
            if (lines.length > 0) {
                embed.addFields({ name: mod.config.display_name, value: lines.join('\n') });
            }
        }

        await message.channel.send({ embeds: [embed] });
    },
};
