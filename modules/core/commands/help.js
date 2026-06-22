'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');

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
    MEMBER:   'Member',
    TRYOUT:   'Tryout',
    EVERYONE: 'Everyone',
};

module.exports = {
    name: 'help',
    description: 'Browse commands by permission tier.',
    permission: 'EVERYONE',
    options: [],

    async execute(message, args, extra) {
        const module_handler = extra.module_handler;
        const permissions    = extra.permissions;
        const interaction    = extra.interaction;

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

        let userTierIndex = 5;
        if (permissions.check('OWNER', message.member, message.author.id)) userTierIndex = 0;
        else if (permissions.check('ADMIN', message.member, message.author.id)) userTierIndex = 1;
        else if (permissions.check('CAPTAIN', message.member, message.author.id)) userTierIndex = 2;
        else if (permissions.check('MEMBER', message.member, message.author.id)) userTierIndex = 3;
        else if (permissions.check('TRYOUT', message.member, message.author.id)) userTierIndex = 4;

        const pages = TIER_ORDER.filter((t, i) => i >= userTierIndex && byTier[t].length > 0).reverse();

        const buildEmbed = (page) => {
            const tier = pages[page];
            const commands = byTier[tier];
            const lines = commands.map(c => `${c.name} — ${c.description}`);

            return new EmbedBuilder()
                .setTitle(`${TIER_EMOJI[tier]} ${TIER_LABEL[tier]} Commands`)
                .setDescription(lines.join('\n'))
                .setColor(0x5865F2)
                .setFooter({ text: `Page ${page + 1} of ${pages.length} — ${commands.length} command${commands.length !== 1 ? 's' : ''}` })
                .setTimestamp();
        };

        const buildRow = (page) => {
            const prevTier = page > 0 ? pages[page - 1] : null;
            const nextTier = page < pages.length - 1 ? pages[page + 1] : null;

            const row = new ActionRowBuilder();

            if (prevTier) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('help_prev')
                        .setLabel(`◀ ${TIER_EMOJI[prevTier]} ${TIER_LABEL[prevTier]}`)
                        .setStyle(ButtonStyle.Secondary),
                );
            } else {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('help_prev_0')
                        .setLabel('◀')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                );
            }

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('help_cur')
                    .setLabel(`${TIER_EMOJI[pages[page]]} ${TIER_LABEL[pages[page]]}`)
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true),
            );

            if (nextTier) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('help_next')
                        .setLabel(`${TIER_EMOJI[nextTier]} ${TIER_LABEL[nextTier]} ▶`)
                        .setStyle(ButtonStyle.Secondary),
                );
            } else {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId('help_next_0')
                        .setLabel('▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                );
            }

            return row;
        };

        await message.channel.send({ embeds: [buildEmbed(0)], components: [buildRow(0)] });
        const sent = await interaction.fetchReply();

        let currentPage = 0;
        const collector = sent.createMessageComponentCollector({ time: 120000 });

        collector.on('collect', async (btnInteraction) => {
            if (btnInteraction.user.id !== interaction.user.id) {
                await btnInteraction.reply({ content: 'This pagination is not for you — run `/help` yourself.', flags: MessageFlags.Ephemeral });
                return;
            }

            if (btnInteraction.customId === 'help_prev' && currentPage > 0) currentPage--;
            else if (btnInteraction.customId === 'help_next' && currentPage < pages.length - 1) currentPage++;
            else {
                await btnInteraction.deferUpdate();
                return;
            }

            await btnInteraction.update({ embeds: [buildEmbed(currentPage)], components: [buildRow(currentPage)] });
        });

        collector.on('end', async () => {
            try { await interaction.editReply({ components: [] }); } catch (_) {}
        });
    },
};
