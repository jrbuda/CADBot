'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { formatWeeklySchedule, comparePlayerAvailability, formatDate } = require('../lib/availability_utils.js');

module.exports = {
    name: 'availability',
    description: 'View or manage your availability, or compare two players.',
    permission: 'EVERYONE',
    no_defer: true,
    num_args: 0,
    options: [
        {
            name: 'player',
            description: 'View another player\'s availability (only shows players who have set it)',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
        {
            name: 'compare',
            description: 'Compare YOUR availability with this player (only shows players who have set it)',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

        const focused = interaction.options.getFocused(true);
        const query   = focused.value.toLowerCase();

        // Only surface players who have actually set at least one day of availability
        const availability = data.getAvailability();
        const players      = data.getPlayers();

        const choices = Object.values(availability)
            .filter(a => {
                if (a.discord_id === interaction.user.id) return false; // never show yourself
                const hasAvail = Object.values(a.weekly || {}).some(day => day.length > 0);
                if (!hasAvail) return false;
                const p = players[a.discord_id];
                if (!p?.riot_id) return false;
                return p.riot_id.toLowerCase().includes(query) || a.discord_id.includes(query);
            })
            .slice(0, 25)
            .map(a => {
                const p = players[a.discord_id];
                return { name: p.riot_id, value: a.discord_id };
            });

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target_id  = interaction.options.getString('player')  || null;
        const compare_id = interaction.options.getString('compare') || null;

        // ── Compare mode ─────────────────────────────────────────────────────
        if (compare_id) {
            const availability = data.getAvailability();
            const p1Id    = message.author.id;
            const p1Avail = availability[p1Id];
            const p2Avail = availability[compare_id];

            if (!p1Avail) {
                await interaction.reply({ content: "You haven't set your availability yet. Use `/availability` to set it up first.", flags: MessageFlags.Ephemeral });
                return;
            }
            if (!p2Avail) {
                await interaction.reply({ content: `<@${compare_id}> hasn't set their availability yet.`, flags: MessageFlags.Ephemeral });
                return;
            }

            const compareData = comparePlayerAvailability(p1Id, compare_id, availability, 7);
            const p1Tz = p1Avail.timezone || 'America/New_York';
            const p2Tz = p2Avail.timezone || 'America/New_York';

            // Get display name for p2
            let p2Name = `<@${compare_id}>`;
            try {
                const p2Player = data.getPlayer(compare_id);
                if (p2Player?.riot_id) p2Name = p2Player.riot_id.split('#')[0];
            } catch (_) {}

            let hasOverlap = false;
            const embed = new EmbedBuilder()
                .setTitle('Availability Comparison')
                .setDescription(`**You** vs **${p2Name}**\nTimes shown in your local timezone via Discord.`)
                .setColor(0x5865F2)
                .setFooter({ text: `Your TZ: ${p1Tz}  ·  Their TZ: ${p2Tz}` });

            for (const day of compareData) {
                const dayLabel = formatDate(day.date);
                if (day.overlaps.length === 0) {
                    embed.addFields({ name: dayLabel, value: '— No overlap', inline: false });
                } else {
                    hasOverlap = true;
                    const windows = day.overlaps
                        .map(o => `✅ <t:${o.start_unix}:t> – <t:${o.end_unix}:t>`)
                        .join('\n');
                    embed.addFields({ name: dayLabel, value: windows, inline: false });
                }
            }

            if (!hasOverlap) {
                embed.setDescription(
                    `**You** vs **${p2Name}**\n` +
                    `No overlapping free time found in the next 7 days.\n` +
                    `Make sure both players have set their full weekly schedule.`
                );
            }

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
        }

        // ── View / edit mode ─────────────────────────────────────────────────
        const targetId = target_id || message.author.id;
        const isSelf   = targetId === message.author.id;

        const availability = data.getAvailability();
        const avail        = availability[targetId] || null;
        const config       = data.getConfig();

        const userTz   = avail?.timezone || config.timezone || 'America/New_York';
        const schedule = avail ? formatWeeklySchedule(avail) : '_No availability set yet._';

        const today = new Date().toISOString().split('T')[0];
        const overrideCount = avail?.overrides
            ? Object.keys(avail.overrides).filter(d => d >= today).length
            : 0;

        // Get display name for the target when viewing someone else
        let displayName = 'Your';
        if (!isSelf) {
            try {
                const p = data.getPlayer(targetId);
                displayName = p?.riot_id ? p.riot_id.split('#')[0] : `<@${targetId}>`;
            } catch (_) { displayName = `<@${targetId}>`; }
        }
        const embedTitle = isSelf ? 'Your Availability' : `${displayName}'s Availability`;

        const embed = new EmbedBuilder()
            .setTitle(embedTitle)
            .setDescription(schedule)
            .setColor(0x5865F2)
            .setFooter({ text: `Timezone: ${userTz}` })
            .setTimestamp();

        if (overrideCount > 0) {
            embed.addFields({ name: 'Date Overrides', value: `${overrideCount} upcoming override(s) set.` });
        }

        if (!isSelf) {
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
        }

        // Self view — show edit buttons
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('AVAIL_SET_WEEKDAYS').setLabel('Set Weekdays (Mon–Fri)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('AVAIL_SET_WEEKEND').setLabel('Set Weekend (Sat–Sun)').setStyle(ButtonStyle.Primary),
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('AVAIL_ADD_OVERRIDE').setLabel('Add Date Override').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('AVAIL_VIEW_OVERRIDES').setLabel('View Overrides').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('AVAIL_CLEAR_ALL').setLabel('Clear All').setStyle(ButtonStyle.Danger),
        );
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('AVAIL_SET_TZ').setLabel(`Timezone: ${userTz}`).setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [embed], components: [row1, row2, row3], flags: MessageFlags.Ephemeral });
    },
};
