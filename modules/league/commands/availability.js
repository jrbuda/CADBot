'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { formatWeeklySchedule } = require('../lib/availability_utils.js');

module.exports = {
    name: 'availability',
    description: 'View and manage your weekly availability for scrims.',
    permission: 'EVERYONE',
    no_defer: true,
    num_args: 0,
    options: [
        {
            name: 'player',
            description: 'View another player\'s availability (read-only)',
            type: 'USER',
            required: false,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target    = interaction.options.getUser('player');
        const targetId  = target ? target.id : message.author.id;
        const isSelf    = targetId === message.author.id;

        const availability = data.getAvailability();
        const avail        = availability[targetId] || null;

        const config   = data.getConfig();
        const timezone = config.timezone || 'America/New_York';

        const schedule = avail ? formatWeeklySchedule(avail) : '_No availability set yet._';

        // Count active overrides (future dates only)
        const today = new Date().toISOString().split('T')[0];
        const overrideCount = avail?.overrides
            ? Object.keys(avail.overrides).filter(d => d >= today).length
            : 0;

        const embed = new EmbedBuilder()
            .setTitle(isSelf ? 'Your Availability' : `${target.globalName || target.username}'s Availability`)
            .setDescription(schedule)
            .setColor(0x5865F2)
            .setFooter({ text: `All times in ${timezone}` })
            .setTimestamp();

        if (overrideCount > 0) {
            embed.addFields({ name: 'Date Overrides', value: `${overrideCount} upcoming override(s) set.` });
        }

        // Only show edit buttons for your own availability
        if (isSelf) {
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('AVAIL_SET_WEEKDAYS')
                    .setLabel('Set Weekdays (Mon–Fri)')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('AVAIL_SET_WEEKEND')
                    .setLabel('Set Weekend (Sat–Sun)')
                    .setStyle(ButtonStyle.Primary),
            );
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('AVAIL_ADD_OVERRIDE')
                    .setLabel('Add Date Override')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('AVAIL_VIEW_OVERRIDES')
                    .setLabel('View Overrides')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('AVAIL_CLEAR_ALL')
                    .setLabel('Clear All')
                    .setStyle(ButtonStyle.Danger),
            );

            await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },
};
