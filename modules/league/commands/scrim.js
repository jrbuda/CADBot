'use strict';
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
const { findScrimSlots, findTeamWindowsUTC, parseTime, toUnixTimestamp } = require('../lib/availability_utils.js');
const { randomUUID } = require('crypto');

// In-memory cache: scrim slot selections pending captain confirmation
// key: cache_id (12-char), value: { team1_id, team2_id, slots, include_subs, allow_fill, requested_by, timezone, mode }
const pendingSlots = new Map();

function buildSlotOptions(slots, team1Name, team2Name, config, cache_id) {
    const tz = config.timezone || 'America/New_York';
    const options = slots.map((slot, i) => {
        const startDate = new Date(slot.start_unix * 1000);
        const endDate   = new Date(slot.end_unix   * 1000);
        const fmtOpts   = { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true };
        const dateStr   = startDate.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
        const startStr  = startDate.toLocaleTimeString('en-US', fmtOpts);
        const endStr    = endDate.toLocaleTimeString('en-US', fmtOpts);
        const label     = `${dateStr} \u2014 ${startStr}\u2013${endStr}`;
        let desc;
        if (team2Name) {
            desc = `${team1Name}: ${slot.t1_count} \u00b7 ${team2Name}: ${slot.t2_count} players`;
        } else {
            desc = `${team1Name}: ${slot.player_count || slot.t1_count} players`;
        }
        return new StringSelectMenuOptionBuilder()
            .setLabel(label.substring(0, 100))
            .setDescription(desc.substring(0, 100))
            .setValue(`${cache_id}:${i}`);
    });

    options.push(new StringSelectMenuOptionBuilder()
        .setLabel('\uD83D\uDD8A\uFE0F Enter time manually...')
        .setDescription('Specify a custom date and time')
        .setValue(`${cache_id}:manual`));

    return options;
}

module.exports = {
    name: 'scrim',
    description: 'Request a scrim against another team or schedule an external scrim.',
    permission: 'CAPTAIN',
    ephemeral: true,
    subcommands: [
        {
            name: 'internal',
            description: 'Challenge another team in the league to a scrim',
            options: [
                {
                    name: 'vs',
                    description: 'Opponent team',
                    type: 'STRING',
                    required: true,
                    autocomplete: true,
                },
                {
                    name: 'date',
                    description: 'Specific date (YYYY-MM-DD) \u2014 bypasses slot selection',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'time',
                    description: 'Start time (e.g. 7pm, 19:00) \u2014 requires date',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'include_subs',
                    description: 'Count substitutes toward the minimum 5 players per team',
                    type: 'BOOLEAN',
                    required: false,
                },
                {
                    name: 'allow_fill',
                    description: 'Let non-team members click to show interest in filling an open spot',
                    type: 'BOOLEAN',
                    required: false,
                },
                {
                    name: 'expires_in',
                    description: 'Hours until the slot selection expires (1-72, default 24)',
                    type: 'INTEGER',
                    required: false,
                    min_value: 1,
                    max_value: 72,
                },
            ],
        },
        {
            name: 'external',
            description: 'Schedule a scrim against a team outside the league',
            options: [
                {
                    name: 'opponent_name',
                    description: 'Name of the external team (optional)',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'date',
                    description: 'Date (YYYY-MM-DD) \u2014 skips slot selection when provided',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'time',
                    description: 'Start time (e.g. 7pm, 19:00) \u2014 requires date',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'include_subs',
                    description: 'Count substitutes toward the minimum 5 players per team',
                    type: 'BOOLEAN',
                    required: false,
                },
                {
                    name: 'allow_fill',
                    description: 'Let non-team members click to show interest in filling an open spot',
                    type: 'BOOLEAN',
                    required: false,
                },
                {
                    name: 'expires_in',
                    description: 'Hours until the proposal expires (1-72, default 24)',
                    type: 'INTEGER',
                    required: false,
                    min_value: 1,
                    max_value: 72,
                },
            ],
        },
    ],

    async autocomplete(interaction, extra) {
        const data = extra.data;

        const focused = interaction.options.getFocused().toLowerCase();
        const teams   = data.getTeams();

        // Only the 'internal' subcommand has autocomplete (vs: team picker)
        const captainTeam = data.getTeamByCaptain(interaction.user.id);
        const choices = Object.values(teams)
            .filter(t => t.name.toLowerCase().includes(focused) && t.id !== captainTeam?.id)
            .slice(0, 25)
            .map(t => ({ name: t.name, value: t.id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;
        const subcommand  = interaction.options.getSubcommand();

        const date_input   = interaction.options.getString('date');
        const time_input   = interaction.options.getString('time');
        const include_subs = interaction.options.getBoolean('include_subs') ?? false;
        const allow_fill   = interaction.options.getBoolean('allow_fill')   ?? false;
        const expires_in   = interaction.options.getInteger('expires_in')   ?? 24;

        // Validate requesting captain owns a team
        const my_team = data.getTeamByCaptain(message.author.id);
        if (!my_team) {
            await message.channel.send({ content: 'You are not set as a captain of any team.' });
            return;
        }

        const config       = data.getConfig();
        const timezone     = config.timezone || 'America/New_York';
        const availability = data.getAvailability();

        // Gather my team's players
        const all_players = data.getTeamPlayers(my_team.id);
        const filterFn = include_subs
            ? (p) => p.team_role && p.riot_id
            : (p) => p.team_type === 'Main' && p.riot_id;
        const my_ids = all_players.filter(filterFn).map(p => p.discord_id);

        // ── Manual override: captain provided date + time ────────────────────
        if (date_input || time_input) {
            if (!date_input || !time_input) {
                await message.channel.send({ content: 'Both `date` and `time` are required together.' });
                return;
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date_input)) {
                await message.channel.send({ content: 'Invalid date \u2014 use `YYYY-MM-DD`, e.g. `2026-06-25`.' });
                return;
            }
            const timeMins = parseTime(time_input);
            if (timeMins === null) {
                await message.channel.send({ content: `Invalid time \u2014 use \`7pm\`, \`7:30pm\`, or \`19:00\`.` });
                return;
            }
            const [y, mo, dy] = date_input.split('-').map(Number);
            const start_unix = toUnixTimestamp(y, mo - 1, dy, timeMins, timezone);

            if (subcommand === 'internal') {
                const opp_team_id = interaction.options.getString('vs');
                await handleInternalScrimSent(message, data, interaction, my_team, opp_team_id,
                    start_unix, include_subs, allow_fill, my_ids);
            } else {
                await handleExternalScrimProposal(message, data, interaction, my_team,
                    [{ start_unix, player_count: my_ids.length }], include_subs, allow_fill, timezone, expires_in);
            }
            return;
        }

        // ── Internal scrim ──────────────────────────────────────────────────
        if (subcommand === 'internal') {
            const opp_team_id = interaction.options.getString('vs');
            const opp_team = data.getTeam(opp_team_id);
            if (!opp_team) {
                await message.channel.send({ content: 'Opponent team not found.' });
                return;
            }
            if (my_team.id === opp_team.id) {
                await message.channel.send({ content: 'You cannot scrim your own team.' });
                return;
            }

            const opp_players = data.getTeamPlayers(opp_team.id);
            const opp_ids = opp_players.filter(filterFn).map(p => p.discord_id);

            const slots = findScrimSlots(my_ids, opp_ids, availability, {
                days:         14,
                max_slots:    5,
                min_per_team: 5,
            });

            if (slots.length === 0) {
                const cache_id = randomUUID().replace(/-/g, '').substring(0, 12);
                pendingSlots.set(cache_id, {
                    team1_id:    my_team.id,
                    team2_id:    opp_team.id,
                    slots:       [],
                    include_subs,
                    allow_fill,
                    requested_by: message.author.id,
                    timezone,
                    mode: 'internal',
                });
                setTimeout(() => pendingSlots.delete(cache_id), 24 * 60 * 60 * 1000);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`SCRIM_FALLBACK_MANUAL_${cache_id}`)
                        .setLabel('Enter Time Manually')
                        .setStyle(ButtonStyle.Primary),
                );

                await message.channel.send({
                    content: `No overlapping availability found between **${my_team.name}** and **${opp_team.name}** in the next 14 days.\n` +
                             `Make sure both teams have set their availability with \`/availability\`.\n` +
                             `Click below to schedule a specific time instead.`,
                    components: [row],
                });
                return;
            }

            const cache_id = randomUUID().replace(/-/g, '').substring(0, 12);
            pendingSlots.set(cache_id, {
                team1_id:    my_team.id,
                team2_id:    opp_team.id,
                slots,
                include_subs,
                allow_fill,
                requested_by: message.author.id,
                timezone,
                mode: 'internal',
            });
            setTimeout(() => pendingSlots.delete(cache_id), expires_in * 60 * 60 * 1000);

            const options = buildSlotOptions(slots, my_team.name, opp_team.name, config, cache_id);
            const select = new StringSelectMenuBuilder()
                .setCustomId('SCRIM_SLOT_SELECT')
                .setPlaceholder('Pick a time slot...')
                .addOptions(options);

            const row = new ActionRowBuilder().addComponents(select);
            const embed = new EmbedBuilder()
                .setTitle(`Scrim Request \u2014 ${my_team.name} vs ${opp_team.name}`)
                .setDescription(
                    `Found **${slots.length}** available time slot${slots.length !== 1 ? 's' : ''} in the next 14 days.\n` +
                    `Select a slot below to send the request to **${opp_team.name}**'s captain, or choose **Enter manually**.\n\n` +
                    (include_subs ? '\u2705 Substitutes included\n' : '') +
                    (allow_fill   ? '\u2705 Fill interest enabled' : '')
                )
                .setColor(0xC89B3C)
                .setFooter({ text: `Times shown in ${timezone}. Discord timestamps appear in your local time.` });

            await message.channel.send({ embeds: [embed], components: [row] });
            this.logger.info(`[scrim] ${message.author.id} opened scrim request ${my_team.name} vs ${opp_team.name}`);
            return;
        }

        // ── External scrim ──────────────────────────────────────────────────
        const opponent_name = interaction.options.getString('opponent_name');

        const slots = [];
        for (let i = 0; i < 14; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            const wins = findTeamWindowsUTC(my_ids, dateStr, availability, 5);
            for (const w of wins) {
                slots.push({ ...w, t1_count: w.player_count, dateStr });
            }
        }

        const topSlots = slots.slice(0, 5);

        if (topSlots.length === 0) {
            await message.channel.send({
                content: `No 5-player windows found for **${my_team.name}** in the next 14 days.\n` +
                         `Make sure your team has set availability with \`/availability\`.\n` +
                         `Tip: use \`date\` and \`time\` to schedule a specific time.`,
            });
            return;
        }

        const cache_id = randomUUID().replace(/-/g, '').substring(0, 12);
        pendingSlots.set(cache_id, {
            team1_id:    my_team.id,
            team2_id:    '',
            slots:       topSlots,
            include_subs,
            allow_fill,
            requested_by: message.author.id,
            timezone,
            mode: 'external',
        });
        setTimeout(() => pendingSlots.delete(cache_id), expires_in * 60 * 60 * 1000);

        const options = buildSlotOptions(topSlots, my_team.name, null, config, cache_id);
        const select = new StringSelectMenuBuilder()
            .setCustomId('SCRIM_SLOT_SELECT')
            .setPlaceholder('Pick a time slot...')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);
        const descParts = [
            `Found **${topSlots.length}** window(s) with 5+ players in the next 14 days.`,
            `Select a slot to propose to your team, or choose **Enter manually**.`,
            '',
        ];
        if (opponent_name) descParts.push(`\uD83D\uDC65 **Opponent:** ${opponent_name}`);
        if (include_subs) descParts.push('\u2705 Substitutes included');
        if (allow_fill)   descParts.push('\u2705 Fill interest enabled');

        const embed = new EmbedBuilder()
            .setTitle(`External Scrim \u2014 ${my_team.name}`)
            .setDescription(descParts.join('\n'))
            .setColor(0xC89B3C)
            .setFooter({ text: `Times shown in ${timezone}.` });

        await message.channel.send({ embeds: [embed], components: [row] });
        this.logger.info(`[scrim] ${message.author.id} opened external scrim request for ${my_team.name}`);
    },

    // Expose the pendingSlots cache so events.js can read it
    pendingSlots,
};

// ── Helpers (also used by events.js) ───────────────────────────────────────────

async function handleInternalScrimSent(message, data, interaction, my_team, opp_team_id,
    start_unix, include_subs, allow_fill, my_ids) {
    const opp_team = data.getTeam(opp_team_id);
    if (!opp_team) {
        await message.channel.send({ content: 'Opponent team not found.' });
        return;
    }

    const config = data.getConfig();
    if (!config.scrim_channel_id) {
        await message.channel.send({ content: 'No scrim channel configured. Admins must use `/set_channel` first.' });
        return;
    }

    const scrim_id = randomUUID();
    const scrims = data.getScrims();
    scrims[scrim_id] = {
        id:             scrim_id,
        team1_id:       my_team.id,
        team2_id:       opp_team.id,
        status:         'pending',
        scheduled_time: new Date(start_unix * 1000).toISOString(),
        discord_event_id: '',
        requested_by:   message.author.id,
        include_subs,
        allow_fill,
        fill_interests: [],
        result:         null,
        result_embed_posted: false,
        result_message_id:   '',
        players_team1:  [],
        players_team2:  [],
        created_at:     new Date().toISOString(),
    };
    data.saveScrims(scrims);

    const scrimChannel = await message.guild.channels.fetch(config.scrim_channel_id).catch(() => null);
    if (!scrimChannel) {
        await message.channel.send({ content: 'Scrim channel not found. Contact an admin.' });
        return;
    }

    const { ButtonBuilder, ButtonStyle } = require('discord.js');
    const acceptRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`SCRIM_ACCEPT_${scrim_id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`SCRIM_DECLINE_${scrim_id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );

    const embed = new EmbedBuilder()
        .setTitle(`Scrim Request \u2014 ${my_team.name} vs ${opp_team.name}`)
        .setDescription(
            `**${my_team.name}** has challenged **${opp_team.name}** to a scrim!\n\n` +
            `\uD83D\uDCC5 **Date:** <t:${start_unix}:D>\n` +
            `\u23F0 **Time:** <t:${start_unix}:t>\n` +
            `\uD83D\uDC65 **${my_team.name} players:** ${my_ids.length}\n\n` +
            `<@${opp_team.captain_id || ''}>, please **Accept** or **Decline** this request.\n` +
            (include_subs ? '\u2705 Substitutes included\n' : '') +
            (allow_fill   ? '\u2705 Fill interest open' : '')
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    await scrimChannel.send({ content: opp_team.captain_id ? `<@${opp_team.captain_id}>` : '', embeds: [embed], components: [acceptRow] });
    await message.channel.send({ content: `\u2705 Scrim request sent to **${opp_team.name}**! Check <#${config.scrim_channel_id}>.` });
}

async function handleExternalScrimProposal(message, data, interaction, my_team,
    slots, include_subs, allow_fill, timezone, expires_in) {
    const cache_id = randomUUID().replace(/-/g, '').substring(0, 12);
    const { pendingSlots } = require('./scrim.js');
    pendingSlots.set(cache_id, {
        team1_id:    my_team.id,
        team2_id:    '',
        slots,
        include_subs,
        allow_fill,
        requested_by: message.author.id,
        timezone,
        mode: 'external_proposal',
    });
    setTimeout(() => pendingSlots.delete(cache_id), (expires_in || 24) * 60 * 60 * 1000);

    await postExternalScrimEmbed(message, data, my_team, slots, cache_id, include_subs, allow_fill, message.author.id);
}

async function postExternalScrimEmbed(messageOrChannel, data, my_team, slots, cache_id, include_subs, allow_fill, captainId) {
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const dateLabel = slots[0]?.dateStr || 'TBD';

    let slotDesc = '';
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const startLabel = `<t:${s.start_unix}:t>`;
        const endLabel = `<t:${s.end_unix}:t>`;
        slotDesc += `\uD83D\uDD50 **Slot ${i + 1}:** <t:${s.start_unix}:D> ${startLabel} \u2013 ${endLabel} \u2014 **[I Can Make It](http://btn/${cache_id}_${i})** (0)\n\n`;
    }

    const rows = [];
    for (let i = 0; i < slots.length; i++) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`SCRIM_SLOT_INTEREST_${cache_id}_${i}`)
                .setLabel(`Slot ${i + 1}: I Can Make It`)
                .setStyle(ButtonStyle.Primary),
        ));
    }

    const captainRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`SCRIM_ADD_SLOT_${cache_id}`)
            .setLabel('+ Add Time Slot')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`SCRIM_CONFIRM_${cache_id}`)
            .setLabel('\u2705 Confirm Time')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`SCRIM_CANCEL_PRO_${cache_id}`)
            .setLabel('\u274C Cancel')
            .setStyle(ButtonStyle.Danger),
    );

    const embed = new EmbedBuilder()
        .setTitle(`\uD83D\uDCCB External Scrim \u2014 ${my_team.name}`)
        .setDescription(
            `**${my_team.name}** is planning a scrim against an external team.\n\n` +
            `Pick the slots you can make:\n${slotDesc}\n` +
            (include_subs ? '\u2705 Substitutes included\n' : '') +
            (allow_fill   ? '\u2705 Fill interest open' : '')
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Cache: ${cache_id}` });

    if (typeof messageOrChannel?.channel?.send === 'function') {
        await messageOrChannel.channel.send({ embeds: [embed], components: [...rows, captainRow] });
    } else if (typeof messageOrChannel?.send === 'function') {
        await messageOrChannel.send({ embeds: [embed], components: [...rows, captainRow] });
    } else if (typeof messageOrChannel?.followUp === 'function') {
        await messageOrChannel.followUp({ embeds: [embed], components: [...rows, captainRow] });
    }
}
