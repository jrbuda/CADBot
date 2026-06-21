'use strict';
const {
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel,
    MessageFlags,
} = require('discord.js');

const { lookupRiotId } = require('./lib/riot_api.js');
const { formatDate, formatTime, toUnixTimestamp, DAY_NAMES, parseTime, formatWeeklySchedule, TIMEZONE_OPTIONS } = require('./lib/availability_utils.js');
const { randomUUID }  = require('crypto');

// These are assigned from the shared core singletons in register_handlers().
// Using the shared DataManager (rather than a second instance) guarantees the
// event handlers and slash-command handlers read/write the same cached state.
let logger;
let data;
let perms;

// ── Custom ID constants ───────────────────────────────────────────────────────
const CID = {
    LINK_BUTTON:          'LEAGUE_LINK_BUTTON',
    LINK_MODAL:           'LEAGUE_LINK_MODAL',
    AVAIL_WEEKDAYS:       'AVAIL_SET_WEEKDAYS',
    AVAIL_WEEKEND:        'AVAIL_SET_WEEKEND',
    AVAIL_OVERRIDE:       'AVAIL_ADD_OVERRIDE',
    AVAIL_VIEW_OVERRIDES: 'AVAIL_VIEW_OVERRIDES',
    AVAIL_CLEAR:          'AVAIL_CLEAR_ALL',
    AVAIL_WEEKDAYS_MODAL: 'AVAIL_WEEKDAYS_MODAL',
    AVAIL_WEEKEND_MODAL:  'AVAIL_WEEKEND_MODAL',
    AVAIL_OVERRIDE_MODAL: 'AVAIL_OVERRIDE_MODAL',
    AVAIL_SET_TZ:         'AVAIL_SET_TZ',
    AVAIL_TZ_SELECT:      'AVAIL_TZ_SELECT',
    SCRIM_SLOT_SELECT:    'SCRIM_SLOT_SELECT',
    SCRIM_ACCEPT:         'SCRIM_ACCEPT',      // prefix: SCRIM_ACCEPT_<scrim_id>
    SCRIM_DECLINE:        'SCRIM_DECLINE',     // prefix: SCRIM_DECLINE_<scrim_id>
    SCRIM_DISPUTE:        'SCRIM_DISPUTE',     // prefix: SCRIM_DISPUTE_<scrim_id>
    SCRIM_WIN_T1:         'SCRIM_WIN_T1',      // prefix: SCRIM_WIN_T1_<scrim_id>
    SCRIM_WIN_T2:         'SCRIM_WIN_T2',      // prefix: SCRIM_WIN_T2_<scrim_id>
    SCRIM_EDIT:           'SCRIM_EDIT',        // prefix: SCRIM_EDIT_<scrim_id>
    SCRIM_EDIT_MODAL:     'SCRIM_EDIT_MODAL',  // prefix: SCRIM_EDIT_MODAL_<scrim_id>
    RECORD_SELECT:        'RECORD_SCRIM_SELECT',
    RECORD_RESULT_MODAL:  'RECORD_RESULT_MODAL', // prefix: RECORD_RESULT_MODAL_<scrim_id>
    GAME_INTEREST:      'GAME_INTEREST',   // prefix: GAME_INTEREST_<session_id>
    FILL_INTEREST:        'FILL_INTEREST',     // prefix: FILL_INTEREST_<scrim_id>
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeModal(customId, title, inputs) {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
    for (const { id, label, placeholder, style, required, value } of inputs) {
        const input = new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label)
            .setStyle(style || TextInputStyle.Short)
            .setRequired(required ?? true);
        if (placeholder) input.setPlaceholder(placeholder);
        if (value)       input.setValue(value);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return modal;
}

function getOrCreateAvail(discord_id) {
    const availability = data.getAvailability();
    if (!availability[discord_id]) {
        availability[discord_id] = {
            discord_id,
            weekly: {
                monday: [], tuesday: [], wednesday: [], thursday: [],
                friday: [], saturday: [], sunday: [],
            },
            overrides: {},
        };
    }
    return { availability, avail: availability[discord_id] };
}

/**
 * Parses a comma-separated time range string into an array of { start, end } objects.
 * Accepts entries like "7pm-10pm", "19:00-22:00", or "none" / "" for empty.
 */
/**
 * Parses a comma-separated list of time ranges (e.g. "7pm-10pm, 19:00-22:00").
 * Returns { windows, errors } so callers can report exactly what went wrong.
 *
 * Accepted formats per time value:  7pm  |  7:30pm  |  19:00  |  7:00 PM
 * Cross-midnight ranges (8pm-2am) are rejected — Discord's day-based model
 * can't represent them. Users should split into same-day ranges.
 */
function parseTimeRanges(raw) {
    if (!raw || raw.trim().toLowerCase() === 'none' || raw.trim() === '-') {
        return { windows: [], errors: [] };
    }

    const windows = [];
    const errors  = [];
    const pad     = m => `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`;

    for (const segment of raw.split(',')) {
        const trimmed = segment.trim();
        if (!trimmed) continue;

        // Must be exactly "start-end" (one hyphen/en-dash separator)
        const parts = trimmed.split(/\s*[-–]\s*/);
        if (parts.length !== 2) {
            errors.push(`**"${trimmed}"** — expected a start and end separated by a hyphen, e.g. \`7pm-10pm\``);
            continue;
        }

        const [rawStart, rawEnd] = parts.map(s => s.trim());
        const startMins = parseTime(rawStart);
        const endMins   = parseTime(rawEnd);

        if (startMins === null) {
            errors.push(`**"${rawStart}"** is not a valid time — use \`7pm\`, \`7:30pm\`, or \`19:00\``);
            continue;
        }
        if (endMins === null) {
            errors.push(`**"${rawEnd}"** is not a valid time — use \`10pm\`, \`10:30pm\`, or \`22:00\``);
            continue;
        }
        if (endMins < startMins) {
            // Crossed midnight — e.g. 8pm-2am
            errors.push(`**"${trimmed}"** crosses midnight. Split it into two entries, e.g. \`8pm-11:59pm\` and add \`12am-2am\` as a separate range`);
            continue;
        }
        if (endMins === startMins) {
            errors.push(`**"${trimmed}"** — start and end can't be the same time`);
            continue;
        }

        windows.push({ start: pad(startMins), end: pad(endMins) });
    }

    return { windows, errors };
}

// ── Main event handler registration ──────────────────────────────────────────

function register_handlers(event_registry) {
    logger = event_registry.logger;
    data   = event_registry.data_manager;   // shared singleton (see EventRegistry)
    perms  = event_registry.permissions;     // shared singleton

    event_registry.register('interactionCreate', async (interaction) => {
        try {
            if (interaction.isButton())             await handleButton(interaction);
            else if (interaction.isModalSubmit())   await handleModal(interaction);
            else if (interaction.isStringSelectMenu()) await handleSelect(interaction);
        } catch (err) {
            logger.error('[league/events] Unhandled error: ' + err.message + '\n' + err.stack);
            try {
                const errMsg = { content: 'An error occurred. Please try again.', flags: MessageFlags.Ephemeral };
                if (interaction.replied || interaction.deferred) await interaction.followUp(errMsg);
                else await interaction.reply(errMsg);
            } catch (_) {}
        }
    });

    // ── Scrim result scheduler ────────────────────────────────────────────────
    // Poll every 60s. When a confirmed scrim reaches its start time, auto-post
    // the result embed (Win / Edit Players buttons) in the scrim channel and
    // ping both captains. Scrims whose start passed while the bot was offline
    // are caught on the next poll after startup.
    const client = event_registry.client;
    const POLL_MS = 60 * 1000;
    setInterval(() => {
        if (!client.isReady?.()) return;
        checkDueScrims(client).catch(err => logger.error('[scrim scheduler] ' + err.message));
    }, POLL_MS);
    logger.info('[scrim scheduler] Result poller started (60s interval).');
}

// ── Button handlers ───────────────────────────────────────────────────────────

async function handleButton(interaction) {
    const id = interaction.customId;

    // ─ /link button → show modal ────────────────────────────────────────────
    if (id === CID.LINK_BUTTON) {
        const modal = makeModal(CID.LINK_MODAL, 'Link Your Riot Account', [
            {
                id:          'riot_id_input',
                label:       'Riot ID',
                placeholder: 'GameName#NA1',
                style:       TextInputStyle.Short,
                required:    true,
            },
        ]);
        await interaction.showModal(modal);
        return;
    }

    // ─ Availability: Set weekdays ────────────────────────────────────────────
    if (id === CID.AVAIL_WEEKDAYS) {
        const { avail } = getOrCreateAvail(interaction.user.id);
        const days  = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
        const modal = makeModal(CID.AVAIL_WEEKDAYS_MODAL, 'Set Weekday Availability',
            days.map(d => {
                const existing = (avail.weekly[d] || [])
                    .map(w => `${w.start}-${w.end}`).join(', ') || '';
                return {
                    id:          d,
                    label:       d.charAt(0).toUpperCase() + d.slice(1),
                    placeholder: '7pm-10pm  or  19:00-22:00  (comma-separate multiple)',
                    style:       TextInputStyle.Short,
                    required:    false,
                    value:       existing,
                };
            })
        );
        await interaction.showModal(modal);
        return;
    }

    // ─ Availability: Set weekend ─────────────────────────────────────────────
    if (id === CID.AVAIL_WEEKEND) {
        const { avail } = getOrCreateAvail(interaction.user.id);
        const days  = ['saturday', 'sunday'];
        const modal = makeModal(CID.AVAIL_WEEKEND_MODAL, 'Set Weekend Availability',
            days.map(d => {
                const existing = (avail.weekly[d] || [])
                    .map(w => `${w.start}-${w.end}`).join(', ') || '';
                return {
                    id:          d,
                    label:       d.charAt(0).toUpperCase() + d.slice(1),
                    placeholder: '1pm-8pm  or  13:00-20:00  (comma-separate multiple)',
                    style:       TextInputStyle.Short,
                    required:    false,
                    value:       existing,
                };
            })
        );
        await interaction.showModal(modal);
        return;
    }

    // ─ Availability: Add date override ──────────────────────────────────────
    if (id === CID.AVAIL_OVERRIDE) {
        const modal = makeModal(CID.AVAIL_OVERRIDE_MODAL, 'Add Date Override', [
            {
                id:          'override_date',
                label:       'Date (YYYY-MM-DD)',
                placeholder: '2025-07-04',
                style:       TextInputStyle.Short,
                required:    true,
            },
            {
                id:          'override_times',
                label:       "Times (or 'none' for unavailable)",
                placeholder: '2pm-6pm, 8pm-11pm  — or  none',
                style:       TextInputStyle.Short,
                required:    true,
            },
        ]);
        await interaction.showModal(modal);
        return;
    }

    // ─ Availability: View overrides ──────────────────────────────────────────
    if (id === CID.AVAIL_VIEW_OVERRIDES) {
        const { avail } = getOrCreateAvail(interaction.user.id);
        const today    = new Date().toISOString().split('T')[0];
        const overrides = Object.entries(avail.overrides || {})
            .filter(([d]) => d >= today)
            .sort(([a], [b]) => a.localeCompare(b));

        if (overrides.length === 0) {
            await interaction.reply({ content: 'You have no upcoming date overrides.', flags: MessageFlags.Ephemeral });
            return;
        }

        const lines = overrides.map(([d, windows]) => {
            if (!windows) return `**${d}**: ❌ Unavailable`;
            const ranges = windows.map(w => `${w.start}–${w.end}`).join(', ');
            return `**${d}**: ${ranges}`;
        });

        await interaction.reply({
            content: '**Your upcoming date overrides:**\n' + lines.join('\n'),
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // ─ Availability: Clear all ───────────────────────────────────────────────
    if (id === CID.AVAIL_CLEAR) {
        const availability = data.getAvailability();
        delete availability[interaction.user.id];
        data.saveAvailability(availability);
        await interaction.reply({ content: 'Your availability has been cleared.', flags: MessageFlags.Ephemeral });
        return;
    }

    // ─ Availability: Set timezone button → shows select menu ─────────────────
    if (id === CID.AVAIL_SET_TZ) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(CID.AVAIL_TZ_SELECT)
            .setPlaceholder('Select your timezone...')
            .addOptions(TIMEZONE_OPTIONS.map(tz =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(tz.label)
                    .setDescription(tz.description)
                    .setValue(tz.value)
            ));

        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({
            content: 'Select your timezone. Times you enter in availability modals will be interpreted in this timezone.',
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // ─ Scrim: Accept ────────────────────────────────────────────────────────
    if (id.startsWith('SCRIM_ACCEPT_')) {
        await handleScrimAccept(interaction, id.replace('SCRIM_ACCEPT_', ''));
        return;
    }

    // ─ Scrim: Decline ───────────────────────────────────────────────────────
    if (id.startsWith('SCRIM_DECLINE_')) {
        await handleScrimDecline(interaction, id.replace('SCRIM_DECLINE_', ''));
        return;
    }

    // ─ Scrim result: Dispute ─────────────────────────────────────────────────
    if (id.startsWith('SCRIM_DISPUTE_')) {
        await handleScrimDispute(interaction, id.replace('SCRIM_DISPUTE_', ''));
        return;
    }

    // ─ Scrim result: Team 1 / Team 2 win buttons ─────────────────────────────
    if (id.startsWith('SCRIM_WIN_T1_')) {
        await handleScrimWinButton(interaction, id.replace('SCRIM_WIN_T1_', ''), 1);
        return;
    }
    if (id.startsWith('SCRIM_WIN_T2_')) {
        await handleScrimWinButton(interaction, id.replace('SCRIM_WIN_T2_', ''), 2);
        return;
    }

    // ─ Scrim result: Edit players button ─────────────────────────────────────
    if (id.startsWith('SCRIM_EDIT_')) {
        await handleScrimEditButton(interaction, id.replace('SCRIM_EDIT_', ''));
        return;
    }

    // ─ Tryout: Express interest ──────────────────────────────────────────────
    if (id.startsWith('GAME_INTEREST_')) {
        await handleGameInterest(interaction, id.replace('GAME_INTEREST_', ''));
        return;
    }

    // ─ Fill interest ─────────────────────────────────────────────────────────
    if (id.startsWith('FILL_INTEREST_')) {
        await handleFillInterest(interaction, id.replace('FILL_INTEREST_', ''));
        return;
    }
}

// ── Modal submit handlers ─────────────────────────────────────────────────────

async function handleModal(interaction) {
    const id = interaction.customId;

    // ─ Link modal submitted ──────────────────────────────────────────────────
    if (id === CID.LINK_MODAL) {
        await handleLinkModal(interaction);
        return;
    }

    // ─ Availability: Weekdays submitted ─────────────────────────────────────
    if (id === CID.AVAIL_WEEKDAYS_MODAL) {
        await handleAvailWeekdaysModal(interaction);
        return;
    }

    // ─ Availability: Weekend submitted ──────────────────────────────────────
    if (id === CID.AVAIL_WEEKEND_MODAL) {
        await handleAvailWeekendModal(interaction);
        return;
    }

    // ─ Availability: Override submitted ─────────────────────────────────────
    if (id === CID.AVAIL_OVERRIDE_MODAL) {
        await handleAvailOverrideModal(interaction);
        return;
    }

    // ─ Record result modal ───────────────────────────────────────────────────
    if (id.startsWith('RECORD_RESULT_MODAL_')) {
        await handleRecordResultModal(interaction, id.replace('RECORD_RESULT_MODAL_', ''));
        return;
    }

    // ─ Scrim edit-players modal ──────────────────────────────────────────────
    if (id.startsWith('SCRIM_EDIT_MODAL_')) {
        await handleScrimEditModal(interaction, id.replace('SCRIM_EDIT_MODAL_', ''));
        return;
    }
}

// ── Select menu handlers ──────────────────────────────────────────────────────

async function handleSelect(interaction) {
    const id = interaction.customId;

    // ─ Timezone selected ─────────────────────────────────────────────────────
    if (id === CID.AVAIL_TZ_SELECT) {
        const tz = interaction.values[0];
        const tzLabel = TIMEZONE_OPTIONS.find(o => o.value === tz)?.label || tz;
        const { availability, avail } = getOrCreateAvail(interaction.user.id);
        avail.timezone = tz;
        data.saveAvailability(availability);
        await interaction.update({
            content: `✅ Your timezone has been set to **${tzLabel}**.\nAll times you enter in availability modals will be interpreted as ${tz}.`,
            components: [],
        });
        return;
    }

    // ─ Scrim slot selected ───────────────────────────────────────────────────
    if (id === CID.SCRIM_SLOT_SELECT) {
        await handleScrimSlotSelect(interaction);
        return;
    }

    // ─ Record scrim selected ─────────────────────────────────────────────────
    if (id === CID.RECORD_SELECT) {
        await handleRecordScrimSelect(interaction);
        return;
    }
}

// ── Implementation: Link ──────────────────────────────────────────────────────

async function handleLinkModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const riotIdRaw = interaction.fields.getTextInputValue('riot_id_input').trim();

    if (!riotIdRaw.includes('#')) {
        await interaction.editReply({ content: 'Invalid Riot ID. Must include a tag, e.g. `PlayerName#NA1`.' });
        return;
    }

    try {
        const { account, summoner } = await lookupRiotId(riotIdRaw, logger);

        const players = data.getPlayers();
        players[interaction.user.id] = {
            discord_id:  interaction.user.id,
            riot_id:     `${account.gameName}#${account.tagLine}`,
            puuid:       account.puuid,
            summoner_id: summoner.id,
            account_id:  summoner.accountId,
            summoner_level: summoner.summonerLevel,
            team_id:     players[interaction.user.id]?.team_id   || '',
            team_role:   players[interaction.user.id]?.team_role || '',
            team_type:   players[interaction.user.id]?.team_type || '',
            is_tryout:   players[interaction.user.id]?.is_tryout ?? false,
            linked_at:   new Date().toISOString(),
        };
        data.savePlayers(players);

        const embed = new EmbedBuilder()
            .setTitle('Account Linked!')
            .setColor(0x57F287)
            .addFields(
                { name: 'Riot ID',      value: `\`${account.gameName}#${account.tagLine}\``, inline: true },
                { name: 'Summoner Lvl', value: String(summoner.summonerLevel),                inline: true },
            )
            .setFooter({ text: 'Use /profile to view your full profile.' });

        await interaction.editReply({ embeds: [embed] });
        logger.info(`[link] ${interaction.user.id} linked account ${account.gameName}#${account.tagLine}`);
    } catch (err) {
        logger.error('[link] Riot API error: ' + err.message);
        if (err.response?.status === 404) {
            await interaction.editReply({ content: `Riot ID \`${riotIdRaw}\` was not found. Double-check the name and tag.` });
        } else {
            await interaction.editReply({ content: 'Failed to fetch account data. Please try again later.' });
        }
    }
}

// ── Implementation: Availability ─────────────────────────────────────────────

async function handleAvailWeekdaysModal(interaction) {
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const { availability, avail } = getOrCreateAvail(interaction.user.id);

    const allErrors = [];
    for (const day of days) {
        try {
            const raw = interaction.fields.getTextInputValue(day);
            const { windows, errors } = parseTimeRanges(raw);
            if (errors.length > 0) {
                const label = day.charAt(0).toUpperCase() + day.slice(1);
                allErrors.push(`**${label}**:\n${errors.map(e => `  • ${e}`).join('\n')}`);
                // Keep the day's existing windows unchanged on error
            } else {
                avail.weekly[day] = windows;
            }
        } catch (_) {
            avail.weekly[day] = [];
        }
    }

    data.saveAvailability(availability);

    let content = (allErrors.length === 0 ? '✅ Weekday availability saved!' : '⚠️ Some entries were saved, but the following were rejected:')
        + '\n\n' + formatWeeklySchedule(avail);
    if (allErrors.length > 0) {
        content += '\n\n**Rejected entries:**\n' + allErrors.join('\n');
        content += '\n\n**Accepted formats:** `7pm-10pm` · `7:30pm-10:30pm` · `19:00-22:00`\nCross-midnight ranges (e.g. `8pm-2am`) must be split at midnight.';
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleAvailWeekendModal(interaction) {
    const days = ['saturday', 'sunday'];
    const { availability, avail } = getOrCreateAvail(interaction.user.id);

    const allErrors = [];
    for (const day of days) {
        try {
            const raw = interaction.fields.getTextInputValue(day);
            const { windows, errors } = parseTimeRanges(raw);
            if (errors.length > 0) {
                const label = day.charAt(0).toUpperCase() + day.slice(1);
                allErrors.push(`**${label}**:\n${errors.map(e => `  • ${e}`).join('\n')}`);
            } else {
                avail.weekly[day] = windows;
            }
        } catch (_) {
            avail.weekly[day] = [];
        }
    }

    data.saveAvailability(availability);

    let content = (allErrors.length === 0 ? '✅ Weekend availability saved!' : '⚠️ Some entries were saved, but the following were rejected:')
        + '\n\n' + formatWeeklySchedule(avail);
    if (allErrors.length > 0) {
        content += '\n\n**Rejected entries:**\n' + allErrors.join('\n');
        content += '\n\n**Accepted formats:** `7pm-10pm` · `7:30pm-10:30pm` · `19:00-22:00`';
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleAvailOverrideModal(interaction) {
    const dateStr  = interaction.fields.getTextInputValue('override_date').trim();
    const timesRaw = interaction.fields.getTextInputValue('override_times').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await interaction.reply({ content: '❌ Invalid date format. Use `YYYY-MM-DD`, e.g. `2025-07-04`.', flags: MessageFlags.Ephemeral });
        return;
    }

    const { availability, avail } = getOrCreateAvail(interaction.user.id);

    if (timesRaw.toLowerCase() === 'none') {
        avail.overrides[dateStr] = null;
    } else {
        const { windows, errors } = parseTimeRanges(timesRaw);
        if (errors.length > 0) {
            await interaction.reply({
                content: `❌ Override not saved — fix these errors and try again:\n${errors.map(e => `• ${e}`).join('\n')}`
                    + '\n\n**Accepted formats:** `7pm-10pm` · `7:30pm-10:30pm` · `19:00-22:00`\nCross-midnight ranges must be split at midnight.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        avail.overrides[dateStr] = windows.length > 0 ? windows : null;
    }

    data.saveAvailability(availability);

    const label = avail.overrides[dateStr] === null
        ? `You are marked as **unavailable** on \`${dateStr}\`.`
        : `Override set for \`${dateStr}\`: ${avail.overrides[dateStr].map(w => `${w.start}–${w.end}`).join(', ')}`;

    await interaction.reply({ content: '✅ ' + label, flags: MessageFlags.Ephemeral });
}

// ── Implementation: Scrim slot selection ──────────────────────────────────────

async function handleScrimSlotSelect(interaction) {
    await interaction.deferUpdate();

    const value    = interaction.values[0];
    const [cache_id, idx_str] = value.split(':');
    const idx      = parseInt(idx_str, 10);

    // Get the scrim command's pendingSlots cache
    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (_) {
        await interaction.followUp({ content: 'Session expired. Please run `/scrim` again.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cache_id);
    if (!cached) {
        await interaction.followUp({ content: 'This scrim request has expired. Please run `/scrim` again.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Verify the person selecting is the one who ran the command
    if (interaction.user.id !== cached.requested_by) {
        await interaction.followUp({ content: 'Only the captain who requested this scrim can select a time.', flags: MessageFlags.Ephemeral });
        return;
    }

    const slot     = cached.slots[idx];
    const team1    = data.getTeam(cached.team1_id);
    const team2    = data.getTeam(cached.team2_id);
    const config   = data.getConfig();

    if (!team1 || !team2) {
        await interaction.followUp({ content: 'One of the teams was not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (!config.scrim_channel_id) {
        await interaction.followUp({ content: 'No scrim channel configured. Admins must use `/set_channel` first.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Create a pending scrim record
    const scrim_id = randomUUID();
    const timezone = cached.timezone || 'America/New_York';
    const unix     = slot.start_unix;   // already UTC from the availability engine
    const unix_end = slot.end_unix;

    const scrims = data.getScrims();
    scrims[scrim_id] = {
        id:             scrim_id,
        team1_id:       cached.team1_id,
        team2_id:       cached.team2_id,
        status:         'pending',
        scheduled_time: new Date(unix * 1000).toISOString(),
        scheduled_end:  new Date(unix_end * 1000).toISOString(),
        discord_event_id: '',
        requested_by:   cached.requested_by,
        include_subs:   cached.include_subs,
        allow_fill:     cached.allow_fill,
        fill_interests: [],
        result:         null,
        result_embed_posted: false,
        result_message_id:   '',
        players_team1:  [],
        players_team2:  [],
        created_at:     new Date().toISOString(),
    };
    data.saveScrims(scrims);

    pendingSlots.delete(cache_id);

    // Post in scrim channel
    const scrimChannel = await interaction.guild.channels.fetch(config.scrim_channel_id).catch(() => null);
    if (!scrimChannel) {
        await interaction.followUp({ content: 'Scrim channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
        return;
    }

    const acceptRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`SCRIM_ACCEPT_${scrim_id}`)
            .setLabel('Accept')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`SCRIM_DECLINE_${scrim_id}`)
            .setLabel('Decline')
            .setStyle(ButtonStyle.Danger),
    );

    const fillRow = cached.allow_fill ? new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`FILL_INTEREST_${scrim_id}`)
            .setLabel("I'm available to fill")
            .setStyle(ButtonStyle.Secondary),
    ) : null;

    const captain2 = team2.captain_id ? `<@${team2.captain_id}>` : `_(no captain set for ${team2.name})_`;

    const embed = new EmbedBuilder()
        .setTitle(`Scrim Request — ${team1.name} vs ${team2.name}`)
        .setDescription(
            `**${team1.name}** has challenged **${team2.name}** to a scrim!\n\n` +
            `📅 **Date:** <t:${unix}:D>\n` +
            `⏰ **Time:** <t:${unix}:t> – <t:${unix_end}:t>\n` +
            `👥 **${team1.name} players:** ${slot.t1_count} · **${team2.name} players:** ${slot.t2_count}\n\n` +
            `${captain2}, please **Accept** or **Decline** this request.\n` +
            (cached.include_subs ? '✅ Substitutes included\n' : '') +
            (cached.allow_fill   ? '✅ Fill interest open — others can click below to show availability' : '')
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    const components = fillRow ? [acceptRow, fillRow] : [acceptRow];
    await scrimChannel.send({ content: team2.captain_id ? `<@${team2.captain_id}>` : '', embeds: [embed], components });

    await interaction.editReply({ content: `✅ Scrim request sent to **${team2.name}**! Check <#${config.scrim_channel_id}>.`, components: [] });
    logger.info(`[scrim] Scrim ${scrim_id} created: ${team1.name} vs ${team2.name} at <t:${unix}>`);
}

// ── Implementation: Scrim accept/decline ──────────────────────────────────────

async function handleScrimAccept(interaction, scrim_id) {
    const scrims = data.getScrims();
    const scrim  = scrims[scrim_id];
    if (!scrim || scrim.status !== 'pending') {
        await interaction.reply({ content: 'This scrim request is no longer pending.', flags: MessageFlags.Ephemeral });
        return;
    }

    const team2 = data.getTeam(scrim.team2_id);
    // Only captain of team2 can accept
    if (!team2 || (team2.captain_id && interaction.user.id !== team2.captain_id)) {
        if (!perms.check('ADMIN', interaction.member, interaction.user.id)) {
            await interaction.reply({ content: 'Only the opposing captain can accept this request.', flags: MessageFlags.Ephemeral });
            return;
        }
    }

    await interaction.deferUpdate();

    scrims[scrim_id].status = 'confirmed';
    data.saveScrims(scrims);

    const team1  = data.getTeam(scrim.team1_id);
    const config = data.getConfig();
    const unix   = Math.floor(new Date(scrim.scheduled_time).getTime() / 1000);
    const unix_e = Math.floor(new Date(scrim.scheduled_end  ).getTime() / 1000);

    // Create Discord scheduled event
    let eventId = '';
    try {
        const event = await interaction.guild.scheduledEvents.create({
            name:               `Scrim: ${team1?.name || '?'} vs ${team2?.name || '?'}`,
            scheduledStartTime: new Date(scrim.scheduled_time),
            scheduledEndTime:   new Date(scrim.scheduled_end),
            privacyLevel:       GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType:         GuildScheduledEventEntityType.External,
            entityMetadata:     { location: 'Custom Game Lobby' },
            description:        `Scrim between ${team1?.name || '?'} and ${team2?.name || '?'}`,
        });
        eventId = event.id;
        scrims[scrim_id].discord_event_id = eventId;
        data.saveScrims(scrims);
    } catch (err) {
        logger.warn('[scrim accept] Could not create Discord event: ' + err.message);
    }

    // Update the original message
    const confirmedEmbed = new EmbedBuilder()
        .setTitle(`✅ Scrim Confirmed — ${team1?.name || '?'} vs ${team2?.name || '?'}`)
        .setDescription(
            `📅 <t:${unix}:D> ⏰ <t:${unix}:t> – <t:${unix_e}:t>\n\n` +
            `Accepted by <@${interaction.user.id}>\n` +
            (eventId ? `A Discord event has been created for this scrim.\n` : '') +
            `When the scrim starts, a result tracker will be posted here and both captains pinged.`
        )
        .setColor(0x57F287)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    await interaction.editReply({ embeds: [confirmedEmbed], components: [] });

    // Notify requesting captain
    if (scrim.requested_by && team1?.captain_id !== scrim.requested_by) {
        try {
            const requester = await interaction.guild.members.fetch(scrim.requested_by);
            await requester.send({
                content: `Your scrim request against **${team2?.name}** has been **accepted**! <t:${unix}:D> at <t:${unix}:t>.`,
            });
        } catch (_) {}
    } else if (team1?.captain_id) {
        try {
            const cap = await interaction.guild.members.fetch(team1.captain_id);
            await cap.send({
                content: `Your scrim request against **${team2?.name}** has been **accepted**! <t:${unix}:D> at <t:${unix}:t>.`,
            });
        } catch (_) {}
    }

    logger.info(`[scrim] Scrim ${scrim_id} accepted by ${interaction.user.id}`);
}

async function handleScrimDecline(interaction, scrim_id) {
    const scrims = data.getScrims();
    const scrim  = scrims[scrim_id];
    if (!scrim || scrim.status !== 'pending') {
        await interaction.reply({ content: 'This scrim request is no longer pending.', flags: MessageFlags.Ephemeral });
        return;
    }

    const team2 = data.getTeam(scrim.team2_id);
    if (!team2 || (team2.captain_id && interaction.user.id !== team2.captain_id)) {
        if (!perms.check('ADMIN', interaction.member, interaction.user.id)) {
            await interaction.reply({ content: 'Only the opposing captain can decline this request.', flags: MessageFlags.Ephemeral });
            return;
        }
    }

    await interaction.deferUpdate();

    scrims[scrim_id].status = 'declined';
    data.saveScrims(scrims);

    const team1 = data.getTeam(scrim.team1_id);

    const declineEmbed = new EmbedBuilder()
        .setTitle(`❌ Scrim Declined — ${team1?.name || '?'} vs ${team2?.name || '?'}`)
        .setDescription(`Declined by <@${interaction.user.id}>.`)
        .setColor(0xED4245)
        .setFooter({ text: `Scrim ID: ${scrim_id}` });

    await interaction.editReply({ embeds: [declineEmbed], components: [] });

    // Notify requesting captain
    const notifyId = scrim.requested_by || team1?.captain_id;
    if (notifyId) {
        try {
            const cap = await interaction.guild.members.fetch(notifyId);
            await cap.send({ content: `Your scrim request against **${team2?.name}** was **declined**.` });
        } catch (_) {}
    }

    logger.info(`[scrim] Scrim ${scrim_id} declined by ${interaction.user.id}`);
}

// ── Implementation: Scrim record ─────────────────────────────────────────────

async function handleRecordScrimSelect(interaction) {
    const scrim_id = interaction.values[0];
    const scrim    = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const my_team = data.getTeamByCaptain(interaction.user.id);
    if (!my_team) {
        await interaction.reply({ content: 'You are not a captain of any team.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Get the members of the captain's team for the roster input hint
    const teamPlayers = data.getTeamPlayers(my_team.id)
        .filter(p => p.riot_id)
        .map(p => `<@${p.discord_id}> (${p.riot_id})`)
        .join(', ') || 'No linked players';

    const modal = makeModal(
        `RECORD_RESULT_MODAL_${scrim_id}`,
        'Record Scrim Result',
        [
            {
                id:          'outcome',
                label:       'Result for your team',
                placeholder: 'Win  or  Loss',
                style:       TextInputStyle.Short,
                required:    true,
            },
            {
                id:          'roster',
                label:       'Players who played (@mentions)',
                placeholder: '@Player1 @Player2 @Player3 @Player4 @Player5',
                style:       TextInputStyle.Paragraph,
                required:    true,
                value:       '',
            },
            {
                id:          'notes',
                label:       'Notes (optional)',
                placeholder: 'Any notes about this scrim...',
                style:       TextInputStyle.Paragraph,
                required:    false,
            },
        ]
    );

    await interaction.showModal(modal);
}

async function handleRecordResultModal(interaction, scrim_id) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const outcome   = interaction.fields.getTextInputValue('outcome').trim().toLowerCase();
    const rosterRaw = interaction.fields.getTextInputValue('roster').trim();
    const notes     = interaction.fields.getTextInputValue('notes')?.trim() || '';

    if (outcome !== 'win' && outcome !== 'loss') {
        await interaction.editReply({ content: 'Outcome must be "Win" or "Loss".' });
        return;
    }

    const scrim   = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.editReply({ content: 'Scrim not found.' });
        return;
    }

    if (scrim.result) {
        await interaction.editReply({ content: 'A result has already been recorded for this scrim. Use the Dispute button if it is incorrect.' });
        return;
    }

    const my_team = data.getTeamByCaptain(interaction.user.id);
    if (!my_team || (scrim.team1_id !== my_team.id && scrim.team2_id !== my_team.id)) {
        await interaction.editReply({ content: 'You are not a captain of either team in this scrim.' });
        return;
    }

    // Extract mentioned user IDs from roster input
    const rosterIds = [...rosterRaw.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);

    const isTeam1   = scrim.team1_id === my_team.id;
    const winnerKey = outcome === 'win' ? my_team.id : (isTeam1 ? scrim.team2_id : scrim.team1_id);
    const opp_team  = data.getTeam(isTeam1 ? scrim.team2_id : scrim.team1_id);

    const scrims    = data.getScrims();
    scrims[scrim_id].result = {
        winner:            winnerKey,
        submitted_by:      interaction.user.id,
        submitted_at:      new Date().toISOString(),
        roster_submitter:  my_team.id,
        players_team1:     isTeam1 ? rosterIds : (scrim.players_team1 || []),
        players_team2:     isTeam1 ? (scrim.players_team2 || []) : rosterIds,
        notes,
        disputed:          false,
        disputed_by:       null,
        disputed_at:       null,
    };

    if (isTeam1) scrims[scrim_id].players_team1 = rosterIds;
    else         scrims[scrim_id].players_team2 = rosterIds;

    scrims[scrim_id].status = 'completed';
    data.saveScrims(scrims);

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);
    const winnerTeam = data.getTeam(winnerKey);

    const embed = new EmbedBuilder()
        .setTitle('Scrim Result Recorded')
        .setColor(0x57F287)
        .addFields(
            { name: 'Matchup', value: `${team1?.name || '?'} vs ${team2?.name || '?'}`, inline: true },
            { name: 'Winner',  value: winnerTeam?.name || '?',                           inline: true },
        )
        .setFooter({ text: `Submitted by ${interaction.user.username} · The opposing captain can dispute within 48 hours.` })
        .setTimestamp();

    if (notes) embed.addFields({ name: 'Notes', value: notes });

    await interaction.editReply({ embeds: [embed] });

    // Notify opposing captain with a dispute option
    const opp_captain_id = opp_team?.captain_id;
    if (opp_captain_id) {
        const disputeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`SCRIM_DISPUTE_${scrim_id}`)
                .setLabel('Dispute This Result')
                .setStyle(ButtonStyle.Danger),
        );

        const notifEmbed = new EmbedBuilder()
            .setTitle('Scrim Result Submitted')
            .setDescription(
                `The result for your scrim against **${my_team.name}** has been submitted.\n\n` +
                `**Outcome:** ${my_team.name} — **${outcome.charAt(0).toUpperCase() + outcome.slice(1)}**\n\n` +
                `If this is incorrect, click **Dispute** within 48 hours to flag it for admin review.`
            )
            .setColor(0xFEE75C)
            .setFooter({ text: `Scrim ID: ${scrim_id}` });

        // Try to find the scrim channel or DM the captain
        const config = data.getConfig();
        const scrimChannel = config.scrim_channel_id
            ? await interaction.guild.channels.fetch(config.scrim_channel_id).catch(() => null)
            : null;

        if (scrimChannel) {
            await scrimChannel.send({ content: `<@${opp_captain_id}>`, embeds: [notifEmbed], components: [disputeRow] });
        } else {
            try {
                const cap = await interaction.guild.members.fetch(opp_captain_id);
                await cap.send({ embeds: [notifEmbed], components: [disputeRow] });
            } catch (_) {}
        }
    }

    logger.info(`[record] Scrim ${scrim_id} recorded: ${winnerKey} wins. By ${interaction.user.id}`);
}

async function handleScrimDispute(interaction, scrim_id) {
    const scrims = data.getScrims();
    const scrim  = scrims[scrim_id];
    if (!scrim || !scrim.result) {
        await interaction.reply({ content: 'No result found to dispute.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (scrim.result.disputed) {
        await interaction.reply({ content: 'This result has already been disputed.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Verify this is the opposing captain
    const opp_team = data.getTeam(
        scrim.result.roster_submitter === scrim.team1_id ? scrim.team2_id : scrim.team1_id
    );
    if (opp_team?.captain_id && interaction.user.id !== opp_team.captain_id) {
        if (!perms.check('ADMIN', interaction.member, interaction.user.id)) {
            await interaction.reply({ content: 'Only the opposing captain can dispute this result.', flags: MessageFlags.Ephemeral });
            return;
        }
    }

    await interaction.deferUpdate();

    scrims[scrim_id].result.disputed    = true;
    scrims[scrim_id].result.disputed_by = interaction.user.id;
    scrims[scrim_id].result.disputed_at = new Date().toISOString();
    scrims[scrim_id].status             = 'disputed';
    data.saveScrims(scrims);

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);

    const disputeEmbed = new EmbedBuilder()
        .setTitle('⚠️ Scrim Result Disputed')
        .setDescription(
            `The result for **${team1?.name || '?'} vs ${team2?.name || '?'}** has been disputed by <@${interaction.user.id}>.\n\n` +
            `An admin needs to review this scrim and correct the record.`
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    await interaction.editReply({ embeds: [disputeEmbed], components: [] });

    // Notify in log channel if configured
    const config = data.getConfig();
    if (config.log_channel_id) {
        try {
            const logCh = await interaction.guild.channels.fetch(config.log_channel_id);
            await logCh.send({ content: `@here`, embeds: [disputeEmbed] });
        } catch (_) {}
    }

    logger.info(`[record] Scrim ${scrim_id} disputed by ${interaction.user.id}`);
}

// ── Implementation: Fill interest ─────────────────────────────────────────────

async function handleFillInterest(interaction, scrim_id) {
    const scrims = data.getScrims();
    const scrim  = scrims[scrim_id];
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Fill interest only makes sense while the scrim is still live.
    if (scrim.status === 'declined' || scrim.status === 'completed' || scrim.status === 'disputed') {
        await interaction.reply({ content: 'This scrim is no longer accepting fill interest.', flags: MessageFlags.Ephemeral });
        return;
    }

    const uid = interaction.user.id;

    // The fill button is intended for members OUTSIDE either scrimming team.
    const player = data.getPlayer(uid);
    if (player && (player.team_id === scrim.team1_id || player.team_id === scrim.team2_id)) {
        await interaction.reply({ content: "You're already on one of the teams in this scrim.", flags: MessageFlags.Ephemeral });
        return;
    }

    if (!scrim.fill_interests) scrim.fill_interests = [];

    if (scrim.fill_interests.includes(uid)) {
        await interaction.reply({ content: "You've already marked interest in this scrim.", flags: MessageFlags.Ephemeral });
        return;
    }

    scrim.fill_interests.push(uid);
    data.saveScrims(scrims);

    await interaction.reply({
        content: `✅ You've been added to the fill interest list for this scrim. Captains have been notified.`,
        flags: MessageFlags.Ephemeral,
    });

    // Notify both captains
    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);
    const notif = `<@${uid}> has expressed interest in filling a spot in the scrim: **${team1?.name || '?'} vs ${team2?.name || '?'}**.`;

    for (const cap_id of [team1?.captain_id, team2?.captain_id].filter(Boolean)) {
        try {
            const cap = await interaction.guild.members.fetch(cap_id);
            await cap.send({ content: notif });
        } catch (_) {}
    }
}

// ── Implementation: Tryout interest ──────────────────────────────────────────

async function handleGameInterest(interaction, session_id) {
    const sessions = data.getSessions();
    const session  = sessions[session_id];

    if (!session || session.status === 'closed') {
        await interaction.reply({ content: 'This session is no longer accepting interest.', flags: MessageFlags.Ephemeral });
        return;
    }

    const uid = interaction.user.id;

    // Check open_to restriction
    const config = data.getConfig();
    const open_to = session.open_to || 'tryout';

    if (open_to === 'tryout') {
        if (!perms.check('TRYOUT', interaction.member, uid)) {
            await interaction.reply({ content: 'This session is only open to players with the tryout role.', flags: MessageFlags.Ephemeral });
            return;
        }
    } else if (open_to === 'member') {
        if (!perms.check('MEMBER', interaction.member, uid)) {
            await interaction.reply({ content: 'This session is only open to team members.', flags: MessageFlags.Ephemeral });
            return;
        }
    }
    // 'everyone' = no restriction

    if (session.interested.includes(uid)) {
        // Toggle off
        sessions[session_id].interested = session.interested.filter(id => id !== uid);
        data.saveSessions(sessions);
        await interaction.reply({ content: "You've been removed from the interest list.", flags: MessageFlags.Ephemeral });
        return;
    }

    sessions[session_id].interested.push(uid);
    data.saveSessions(sessions);

    await interaction.reply({
        content: `✅ You've been added to the interest list for **${session.name}**! An admin will reach out if you're selected.`,
        flags: MessageFlags.Ephemeral,
    });

    logger.info(`[tryout] ${uid} expressed interest in session ${session_id}`);
}

// ── Implementation: Scrim result scheduler & result embed ─────────────────────

/**
 * Returns the default starting roster (Main players) for a team as an array of
 * Discord IDs.
 */
function defaultRoster(team_id) {
    return data.getTeamPlayers(team_id)
        .filter(p => p.team_type === 'Main')
        .map(p => p.discord_id);
}

function rosterMentions(ids) {
    if (!ids || ids.length === 0) return '_TBD_';
    return ids.map(id => `<@${id}>`).join('\n');
}

/**
 * Builds the result-tracking embed + button rows for a scrim.
 * @param {Object} scrim
 * @param {Object} team1
 * @param {Object} team2
 * @param {boolean} recorded - whether a result has already been recorded
 */
function buildResultEmbed(scrim, team1, team2, recorded = false) {
    const unix = Math.floor(new Date(scrim.scheduled_time).getTime() / 1000);

    const embed = new EmbedBuilder()
        .setColor(recorded ? 0x57F287 : 0xFEE75C)
        .setTitle(`Scrim ${recorded ? 'Result' : 'In Progress'} — ${team1?.name || '?'} vs ${team2?.name || '?'}`)
        .addFields(
            { name: `${team1?.name || 'Team 1'}`, value: rosterMentions(scrim.players_team1), inline: true },
            { name: `${team2?.name || 'Team 2'}`, value: rosterMentions(scrim.players_team2), inline: true },
        )
        .setFooter({ text: `Scrim ID: ${scrim.id}` })
        .setTimestamp();

    if (recorded && scrim.result) {
        const winnerTeam = scrim.result.winner === scrim.team1_id ? team1 : team2;
        embed.setDescription(`🏆 **Winner: ${winnerTeam?.name || '?'}**\nRecorded by <@${scrim.result.submitted_by}>.`);
        const disputeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`SCRIM_DISPUTE_${scrim.id}`).setLabel('Dispute Result').setStyle(ButtonStyle.Danger),
        );
        return { embeds: [embed], components: [disputeRow] };
    }

    embed.setDescription(
        `Started <t:${unix}:R>. Captains: report the result when the game ends.\n` +
        `Use **Edit Players** if subs or fill-ins played.`
    );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`SCRIM_WIN_T1_${scrim.id}`).setLabel(`${team1?.name || 'Team 1'} Win`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`SCRIM_WIN_T2_${scrim.id}`).setLabel(`${team2?.name || 'Team 2'} Win`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`SCRIM_EDIT_${scrim.id}`).setLabel('Edit Players').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row] };
}

/**
 * Polls for confirmed scrims that have reached their start time and have not yet
 * had a result embed posted, then posts the embed and pings both captains.
 */
async function checkDueScrims(client) {
    const scrims = data.getScrims();
    const config = data.getConfig();
    if (!config.scrim_channel_id) return;

    const now = Date.now();
    let channel = null;

    for (const scrim of Object.values(scrims)) {
        if (scrim.status !== 'confirmed') continue;
        if (scrim.result_embed_posted) continue;
        if (!scrim.scheduled_time) continue;
        if (new Date(scrim.scheduled_time).getTime() > now) continue;

        const team1 = data.getTeam(scrim.team1_id);
        const team2 = data.getTeam(scrim.team2_id);

        // Populate default rosters (team mains) if not already set
        if (!scrim.players_team1 || scrim.players_team1.length === 0) scrim.players_team1 = defaultRoster(scrim.team1_id);
        if (!scrim.players_team2 || scrim.players_team2.length === 0) scrim.players_team2 = defaultRoster(scrim.team2_id);

        if (!channel) {
            channel = await client.channels.fetch(config.scrim_channel_id).catch(() => null);
            if (!channel) { logger.warn('[scrim scheduler] Scrim channel unavailable.'); return; }
        }

        const pings = [team1?.captain_id, team2?.captain_id].filter(Boolean).map(id => `<@${id}>`).join(' ');
        const payload = buildResultEmbed(scrim, team1, team2, false);

        try {
            const msg = await channel.send({
                content: `${pings} your scrim is starting — report the result below when you finish.`,
                ...payload,
            });
            scrim.result_embed_posted = true;
            scrim.result_message_id    = msg.id;
            data.saveScrims(scrims);
            logger.info(`[scrim scheduler] Posted result embed for scrim ${scrim.id}`);
        } catch (err) {
            logger.error(`[scrim scheduler] Failed to post result embed for ${scrim.id}: ${err.message}`);
        }
    }
}

/**
 * Records a winner when a captain/admin clicks a Win button. First click wins;
 * the opposing captain may dispute via the button on the updated embed.
 */
async function handleScrimWinButton(interaction, scrim_id, teamNum) {
    const scrims = data.getScrims();
    const scrim  = scrims[scrim_id];
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (scrim.result) {
        await interaction.reply({ content: 'A result has already been recorded for this scrim. Use Dispute if it is wrong.', flags: MessageFlags.Ephemeral });
        return;
    }

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);

    // Only a captain of either team or an admin may record
    const isCaptain = interaction.user.id === team1?.captain_id || interaction.user.id === team2?.captain_id;
    if (!isCaptain && !perms.check('ADMIN', interaction.member, interaction.user.id)) {
        await interaction.reply({ content: 'Only a team captain or an admin can record the result.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferUpdate();

    const winner_id      = teamNum === 1 ? scrim.team1_id : scrim.team2_id;
    const submitter_team = interaction.user.id === team1?.captain_id ? scrim.team1_id
                          : interaction.user.id === team2?.captain_id ? scrim.team2_id
                          : winner_id; // admin → attribute to winning team

    scrim.result = {
        winner:           winner_id,
        submitted_by:     interaction.user.id,
        submitted_at:     new Date().toISOString(),
        roster_submitter: submitter_team,
        players_team1:    scrim.players_team1 || [],
        players_team2:    scrim.players_team2 || [],
        notes:            '',
        disputed:         false,
        disputed_by:      null,
        disputed_at:      null,
    };
    scrim.status = 'completed';
    data.saveScrims(scrims);

    const payload = buildResultEmbed(scrim, team1, team2, true);
    await interaction.editReply(payload);

    // Notify the opposing captain
    const winnerTeam = winner_id === scrim.team1_id ? team1 : team2;
    const oppCaptain = interaction.user.id === team1?.captain_id ? team2?.captain_id : team1?.captain_id;
    if (oppCaptain) {
        try {
            const cap = await interaction.guild.members.fetch(oppCaptain);
            await cap.send({ content: `A result was recorded for your scrim **${team1?.name} vs ${team2?.name}**: **${winnerTeam?.name} Win**. If this is wrong, use the Dispute button in <#${data.getConfig().scrim_channel_id}>.` });
        } catch (_) {}
    }

    logger.info(`[scrim] Result via button: scrim ${scrim_id}, winner ${winner_id}, by ${interaction.user.id}`);
}

/**
 * Opens a modal letting a captain edit which players from THEIR team played.
 */
async function handleScrimEditButton(interaction, scrim_id) {
    const scrim = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);

    let which = null;
    if (interaction.user.id === team1?.captain_id) which = 1;
    else if (interaction.user.id === team2?.captain_id) which = 2;
    else if (perms.check('ADMIN', interaction.member, interaction.user.id)) which = 1; // admin defaults to team 1
    else {
        await interaction.reply({ content: 'Only a team captain (or admin) can edit the players.', flags: MessageFlags.Ephemeral });
        return;
    }

    const current = (which === 1 ? scrim.players_team1 : scrim.players_team2) || [];
    const teamName = which === 1 ? team1?.name : team2?.name;

    const modal = makeModal(`SCRIM_EDIT_MODAL_${scrim_id}:${which}`, `Edit Players — ${(teamName || 'Team').substring(0, 30)}`, [
        {
            id:          'players',
            label:       'Players who played (@mentions)',
            placeholder: '@Player1 @Player2 @Player3 @Player4 @Player5',
            style:       TextInputStyle.Paragraph,
            required:    true,
            value:       current.map(id => `<@${id}>`).join(' '),
        },
    ]);

    await interaction.showModal(modal);
}

/**
 * Applies the edited roster from the edit-players modal and refreshes the embed.
 */
async function handleScrimEditModal(interaction, rawId) {
    const [scrim_id, whichStr] = rawId.split(':');
    const which = parseInt(whichStr, 10) === 2 ? 2 : 1;

    await interaction.deferUpdate().catch(() => {});

    const scrims = data.getScrims();
    const scrim  = scrims[scrim_id];
    if (!scrim) {
        await interaction.followUp({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const raw = interaction.fields.getTextInputValue('players');
    const ids = [...raw.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);

    if (which === 1) scrim.players_team1 = ids;
    else             scrim.players_team2 = ids;
    data.saveScrims(scrims);

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);

    // Refresh the embed (whether or not a result is already recorded)
    const payload = buildResultEmbed(scrim, team1, team2, !!scrim.result);
    try {
        await interaction.editReply(payload);
    } catch (_) {
        await interaction.followUp({ content: 'Players updated.', flags: MessageFlags.Ephemeral });
    }

    logger.info(`[scrim] Players edited for scrim ${scrim_id} (team ${which}) by ${interaction.user.id}`);
}

module.exports = register_handlers;

// Exposed for the validation/test harness only (no effect on runtime behavior).
module.exports.__test = {
    setContext: (d, p, l) => { data = d; perms = p; logger = l; },
    checkDueScrims,
    buildResultEmbed,
    defaultRoster,
};
