'use strict';
const { EmbedBuilder } = require('discord.js');

const TIER_EMOJI = {
    OWNER:    '👑',
    ADMIN:    '🔧',
    CAPTAIN:  '⚔️',
    MEMBER:   '🛡️',
    TRYOUT:   '🔎',
    EVERYONE: '🌐',
};

const TIER_LABEL = {
    OWNER:    'Owner',
    ADMIN:    'Admin',
    CAPTAIN:  'Captain',
    MEMBER:   'Member (assigned to a team)',
    TRYOUT:   'Tryout',
    EVERYONE: 'Everyone',
};

module.exports = {
    name: 'help',
    description: 'List all available commands with their required permission tier.',
    permission: 'EVERYONE',
    num_args: 0,
    options: [],

    async execute(message, args, extra) {
        const module_handler = extra.module_handler;

        // Group commands by permission tier so the output is easy to scan
        // tier order: OWNER → ADMIN → CAPTAIN → MEMBER → TRYOUT → EVERYONE
        const TIER_ORDER = ['OWNER', 'ADMIN', 'CAPTAIN', 'MEMBER', 'TRYOUT', 'EVERYONE'];
        const byTier = {};
        for (const t of TIER_ORDER) byTier[t] = [];

        for (const [, mod] of module_handler.modules) {
            for (const [, cmd] of mod.commands) {
                if (cmd.no_slash) continue;
                const tier = (cmd.permission || 'EVERYONE').toUpperCase();
                const name = `\`/${cmd._resolved_slash_name || cmd.name}\``;
                byTier[tier]?.push({ name, description: cmd.description || 'No description' });
            }
        }

        const embed = new EmbedBuilder()
            .setTitle('CADBot Commands')
            .setDescription(
                TIER_ORDER
                    .filter(t => byTier[t].length > 0)
                    .map(t => `${TIER_EMOJI[t]} **${TIER_LABEL[t]}** — ${byTier[t].length} command${byTier[t].length !== 1 ? 's' : ''}`)
                    .join('\n')
            )
            .setColor(0x5865F2)
            .setFooter({ text: 'Member = linked + assigned to a team via /assign_player. Higher tiers can use all commands below them.' })
            .setTimestamp();

        for (const tier of TIER_ORDER) {
            if (byTier[tier].length === 0) continue;
            const lines = byTier[tier].map(c => `${c.name} — ${c.description}`);
            embed.addFields({
                name: `${TIER_EMOJI[tier]} ${TIER_LABEL[tier]}`,
                value: lines.join('\n'),
            });
        }

        await message.channel.send({ embeds: [embed] });
    },
};
