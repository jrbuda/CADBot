'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { formatWeeklySchedule, comparePlayerAvailability, formatDate, findTeamWindowsUTC } = require('../lib/availability_utils.js');

module.exports = {
    name: 'availability',
    description: 'View or manage your availability, or compare two players.',
    permission: 'EVERYONE',
    no_defer: true,
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
        {
            name: 'team',
            description: 'View your team\'s availability overlap for the next 7 days',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction, extra) {
        const data = extra.data;

        const focused = interaction.options.getFocused(true);
        const query   = focused.value.toLowerCase();

        if (focused.name === 'team') {
            // Return teams the user is on (or all teams for admin)
            const teams = data.getTeams();
            const players = data.getPlayers();
            const myPlayer = players[interaction.user.id];
            let choices = Object.values(teams);
            if (myPlayer?.team_id) {
                choices = choices.filter(t => t.id === myPlayer.team_id || t.captain_id === interaction.user.id);
            } else {
                const captainTeam = Object.values(teams).find(t => t.captain_id === interaction.user.id);
                if (captainTeam) choices = [captainTeam];
                else choices = Object.values(teams); // admin sees all
            }
            choices = choices
                .filter(t => t.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(t => ({ name: t.name, value: t.id }));
            await interaction.respond(choices);
            return;
        }

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
        const team_id    = interaction.options.getString('team')    || null;

        // ── Team availability view ────────────────────────────────────────────
        if (team_id) {
            const team = data.getTeam(team_id);
            if (!team) {
                await interaction.reply({ content: 'Team not found.', flags: MessageFlags.Ephemeral });
                return;
            }

            const members = data.getTeamPlayers(team_id).filter(p => p.riot_id);
            if (members.length === 0) {
                await interaction.reply({ content: `**${team.name}** has no linked players.`, flags: MessageFlags.Ephemeral });
                return;
            }

            const memberIds = members.map(p => p.discord_id);
            const availability = data.getAvailability();
            const config = data.getConfig();
            const timezone = config.timezone || 'America/New_York';

            // Build 7-day overview
            const dayLines = [];
            for (let i = 0; i < 7; i++) {
                const d = new Date();
                d.setDate(d.getDate() + i);
                const dateStr = d.toISOString().split('T')[0];

                const win5 = findTeamWindowsUTC(memberIds, dateStr, availability, 5);
                const win1 = findTeamWindowsUTC(memberIds, dateStr, availability, 1);

                let indicator, detail;
                if (win5.length > 0) {
                    indicator = '\uD83D\uDFE2';
                    detail = win5.map(w => `<t:${w.start_unix}:t>–<t:${w.end_unix}:t>`).join(', ');
                } else if (win1.length > 0) {
                    const win3 = findTeamWindowsUTC(memberIds, dateStr, availability, 3);
                    if (win3.length > 0) {
                        indicator = '\uD83D\uDFE1';
                        detail = `${win1[0].player_count}/5 available` + (win3.length > 0 ? ` (${win3[0].player_count}+: ${win3.map(w => `<t:${w.start_unix}:t>–<t:${w.end_unix}:t>`).join(', ')})` : '');
                    } else {
                        indicator = '\uD83D\uDD34';
                        detail = `${win1[0].player_count}/5 available`;
                    }
                } else {
                    indicator = '\u26AB';
                    detail = 'No data';
                }

                const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone });
                dayLines.push(`${indicator} **${dayLabel}** — ${detail}`);
            }

            const embed = new EmbedBuilder()
                .setTitle(`${team.name} \u2014 Availability`)
                .setDescription(dayLines.join('\n'))
                .setColor(0x5865F2)
                .setFooter({ text: `\uD83D\uDFE2 5+ available  \uD83D\uDFE1 3-4  \uD83D\uDD34 1-2  \u26AB No data  |  ${memberIds.length} players total` });

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
        }

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
            } catch (e) { this.logger.warn('[availability] Could not resolve display name for compare target ' + compare_id + ': ' + e.message); }

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
            } catch (e) {
                this.logger.warn('[availability] Could not resolve display name for ' + targetId + ': ' + e.message);
                displayName = `<@${targetId}>`;
            }
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
