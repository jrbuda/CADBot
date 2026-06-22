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
    RECORD_WIN:           'RECORD_WIN',           // prefix: RECORD_WIN_<scrim_id>
    RECORD_LOSS:          'RECORD_LOSS',          // prefix: RECORD_LOSS_<scrim_id>
    RECORD_EDIT:          'RECORD_EDIT',          // prefix: RECORD_EDIT_<scrim_id>
    RECORD_NOTE:          'RECORD_NOTE',          // prefix: RECORD_NOTE_<scrim_id>
    RECORD_EDIT_MODAL:    'RECORD_EDIT_MODAL',    // prefix: RECORD_EDIT_MODAL_<scrim_id>
    RECORD_NOTE_MODAL:    'RECORD_NOTE_MODAL',    // prefix: RECORD_NOTE_MODAL_<scrim_id>
    GAME_INTEREST:      'GAME_INTEREST',   // prefix: GAME_INTEREST_<session_id>
    GAME_SETTINGS:      'GAME_SETTINGS',   // prefix: GAME_SETTINGS_<session_id>
    GAME_OPEN:          'GAME_OPEN',       // prefix: GAME_OPEN_<session_id>
    GAME_SPOT_UP:       'GAME_SPOT_UP',    // prefix: GAME_SPOT_UP_<session_id>
    GAME_SPOT_DOWN:     'GAME_SPOT_DOWN',  // prefix: GAME_SPOT_DOWN_<session_id>
    GAME_CLOSE_BTN:     'GAME_CLOSE_BTN',  // prefix: GAME_CLOSE_BTN_<session_id>
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
            } catch (e) { logger.warn('[league/events] Error recovery failed: ' + e.message); }
        }
    });

    // ── Auto-unlink on member leave ──────────────────────────────────────────
    event_registry.register('guildMemberRemove', async (member) => {
        const players = data.getPlayers();
        if (players[member.id]) {
            const riotId = players[member.id].riot_id || 'unknown';
            delete players[member.id];
            data.savePlayers(players);
            logger.info(`[auto-unlink] ${member.id} (${riotId}) left server — account unlinked`);
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

    // ─ /link admin button (with target user) → show modal ────────────────────
    if (id.startsWith(CID.LINK_BUTTON + '_')) {
        const targetId = id.replace(CID.LINK_BUTTON + '_', '');
        const modal = makeModal(`${CID.LINK_MODAL}_${targetId}`, 'Link Riot Account', [
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
                    placeholder: 'e.g. 6pm-9pm, 10pm-11pm  |  split 8pm-12am, 12am-2am if past midnight',
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
                    placeholder: 'e.g. 1pm-8pm, 9pm-11pm  |  split 8pm-12am, 12am-2am if past midnight',
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
                placeholder: 'e.g. 2025-07-04  — the specific date you want to override',
                style:       TextInputStyle.Short,
                required:    true,
            },
            {
                id:          'override_times',
                label:       "Times (or type 'none' if unavailable)",
                placeholder: 'e.g. 2pm-6pm, 8pm-11pm  |  split 8pm-12am, 12am-2am if past midnight  |  or: none',
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

    // ─ Scrim: Fallback manual time (zero-slot fallback) ──────────────────────
    if (id.startsWith('SCRIM_FALLBACK_MANUAL_')) {
        const cacheId = id.replace('SCRIM_FALLBACK_MANUAL_', '');
        const modal = makeModal(`SCRIM_MANUAL_MODAL_${cacheId}`, 'Enter Scrim Time', [
            {
                id:          'manual_date',
                label:       'Date (YYYY-MM-DD)',
                placeholder: 'e.g. 2026-06-25  — pick a date',
                style:       TextInputStyle.Short,
                required:    true,
            },
            {
                id:          'manual_time',
                label:       'Start time',
                placeholder: 'e.g. 7pm, 7:30pm, or 19:00',
                style:       TextInputStyle.Short,
                required:    true,
            },
        ]);
        await interaction.showModal(modal);
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

    // ─ Record: Win ─────────────────────────────────────────────────────────────
    if (id.startsWith(CID.RECORD_WIN + '_')) {
        await handleRecordWin(interaction, id.replace(CID.RECORD_WIN + '_', ''));
        return;
    }

    // ─ Record: Loss ────────────────────────────────────────────────────────────
    if (id.startsWith(CID.RECORD_LOSS + '_')) {
        await handleRecordLoss(interaction, id.replace(CID.RECORD_LOSS + '_', ''));
        return;
    }

    // ─ Record: Edit players ────────────────────────────────────────────────────
    if (id.startsWith(CID.RECORD_EDIT + '_')) {
        await handleRecordEdit(interaction, id.replace(CID.RECORD_EDIT + '_', ''));
        return;
    }

    // ─ Record: Add note ────────────────────────────────────────────────────────
    if (id.startsWith(CID.RECORD_NOTE + '_')) {
        await handleRecordNote(interaction, id.replace(CID.RECORD_NOTE + '_', ''));
        return;
    }

    // ─ Tryout: Express interest ──────────────────────────────────────────────
    if (id.startsWith('GAME_INTEREST_')) {
        await handleGameInterest(interaction, id.replace('GAME_INTEREST_', ''));
        return;
    }

    // ─ Game: Settings (captain-only) ──────────────────────────────────────────
    if (id.startsWith(CID.GAME_SETTINGS)) {
        await handleGameSettings(interaction, id.replace(CID.GAME_SETTINGS + '_', ''));
        return;
    }

    // ─ Game: Toggle open_to ───────────────────────────────────────────────────
    if (id.startsWith(CID.GAME_OPEN)) {
        await handleGameOpenToggle(interaction, id.replace(CID.GAME_OPEN + '_', ''));
        return;
    }

    // ─ Game: Spot up ──────────────────────────────────────────────────────────
    if (id.startsWith(CID.GAME_SPOT_UP)) {
        await handleGameSpotUp(interaction, id.replace(CID.GAME_SPOT_UP + '_', ''));
        return;
    }

    // ─ Game: Spot down ────────────────────────────────────────────────────────
    if (id.startsWith(CID.GAME_SPOT_DOWN)) {
        await handleGameSpotDown(interaction, id.replace(CID.GAME_SPOT_DOWN + '_', ''));
        return;
    }

    // ─ Game: Close session button ─────────────────────────────────────────────
    if (id.startsWith(CID.GAME_CLOSE_BTN)) {
        await handleGameCloseBtn(interaction, id.replace(CID.GAME_CLOSE_BTN + '_', ''));
        return;
    }

    // ─ Fill interest ─────────────────────────────────────────────────────────
    if (id.startsWith('FILL_INTEREST_')) {
        await handleFillInterest(interaction, id.replace('FILL_INTEREST_', ''));
        return;
    }

    // ─ External scrim: slot interest ──────────────────────────────────────────
    if (id.startsWith('SCRIM_SLOT_INTEREST_')) {
        await handleScrimSlotInterest(interaction, id.replace('SCRIM_SLOT_INTEREST_', ''));
        return;
    }

    // ─ External scrim: add time slot ──────────────────────────────────────────
    if (id.startsWith('SCRIM_ADD_SLOT_')) {
        await handleScrimAddSlot(interaction, id.replace('SCRIM_ADD_SLOT_', ''));
        return;
    }

    // ─ External scrim: confirm ────────────────────────────────────────────────
    if (id.startsWith('SCRIM_CONFIRM_')) {
        await handleScrimConfirm(interaction, id.replace('SCRIM_CONFIRM_', ''));
        return;
    }

    // ─ External scrim: cancel ─────────────────────────────────────────────────
    if (id.startsWith('SCRIM_CANCEL_PRO_')) {
        await handleScrimCancelProposal(interaction, id.replace('SCRIM_CANCEL_PRO_', ''));
        return;
    }
}

// ── Modal submit handlers ─────────────────────────────────────────────────────

async function handleModal(interaction) {
    const id = interaction.customId;

    // ─ Link modal submitted ──────────────────────────────────────────────────
    if (id === CID.LINK_MODAL) {
        await handleLinkModal(interaction, null);
        return;
    }

    // ─ Link modal with target user (admin override) ───────────────────────────
    if (id.startsWith(CID.LINK_MODAL + '_')) {
        const targetId = id.replace(CID.LINK_MODAL + '_', '');
        await handleLinkModal(interaction, targetId);
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

    // ─ Record edit-players modal ──────────────────────────────────────────────
    if (id.startsWith(CID.RECORD_EDIT_MODAL + '_')) {
        await handleRecordEditModal(interaction, id.replace(CID.RECORD_EDIT_MODAL + '_', ''));
        return;
    }

    // ─ Record note modal ──────────────────────────────────────────────────────
    if (id.startsWith(CID.RECORD_NOTE_MODAL + '_')) {
        await handleRecordNoteModal(interaction, id.replace(CID.RECORD_NOTE_MODAL + '_', ''));
        return;
    }

    // ─ Scrim edit-players modal ──────────────────────────────────────────────
    if (id.startsWith('SCRIM_EDIT_MODAL_')) {
        await handleScrimEditModal(interaction, id.replace('SCRIM_EDIT_MODAL_', ''));
        return;
    }

    // ─ Scrim manual time modal ────────────────────────────────────────────────
    if (id.startsWith('SCRIM_MANUAL_MODAL_')) {
        await handleScrimManualModal(interaction, id.replace('SCRIM_MANUAL_MODAL_', ''));
        return;
    }

    // ─ Scrim add slot modal ───────────────────────────────────────────────────
    if (id.startsWith('SCRIM_ADD_SLOT_MODAL_')) {
        await handleScrimAddSlotModal(interaction, id.replace('SCRIM_ADD_SLOT_MODAL_', ''));
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

async function handleLinkModal(interaction, targetUserId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const riotIdRaw = interaction.fields.getTextInputValue('riot_id_input').trim();
    const userId = targetUserId || interaction.user.id;

    if (!riotIdRaw.includes('#')) {
        await interaction.editReply({ content: 'Invalid Riot ID. Must include a tag, e.g. `PlayerName#NA1`.' });
        return;
    }

    try {
        const { account, summoner } = await lookupRiotId(riotIdRaw, logger);

        const players = data.getPlayers();
        players[userId] = {
            discord_id:  userId,
            riot_id:     `${account.gameName}#${account.tagLine}`,
            puuid:       account.puuid,
            summoner_level: summoner.summonerLevel,
            team_id:     players[userId]?.team_id   || '',
            team_role:   players[userId]?.team_role || '',
            team_type:   players[userId]?.team_type || '',
            is_tryout:   players[userId]?.is_tryout ?? false,
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
        logger.info(`[link] ${userId} linked account ${account.gameName}#${account.tagLine}`);
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
        } catch (e) {
            logger.warn('[availability] Could not read field for day ' + day + ': ' + e.message);
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
        } catch (e) {
            logger.warn('[availability] Could not read field for day ' + day + ': ' + e.message);
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

    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots: ' + e.message);
        await interaction.followUp({ content: 'Session expired. Please run `/scrim` again.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cache_id);
    if (!cached) {
        await interaction.followUp({ content: 'This scrim request has expired. Please run `/scrim` again.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.user.id !== cached.requested_by) {
        await interaction.followUp({ content: 'Only the captain who requested this scrim can select a time.', flags: MessageFlags.Ephemeral });
        return;
    }

    // "Enter manually..." selected
    if (idx_str === 'manual') {
        const modal = makeModal(`SCRIM_MANUAL_MODAL_${cache_id}`, 'Enter Scrim Time', [
            {
                id:          'manual_date',
                label:       'Date (YYYY-MM-DD)',
                placeholder: 'e.g. 2026-06-25  — pick a date',
                style:       TextInputStyle.Short,
                required:    true,
            },
            {
                id:          'manual_time',
                label:       'Start time',
                placeholder: 'e.g. 7pm, 7:30pm, or 19:00',
                style:       TextInputStyle.Short,
                required:    true,
            },
        ]);
        await interaction.showModal(modal);
        return;
    }

    const idx  = parseInt(idx_str, 10);
    const slot = cached.slots[idx];

    // External mode: propose to own team
    if (cached.mode === 'external' || cached.mode === 'external_proposal') {
        const team1 = data.getTeam(cached.team1_id);
        if (!team1) {
            await interaction.followUp({ content: 'Team not found.', flags: MessageFlags.Ephemeral });
            return;
        }

        const slots = [slot];
        pendingSlots.delete(cache_id);

        // Create a new cache for the external proposal
        const proposalCacheId = randomUUID().replace(/-/g, '').substring(0, 12);
        pendingSlots.set(proposalCacheId, {
            ...cached,
            slots,
            mode: 'external_proposal',
        });
        setTimeout(() => pendingSlots.delete(proposalCacheId), 24 * 60 * 60 * 1000);

        await postExternalScrimEmbed(interaction, data, team1, slots, proposalCacheId,
            cached.include_subs, cached.allow_fill, cached.requested_by);
        await interaction.editReply({ content: '\u2705 Scrim proposal posted below. Your team can now vote.', components: [] });
        return;
    }

    // Internal mode: existing behavior
    const team1 = data.getTeam(cached.team1_id);
    const team2 = data.getTeam(cached.team2_id);
    const config = data.getConfig();

    if (!team1 || !team2) {
        await interaction.followUp({ content: 'One of the teams was not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (!config.scrim_channel_id) {
        await interaction.followUp({ content: 'No scrim channel configured. Admins must use `/set_channel` first.', flags: MessageFlags.Ephemeral });
        return;
    }

    const scrim_id = randomUUID();
    const unix     = slot.start_unix;

    const scrims = data.getScrims();
    scrims[scrim_id] = {
        id:             scrim_id,
        team1_id:       cached.team1_id,
        team2_id:       cached.team2_id,
        status:         'pending',
        scheduled_time: new Date(unix * 1000).toISOString(),
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

    const scrimChannel = await interaction.guild.channels.fetch(config.scrim_channel_id).catch(() => null);
    if (!scrimChannel) {
        await interaction.followUp({ content: 'Scrim channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
        return;
    }

    const acceptRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`SCRIM_ACCEPT_${scrim_id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`SCRIM_DECLINE_${scrim_id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );

    const fillRow = cached.allow_fill ? new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`FILL_INTEREST_${scrim_id}`).setLabel("I'm available to fill").setStyle(ButtonStyle.Secondary),
    ) : null;

    const captain2 = team2.captain_id ? `<@${team2.captain_id}>` : `_(no captain set for ${team2.name})_`;

    const embed = new EmbedBuilder()
        .setTitle(`Scrim Request \u2014 ${team1.name} vs ${team2.name}`)
        .setDescription(
            `**${team1.name}** has challenged **${team2.name}** to a scrim!\n\n` +
            `\uD83D\uDCC5 **Date:** <t:${unix}:D>\n` +
            `\u23F0 **Time:** <t:${unix}:t>\n` +
            `\uD83D\uDC65 **${team1.name} players:** ${slot.t1_count} \u00b7 **${team2.name} players:** ${slot.t2_count}\n\n` +
            `${captain2}, please **Accept** or **Decline** this request.\n` +
            (cached.include_subs ? '\u2705 Substitutes included\n' : '') +
            (cached.allow_fill   ? '\u2705 Fill interest open' : '')
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    const components = fillRow ? [acceptRow, fillRow] : [acceptRow];
    await scrimChannel.send({ content: team2.captain_id ? `<@${team2.captain_id}>` : '', embeds: [embed], components });

    await interaction.editReply({ content: `\u2705 Scrim request sent to **${team2.name}**! Check <#${config.scrim_channel_id}>.`, components: [] });
    logger.info(`[scrim] Scrim ${scrim_id} created: ${team1.name} vs ${team2.name} at <t:${unix}>`);
}

// ── External scrim embed helper ────────────────────────────────────────────────

async function postExternalScrimEmbed(interaction, data, team, slots, cache_id, include_subs, allow_fill, captainId) {
    let slotDesc = '';
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const timeRange = s.end_unix ? ` \u2013 <t:${s.end_unix}:t>` : '';
        slotDesc += `\u23F0 **Slot ${i + 1}:** <t:${s.start_unix}:D> <t:${s.start_unix}:t>${timeRange}\n\n`;
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
        .setTitle(`\uD83D\uDCCB External Scrim \u2014 ${team.name}`)
        .setDescription(
            `**${team.name}** is planning a scrim against an external team.\n\n` +
            `Pick the slots you can make:\n${slotDesc}\n` +
            (include_subs ? '\u2705 Substitutes included\n' : '') +
            (allow_fill   ? '\u2705 Fill interest open' : '')
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Cache: ${cache_id}` });

    await interaction.followUp({ embeds: [embed], components: [...rows, captainRow] });
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

    // Create Discord scheduled event (end time = start + 3h, Discord requirement)
    let eventId = '';
    try {
        const startDate = new Date(scrim.scheduled_time);
        const endDate   = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
        const event = await interaction.guild.scheduledEvents.create({
            name:               `Scrim: ${team1?.name || '?'} vs ${team2?.name || '?'}`,
            scheduledStartTime: startDate,
            scheduledEndTime:   endDate,
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
            `📅 <t:${unix}:D> ⏰ <t:${unix}:t>\n\n` +
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
        } catch (e) {
            logger.warn('[scrim] Could not send accept DM to requesting captain ' + scrim.requested_by + ': ' + e.message);
        }
    } else if (team1?.captain_id) {
        try {
            const cap = await interaction.guild.members.fetch(team1.captain_id);
            await cap.send({
                content: `Your scrim request against **${team2?.name}** has been **accepted**! <t:${unix}:D> at <t:${unix}:t>.`,
            });
        } catch (e) {
            logger.warn('[scrim] Could not send accept DM to team1 captain ' + team1.captain_id + ': ' + e.message);
        }
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
        } catch (e) {
            logger.warn('[scrim] Could not send decline DM to captain ' + notifyId + ': ' + e.message);
        }
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

    if (scrim.team1_id !== my_team.id && scrim.team2_id !== my_team.id) {
        await interaction.reply({ content: 'You are not a captain of either team in this scrim.', flags: MessageFlags.Ephemeral });
        return;
    }

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);

    const t1Roster = scrim.players_team1?.length > 0
        ? scrim.players_team1.map(id => `<@${id}>`).join('\n')
        : '_TBD_';
    const t2Roster = scrim.players_team2?.length > 0
        ? scrim.players_team2.map(id => `<@${id}>`).join('\n')
        : '_TBD_';

    const embed = new EmbedBuilder()
        .setTitle(`Record Result \u2014 ${team1?.name || '?'} vs ${team2?.name || '?'}`)
        .addFields(
            { name: team1?.name || 'Team 1', value: t1Roster, inline: true },
            { name: team2?.name || 'Team 2', value: t2Roster, inline: true },
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CID.RECORD_WIN}_${scrim_id}`)
            .setLabel('We Won')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${CID.RECORD_LOSS}_${scrim_id}`)
            .setLabel('We Lost')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${CID.RECORD_EDIT}_${scrim_id}`)
            .setLabel('Edit Players')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CID.RECORD_NOTE}_${scrim_id}`)
            .setLabel('Add Note')
            .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

async function handleRecordWin(interaction, scrim_id) {
    await recordScrimResult(interaction, scrim_id, 'win');
}

async function handleRecordLoss(interaction, scrim_id) {
    await recordScrimResult(interaction, scrim_id, 'loss');
}

async function recordScrimResult(interaction, scrim_id, outcome) {
    const scrim = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (scrim.result) {
        await interaction.reply({ content: 'A result has already been recorded for this scrim.', flags: MessageFlags.Ephemeral });
        return;
    }

    const my_team = data.getTeamByCaptain(interaction.user.id);
    if (!my_team || (scrim.team1_id !== my_team.id && scrim.team2_id !== my_team.id)) {
        await interaction.reply({ content: 'You are not a captain of either team in this scrim.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferUpdate();

    const isTeam1   = scrim.team1_id === my_team.id;
    const winnerKey = outcome === 'win' ? my_team.id : (isTeam1 ? scrim.team2_id : scrim.team1_id);
    const opp_team  = data.getTeam(isTeam1 ? scrim.team2_id : scrim.team1_id);

    const scrims = data.getScrims();
    scrims[scrim_id].result = {
        winner:            winnerKey,
        submitted_by:      interaction.user.id,
        submitted_at:      new Date().toISOString(),
        roster_submitter:  my_team.id,
        players_team1:     scrim.players_team1 || [],
        players_team2:     scrim.players_team2 || [],
        notes:             scrim._pending_note || '',
        disputed:          false,
        disputed_by:       null,
        disputed_at:       null,
    };
    scrims[scrim_id].status = 'completed';
    delete scrims[scrim_id]._pending_note;
    data.saveScrims(scrims);

    const team1 = data.getTeam(scrim.team1_id);
    const team2 = data.getTeam(scrim.team2_id);
    const winnerTeam = data.getTeam(winnerKey);

    const embed = new EmbedBuilder()
        .setTitle('\u2705 Result Recorded')
        .setColor(0x57F287)
        .addFields(
            { name: 'Matchup', value: `${team1?.name || '?'} vs ${team2?.name || '?'}`, inline: true },
            { name: 'Winner',  value: winnerTeam?.name || '?',                           inline: true },
        )
        .setFooter({ text: `Submitted by ${interaction.user.username} \u00b7 Opposing captain can dispute within 48h.` })
        .setTimestamp();

    if (scrim.result.notes) embed.addFields({ name: 'Notes', value: scrim.result.notes });

    const disputeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`SCRIM_DISPUTE_${scrim_id}`)
            .setLabel('Dispute This Result')
            .setStyle(ButtonStyle.Danger),
    );

    await interaction.editReply({ embeds: [embed], components: [disputeRow] });

    // Notify opposing captain
    const opp_captain_id = opp_team?.captain_id;
    if (opp_captain_id) {
        const notifEmbed = new EmbedBuilder()
            .setTitle('Scrim Result Submitted')
            .setDescription(
                `The result for your scrim against **${my_team.name}** has been submitted.\n\n` +
                `**Outcome:** ${my_team.name} \u2014 **${outcome.charAt(0).toUpperCase() + outcome.slice(1)}**\n\n` +
                `If this is incorrect, click **Dispute** within 48 hours.`
            )
            .setColor(0xFEE75C)
            .setFooter({ text: `Scrim ID: ${scrim_id}` });

        const config = data.getConfig();
        const scrimChannel = config.scrim_channel_id
            ? await interaction.guild.channels.fetch(config.scrim_channel_id).catch(() => null)
            : null;

        if (scrimChannel) {
            await scrimChannel.send({ content: `<@${opp_captain_id}>`, embeds: [notifEmbed], components: [disputeRow] });
        }
    }

    logger.info(`[record] Scrim ${scrim_id} recorded: ${winnerKey} ${outcome}. By ${interaction.user.id}`);
}

async function handleRecordEdit(interaction, scrim_id) {
    const scrim = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const my_team = data.getTeamByCaptain(interaction.user.id);
    if (!my_team || (scrim.team1_id !== my_team.id && scrim.team2_id !== my_team.id)) {
        await interaction.reply({ content: 'You are not a captain for this scrim.', flags: MessageFlags.Ephemeral });
        return;
    }

    const isTeam1 = scrim.team1_id === my_team.id;
    const current = (isTeam1 ? scrim.players_team1 : scrim.players_team2) || [];

    const modal = makeModal(`${CID.RECORD_EDIT_MODAL}_${scrim_id}`, 'Edit Players', [
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

async function handleRecordEditModal(interaction, scrim_id) {
    const scrim = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const my_team = data.getTeamByCaptain(interaction.user.id);
    if (!my_team) {
        await interaction.reply({ content: 'Not a captain.', flags: MessageFlags.Ephemeral });
        return;
    }

    const raw = interaction.fields.getTextInputValue('players');
    const ids = [...raw.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);

    const isTeam1 = scrim.team1_id === my_team.id;
    const scrims = data.getScrims();
    if (isTeam1) scrims[scrim_id].players_team1 = ids;
    else         scrims[scrim_id].players_team2 = ids;
    data.saveScrims(scrims);

    await interaction.reply({ content: '\u2705 Players updated. Run `/record` again to submit the result.', flags: MessageFlags.Ephemeral });
    logger.info(`[record] Players edited for scrim ${scrim_id} by ${interaction.user.id}`);
}

async function handleRecordNote(interaction, scrim_id) {
    const scrim = data.getScrim(scrim_id);
    if (!scrim) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const scrims = data.getScrims();
    const currentNote = scrims[scrim_id]._pending_note || '';

    const modal = makeModal(`${CID.RECORD_NOTE_MODAL}_${scrim_id}`, 'Add Note', [
        {
            id:          'note',
            label:       'Notes about this scrim (optional)',
            placeholder: 'Any notes...',
            style:       TextInputStyle.Paragraph,
            required:    false,
            value:       currentNote,
        },
    ]);

    await interaction.showModal(modal);
}

async function handleRecordNoteModal(interaction, scrim_id) {
    const note = interaction.fields.getTextInputValue('note')?.trim() || '';

    const scrims = data.getScrims();
    if (!scrims[scrim_id]) {
        await interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    scrims[scrim_id]._pending_note = note;
    data.saveScrims(scrims);

    await interaction.reply({
        content: note ? `\u2705 Note added: "${note}"\nRun \`/record\` again to submit the result.` : '\u2705 Note cleared.',
        flags: MessageFlags.Ephemeral,
    });
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
        } catch (e) { logger.warn('[record] Could not send dispute notification to log channel: ' + e.message); }
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
        } catch (e) { logger.warn('[scrim] Could not send fill interest DM to captain ' + cap_id + ': ' + e.message); }
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
    const open_to = session.open_to || 'member_tryout';

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
    } else if (open_to === 'member_tryout') {
        if (!perms.check('MEMBER', interaction.member, uid) && !perms.check('TRYOUT', interaction.member, uid)) {
            await interaction.reply({ content: 'This session is only open to team members and tryouts.', flags: MessageFlags.Ephemeral });
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
        } catch (e) { logger.warn('[scrim] Could not send result DM to opposing captain ' + oppCaptain + ': ' + e.message); }
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
    } catch (e) {
        logger.warn('[scrim] Failed to refresh result embed for scrim ' + scrim_id + ': ' + e.message);
        await interaction.followUp({ content: 'Players updated.', flags: MessageFlags.Ephemeral });
    }

    logger.info(`[scrim] Players edited for scrim ${scrim_id} (team ${which}) by ${interaction.user.id}`);
}

// ── Implementation: Game settings buttons ─────────────────────────────────────

const OPEN_TO_LABELS = {
    member: 'Team members',
    tryout: 'Tryouts',
    member_tryout: 'Members + Tryouts',
    everyone: 'Anyone',
};
const OPEN_TO_CYCLE = ['member_tryout', 'member', 'tryout', 'everyone'];

function buildGameEmbed(session, team) {
    const typeLabel = { tryout: 'Tryout', custom_game: 'Custom Game', practice: 'Practice' }[session.type] || session.type;
    const openLabel = OPEN_TO_LABELS[session.open_to] || 'Anyone';

    return new EmbedBuilder()
        .setTitle(`${typeLabel} \u2014 ${session.name}`)
        .setDescription(
            `\uD83D\uDCC5 <t:${session.start_unix}:F>\n` +
            `\uD83D\uDD50 <t:${session.start_unix}:R>\n` +
            `\uD83C\uDFAE **Type:** ${typeLabel}\n` +
            `\uD83D\uDC65 **Spots:** ${session.spots}\n` +
            (team ? `\uD83D\uDEE1\uFE0F **Team:** ${team.name}\n` : '') +
            `\uD83D\uDC4B **Open to:** ${openLabel}\n\n` +
            `Click below if you're in!`
        )
        .setColor(session.status === 'closed' ? 0x95A5A6 : 0xED4245)
        .setFooter({ text: `Session ID: ${session.id}` })
        .setTimestamp();
}

async function handleGameSettings(interaction, session_id) {
    const sessions = data.getSessions();
    const session  = sessions[session_id];
    if (!session || session.status === 'closed') {
        await interaction.reply({ content: 'Session not available.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Only the captain of the team, the creator, or an admin can use settings
    const isAdmin = perms.check('ADMIN', interaction.member, interaction.user.id);
    const myTeam = data.getTeamByCaptain(interaction.user.id);
    const canManage = isAdmin || session.created_by === interaction.user.id
        || (myTeam && session.team_id === myTeam.id);
    if (!canManage) {
        await interaction.reply({ content: 'Only the session creator, team captain, or admin can change settings.', flags: MessageFlags.Ephemeral });
        return;
    }

    const openLabel = OPEN_TO_LABELS[session.open_to] || 'Anyone';
    const settingsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CID.GAME_OPEN}_${session_id}`)
            .setLabel(`Open: ${openLabel}`)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${CID.GAME_SPOT_UP}_${session_id}`)
            .setLabel('+1 Spot')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CID.GAME_SPOT_DOWN}_${session_id}`)
            .setLabel('-1 Spot')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CID.GAME_CLOSE_BTN}_${session_id}`)
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
        content: `Settings for **${session.name}** \u2014 Open to: ${openLabel}, ${session.spots} spots, ${session.interested.length} signed up.`,
        components: [settingsRow],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleGameOpenToggle(interaction, session_id) {
    const sessions = data.getSessions();
    const session  = sessions[session_id];
    if (!session || session.status === 'closed') {
        await interaction.reply({ content: 'Session not available.', flags: MessageFlags.Ephemeral });
        return;
    }

    const isAdmin = perms.check('ADMIN', interaction.member, interaction.user.id);
    const myTeam = data.getTeamByCaptain(interaction.user.id);
    const canManage = isAdmin || session.created_by === interaction.user.id
        || (myTeam && session.team_id === myTeam.id);
    if (!canManage) {
        await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
        return;
    }

    const idx = OPEN_TO_CYCLE.indexOf(session.open_to);
    const next = OPEN_TO_CYCLE[(idx + 1) % OPEN_TO_CYCLE.length];
    sessions[session_id].open_to = next;
    data.saveSessions(sessions);

    // Update the public embed
    try {
        const ch = await interaction.guild.channels.fetch(session.channel_id);
        const msg = await ch.messages.fetch(session.message_id);
        const team = session.team_id ? data.getTeam(session.team_id) : null;
        const embed = buildGameEmbed(sessions[session_id], team);
        const interestRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`GAME_INTEREST_${session.id}`).setLabel("I'm In").setStyle(ButtonStyle.Success),
        );
        const settingsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${CID.GAME_SETTINGS}_${session.id}`).setLabel('\u2699\uFE0F Settings').setStyle(ButtonStyle.Secondary),
        );
        await msg.edit({ embeds: [embed], components: [interestRow, settingsRow] });
    } catch (e) { logger.warn('[game] Failed to refresh embed for session ' + session_id + ' (open toggle): ' + e.message); }

    const newLabel = OPEN_TO_LABELS[next] || next;
    await interaction.update({
        content: `\u2705 Open to changed: **${newLabel}**\nSettings for **${session.name}** \u2014 ${session.spots} spots, ${session.interested.length} signed up.`,
        components: interaction.message.components,
    });
}

async function handleGameSpotUp(interaction, session_id) {
    const sessions = data.getSessions();
    const session  = sessions[session_id];
    if (!session || session.status === 'closed') {
        await interaction.reply({ content: 'Session not available.', flags: MessageFlags.Ephemeral });
        return;
    }

    const isAdmin = perms.check('ADMIN', interaction.member, interaction.user.id);
    const myTeam = data.getTeamByCaptain(interaction.user.id);
    const canManage = isAdmin || session.created_by === interaction.user.id
        || (myTeam && session.team_id === myTeam.id);
    if (!canManage) {
        await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (session.spots >= 20) {
        await interaction.reply({ content: 'Max 20 spots.', flags: MessageFlags.Ephemeral });
        return;
    }

    sessions[session_id].spots++;
    data.saveSessions(sessions);

    // Update public embed
    try {
        const ch = await interaction.guild.channels.fetch(session.channel_id);
        const msg = await ch.messages.fetch(session.message_id);
        const team = session.team_id ? data.getTeam(session.team_id) : null;
        const embed = buildGameEmbed(sessions[session_id], team);
        const interestRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`GAME_INTEREST_${session.id}`).setLabel("I'm In").setStyle(ButtonStyle.Success),
        );
        const settingsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${CID.GAME_SETTINGS}_${session.id}`).setLabel('\u2699\uFE0F Settings').setStyle(ButtonStyle.Secondary),
        );
        await msg.edit({ embeds: [embed], components: [interestRow, settingsRow] });
    } catch (e) { logger.warn('[game] Failed to refresh embed for session ' + session_id + ' (spot up): ' + e.message); }

    await interaction.reply({
        content: `\u2705 Spots increased to **${session.spots}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleGameSpotDown(interaction, session_id) {
    const sessions = data.getSessions();
    const session  = sessions[session_id];
    if (!session || session.status === 'closed') {
        await interaction.reply({ content: 'Session not available.', flags: MessageFlags.Ephemeral });
        return;
    }

    const isAdmin = perms.check('ADMIN', interaction.member, interaction.user.id);
    const myTeam = data.getTeamByCaptain(interaction.user.id);
    const canManage = isAdmin || session.created_by === interaction.user.id
        || (myTeam && session.team_id === myTeam.id);
    if (!canManage) {
        await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
        return;
    }

    const minSpots = Math.max(1, session.interested.length);
    if (session.spots <= minSpots) {
        await interaction.reply({ content: `Cannot reduce below **${minSpots}** (${session.interested.length} player(s) signed up).`, flags: MessageFlags.Ephemeral });
        return;
    }

    sessions[session_id].spots--;
    data.saveSessions(sessions);

    // Update public embed
    try {
        const ch = await interaction.guild.channels.fetch(session.channel_id);
        const msg = await ch.messages.fetch(session.message_id);
        const team = session.team_id ? data.getTeam(session.team_id) : null;
        const embed = buildGameEmbed(sessions[session_id], team);
        const interestRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`GAME_INTEREST_${session.id}`).setLabel("I'm In").setStyle(ButtonStyle.Success),
        );
        const settingsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${CID.GAME_SETTINGS}_${session.id}`).setLabel('\u2699\uFE0F Settings').setStyle(ButtonStyle.Secondary),
        );
        await msg.edit({ embeds: [embed], components: [interestRow, settingsRow] });
    } catch (e) { logger.warn('[game] Failed to refresh embed for session ' + session_id + ' (spot down): ' + e.message); }

    await interaction.reply({
        content: `\u2705 Spots reduced to **${session.spots}**.`,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleGameCloseBtn(interaction, session_id) {
    const sessions = data.getSessions();
    const session  = sessions[session_id];
    if (!session || session.status === 'closed') {
        await interaction.reply({ content: 'Session already closed.', flags: MessageFlags.Ephemeral });
        return;
    }

    const isAdmin = perms.check('ADMIN', interaction.member, interaction.user.id);
    const myTeam = data.getTeamByCaptain(interaction.user.id);
    const canClose = isAdmin || session.created_by === interaction.user.id
        || (myTeam && session.team_id === myTeam.id);
    if (!canClose) {
        await interaction.reply({ content: 'You can only close sessions you created or that belong to your team.', flags: MessageFlags.Ephemeral });
        return;
    }

    sessions[session_id].status = 'closed';
    data.saveSessions(sessions);

    // Update public embed
    try {
        const ch = await interaction.guild.channels.fetch(session.channel_id);
        const msg = await ch.messages.fetch(session.message_id);
        const team = session.team_id ? data.getTeam(session.team_id) : null;
        const embed = buildGameEmbed(sessions[session_id], team);
        await msg.edit({ embeds: [embed], components: [] });
    } catch (e) { logger.warn('[game] Failed to close embed for session ' + session_id + ': ' + e.message); }

    await interaction.reply({ content: `\u2705 Session **${session.name}** closed.`, flags: MessageFlags.Ephemeral });
    logger.info(`[game] Session ${session_id} closed via button by ${interaction.user.id}`);
}

// ── Implementation: External scrim buttons ───────────────────────────────────

async function handleScrimSlotInterest(interaction, rawId) {
    // rawId = cacheId_slotIdx
    const parts = rawId.split('_');
    const slotIdx = parseInt(parts.pop(), 10);
    const cacheId = parts.join('_');

    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots for slot interest: ' + e.message);
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cacheId);
    if (!cached || cached.mode !== 'external_proposal') {
        await interaction.reply({ content: 'Proposal not found or expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const slot = cached.slots[slotIdx];
    if (!slot) {
        await interaction.reply({ content: 'Slot not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const uid = interaction.user.id;

    // Toggle interest
    if (!slot.interested) slot.interested = [];
    if (slot.interested.includes(uid)) {
        slot.interested = slot.interested.filter(id => id !== uid);
        await interaction.reply({ content: `You have been removed from slot ${slotIdx + 1}.`, flags: MessageFlags.Ephemeral });
    } else {
        slot.interested.push(uid);
        await interaction.reply({ content: `\u2705 You're marked as available for slot ${slotIdx + 1}!`, flags: MessageFlags.Ephemeral });
    }

    // Update the embed with new counts
    try {
        const team = data.getTeam(cached.team1_id);
        const newEmbed = new EmbedBuilder()
            .setTitle(`\uD83D\uDCCB External Scrim \u2014 ${team?.name || '?'}`)
            .setColor(0xFEE75C)
            .setFooter({ text: `Cache: ${cacheId}` });

        let desc = `**${team?.name || '?'}** is planning a scrim against an external team.\n\nPick the slots you can make:\n\n`;
        for (let i = 0; i < cached.slots.length; i++) {
            const s = cached.slots[i];
            const count = (s.interested || []).length;
            desc += `\u23F0 **Slot ${i + 1}:** <t:${s.start_unix}:D> <t:${s.start_unix}:t> \u2013 <t:${s.end_unix}:t> \u2014 **${count}** available\n\n`;
        }
        if (cached.include_subs) desc += '\u2705 Substitutes included\n';
        if (cached.allow_fill) desc += '\u2705 Fill interest open\n';

        newEmbed.setDescription(desc);

        if (interaction.message) {
            await interaction.message.edit({ embeds: [newEmbed] });
        }
    } catch (e) { logger.warn('[scrim] Failed to update external scrim embed for cache ' + cacheId + ': ' + e.message); }
}

async function handleScrimAddSlot(interaction, cacheId) {
    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots: ' + e.message);
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cacheId);
    if (!cached || cached.mode !== 'external_proposal') {
        await interaction.reply({ content: 'Proposal not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.user.id !== cached.requested_by) {
        await interaction.reply({ content: 'Only the captain can add time slots.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (cached.slots.length >= 5) {
        await interaction.reply({ content: 'Max 5 time slots.', flags: MessageFlags.Ephemeral });
        return;
    }

    const modal = makeModal(`SCRIM_ADD_SLOT_MODAL_${cacheId}`, 'Add Time Slot', [
        {
            id:          'add_date',
            label:       'Date (YYYY-MM-DD)',
            placeholder: 'e.g. 2026-06-25  — date of the extra slot',
            style:       TextInputStyle.Short,
            required:    true,
        },
        {
            id:          'add_time',
            label:       'Start time',
                placeholder: 'e.g. 7pm, 7:30pm, or 19:00',
            style:       TextInputStyle.Short,
            required:    true,
        },
    ]);

    await interaction.showModal(modal);
}

async function handleScrimAddSlotModal(interaction, cacheId) {
    const dateInput = interaction.fields.getTextInputValue('add_date').trim();
    const timeInput = interaction.fields.getTextInputValue('add_time').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
        await interaction.reply({ content: 'Invalid date \u2014 use `YYYY-MM-DD`.', flags: MessageFlags.Ephemeral });
        return;
    }

    const timeMins = parseTime(timeInput);
    if (timeMins === null) {
        await interaction.reply({ content: `Invalid time \u2014 use \`7pm\`, \`7:30pm\`, or \`19:00\`.`, flags: MessageFlags.Ephemeral });
        return;
    }

    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots for add slot: ' + e.message);
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cacheId);
    if (!cached) {
        await interaction.reply({ content: 'Proposal expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const config = data.getConfig();
    const timezone = cached.timezone || config.timezone || 'America/New_York';
    const [y, mo, dy] = dateInput.split('-').map(Number);
    const start_unix = toUnixTimestamp(y, mo - 1, dy, timeMins, timezone);
    const end_unix = start_unix + 3600 * 3;

    cached.slots.push({ start_unix, end_unix, player_count: 0, dateStr: dateInput, interested: [] });
    pendingSlots.set(cacheId, cached);

    // Rebuild the embed with new slot rows + captain row
    const team = data.getTeam(cached.team1_id);
    let desc = `**${team?.name || '?'}** is planning a scrim against an external team.\n\nPick the slots you can make:\n\n`;
    for (let i = 0; i < cached.slots.length; i++) {
        const s = cached.slots[i];
        const count = (s.interested || []).length;
        desc += `\u23F0 **Slot ${i + 1}:** <t:${s.start_unix}:D> <t:${s.start_unix}:t> \u2013 <t:${s.end_unix}:t> \u2014 **${count}** available\n\n`;
    }
    if (cached.include_subs) desc += '\u2705 Substitutes included\n';
    if (cached.allow_fill) desc += '\u2705 Fill interest open\n';

    const embed = new EmbedBuilder()
        .setTitle(`\uD83D\uDCCB External Scrim \u2014 ${team?.name || '?'}`)
        .setDescription(desc)
        .setColor(0xFEE75C)
        .setFooter({ text: `Cache: ${cacheId}` });

    const rows = [];
    for (let i = 0; i < Math.min(cached.slots.length, 5); i++) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`SCRIM_SLOT_INTEREST_${cacheId}_${i}`)
                .setLabel(`Slot ${i + 1}: I Can Make It`)
                .setStyle(ButtonStyle.Primary),
        ));
    }

    const captainRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`SCRIM_ADD_SLOT_${cacheId}`)
            .setLabel('+ Add Time Slot')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`SCRIM_CONFIRM_${cacheId}`)
            .setLabel('\u2705 Confirm Time')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`SCRIM_CANCEL_PRO_${cacheId}`)
            .setLabel('\u274C Cancel')
            .setStyle(ButtonStyle.Danger),
    );

    const comps = cached.slots.length >= 5 ? [...rows, captainRow].slice(0, 5) : [...rows, captainRow];

    try {
        await interaction.message.edit({ embeds: [embed], components: comps });
        await interaction.reply({ content: `\u2705 Slot added for ${dateInput} at ${timeInput}.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
        logger.warn('[scrim] Failed to update external scrim embed after slot add (cache ' + cacheId + '): ' + e.message);
        await interaction.reply({ content: `\u2705 Slot added for ${dateInput} at ${timeInput}.`, flags: MessageFlags.Ephemeral });
    }
}

async function handleScrimConfirm(interaction, cacheId) {
    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots: ' + e.message);
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cacheId);
    if (!cached || cached.mode !== 'external_proposal') {
        await interaction.reply({ content: 'Proposal not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.user.id !== cached.requested_by) {
        await interaction.reply({ content: 'Only the captain can confirm.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Pick the slot with the most interested players
    let bestSlot = null;
    let bestCount = -1;
    for (const slot of cached.slots) {
        const count = (slot.interested || []).length;
        if (count > bestCount) {
            bestCount = count;
            bestSlot = slot;
        }
    }

    if (!bestSlot) {
        await interaction.reply({ content: 'No slots available.', flags: MessageFlags.Ephemeral });
        return;
    }

    const team1 = data.getTeam(cached.team1_id);
    const config = data.getConfig();

    // Create scrim record
    const scrim_id = randomUUID();
    const scrims = data.getScrims();
    scrims[scrim_id] = {
        id:             scrim_id,
        team1_id:       cached.team1_id,
        team2_id:       '',
        status:         'confirmed',
        scheduled_time: new Date(bestSlot.start_unix * 1000).toISOString(),
        discord_event_id: '',
        requested_by:   cached.requested_by,
        include_subs:   cached.include_subs,
        allow_fill:     cached.allow_fill,
        fill_interests: [],
        result:         null,
        result_embed_posted: false,
        result_message_id:   '',
        players_team1:  bestSlot.interested || [],
        players_team2:  [],
        created_at:     new Date().toISOString(),
    };
    data.saveScrims(scrims);

    pendingSlots.delete(cacheId);

    // Create Discord event (end time = start + 3h, Discord requirement)
    let eventId = '';
    try {
        const startDt = new Date(bestSlot.start_unix * 1000);
        const event = await interaction.guild.scheduledEvents.create({
            name: `Scrim: ${team1?.name || '?'} (External)`,
            scheduledStartTime: startDt,
            scheduledEndTime: new Date(startDt.getTime() + 3 * 60 * 60 * 1000),
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.External,
            entityMetadata: { location: 'Custom Game Lobby' },
            description: `${team1?.name || '?'} is scrimming an external team. Come spectate!`,
        });
        eventId = event.id;
        scrims[scrim_id].discord_event_id = eventId;
        data.saveScrims(scrims);
    } catch (e) { logger.warn('[scrim] Could not create Discord event for external scrim ' + scrim_id + ': ' + e.message); }

    // Post to scrim channel for visibility
    if (config.scrim_channel_id) {
        try {
            const ch = await interaction.guild.channels.fetch(config.scrim_channel_id);
            const unix = bestSlot.start_unix;
            const confirmEmbed = new EmbedBuilder()
                .setTitle(`\u2705 Scrim Scheduled \u2014 ${team1?.name || '?'}`)
                .setDescription(
                    `**${team1?.name || '?'}** is scrimming an external team.\n\n` +
                    `\uD83D\uDCC5 <t:${unix}:D> \u23F0 <t:${unix}:t>\n` +
                    `\uD83D\uDC65 ${bestCount} player(s) confirmed.\n` +
                    (eventId ? `\nA Discord event has been created \u2014 come spectate!\n` : '')
                )
                .setColor(0x57F287);
            await ch.send({ embeds: [confirmEmbed] });
        } catch (e) { logger.warn('[scrim] Could not post external scrim announcement to scrim channel: ' + e.message); }
    }

    // Update original message
    const confirmEmbed = new EmbedBuilder()
        .setTitle(`\u2705 Scrim Confirmed \u2014 ${team1?.name || '?'}`)
        .setDescription(
            `External scrim scheduled!\n` +
            `\uD83D\uDCC5 <t:${bestSlot.start_unix}:D> \u23F0 <t:${bestSlot.start_unix}:t>\n` +
            `\uD83D\uDC65 ${bestCount} player(s) confirmed.\n` +
            (eventId ? '\nDiscord event created! Come spectate.\n' : '')
        )
        .setColor(0x57F287);

    try {
        await interaction.message.edit({ embeds: [confirmEmbed], components: [] });
    } catch (e) {
        logger.warn('[scrim] Could not update external scrim embed on confirm (cache ' + cacheId + '): ' + e.message);
        await interaction.reply({ embeds: [confirmEmbed] });
    }

    logger.info(`[scrim] External scrim ${scrim_id} confirmed for ${team1?.name} at <t:${bestSlot.start_unix}>`);
}

async function handleScrimCancelProposal(interaction, cacheId) {
    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots: ' + e.message);
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cacheId);
    if (!cached || cached.mode !== 'external_proposal') {
        await interaction.reply({ content: 'Proposal not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.user.id !== cached.requested_by) {
        await interaction.reply({ content: 'Only the captain can cancel.', flags: MessageFlags.Ephemeral });
        return;
    }

    pendingSlots.delete(cacheId);

    const cancelEmbed = new EmbedBuilder()
        .setTitle('\u274C Scrim Cancelled')
        .setDescription('This scrim proposal has been cancelled by the captain.')
        .setColor(0xED4245);

    try {
        await interaction.message.edit({ embeds: [cancelEmbed], components: [] });
    } catch (e) {
        logger.warn('[scrim] Could not update cancel embed (cache ' + cacheId + '): ' + e.message);
        await interaction.reply({ embeds: [cancelEmbed], flags: MessageFlags.Ephemeral });
    }

    logger.info(`[scrim] External proposal ${cacheId} cancelled by ${interaction.user.id}`);
}

// ── Scrim manual modal handler ─────────────────────────────────────────────────

async function handleScrimManualModal(interaction, cacheId) {
    const dateInput = interaction.fields.getTextInputValue('manual_date').trim();
    const timeInput = interaction.fields.getTextInputValue('manual_time').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
        await interaction.reply({ content: 'Invalid date \u2014 use `YYYY-MM-DD`.', flags: MessageFlags.Ephemeral });
        return;
    }

    const timeMins = parseTime(timeInput);
    if (timeMins === null) {
        await interaction.reply({ content: `Invalid time \u2014 use \`7pm\`, \`7:30pm\`, or \`19:00\`.`, flags: MessageFlags.Ephemeral });
        return;
    }

    let pendingSlots;
    try {
        pendingSlots = require('./commands/scrim.js').pendingSlots;
    } catch (e) {
        logger.warn('[scrim] Could not require pendingSlots for manual modal (cache ' + cacheId + '): ' + e.message);
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const cached = pendingSlots.get(cacheId);
    if (!cached) {
        await interaction.reply({ content: 'Session expired.', flags: MessageFlags.Ephemeral });
        return;
    }

    const config = data.getConfig();
    const timezone = cached.timezone || config.timezone || 'America/New_York';
    const [y, mo, dy] = dateInput.split('-').map(Number);
    const start_unix = toUnixTimestamp(y, mo - 1, dy, timeMins, timezone);

    if (cached.mode === 'external' || cached.mode === 'external_proposal') {
        // Post external proposal directly
        const team1 = data.getTeam(cached.team1_id);
        const slots = [{ start_unix, player_count: 0, dateStr: dateInput, interested: [] }];
        pendingSlots.delete(cacheId);

        const proposalCacheId = randomUUID().replace(/-/g, '').substring(0, 12);
        pendingSlots.set(proposalCacheId, {
            ...cached, slots, mode: 'external_proposal',
        });
        setTimeout(() => pendingSlots.delete(proposalCacheId), 24 * 60 * 60 * 1000);

        await postExternalScrimEmbed(interaction, data, team1, slots, proposalCacheId,
            cached.include_subs, cached.allow_fill, cached.requested_by);
        return;
    }

    // Internal: send directly to scrim channel
    const team1 = data.getTeam(cached.team1_id);
    const team2 = data.getTeam(cached.team2_id);
    if (!team1 || !team2 || !config.scrim_channel_id) {
        await interaction.reply({ content: 'Configuration missing.', flags: MessageFlags.Ephemeral });
        return;
    }

    const scrim_id = randomUUID();
    const scrims = data.getScrims();
    scrims[scrim_id] = {
        id:             scrim_id,
        team1_id:       cached.team1_id,
        team2_id:       cached.team2_id,
        status:         'pending',
        scheduled_time: new Date(start_unix * 1000).toISOString(),
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

    pendingSlots.delete(cacheId);

    const scrimChannel = await interaction.guild.channels.fetch(config.scrim_channel_id).catch(() => null);
    if (!scrimChannel) {
        await interaction.reply({ content: 'Scrim channel not found.', flags: MessageFlags.Ephemeral });
        return;
    }

    const acceptRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`SCRIM_ACCEPT_${scrim_id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`SCRIM_DECLINE_${scrim_id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );

    const embed = new EmbedBuilder()
        .setTitle(`Scrim Request \u2014 ${team1.name} vs ${team2.name}`)
        .setDescription(
            `**${team1.name}** has challenged **${team2.name}** to a scrim!\n\n` +
            `\uD83D\uDCC5 **Date:** <t:${start_unix}:D>\n` +
            `\u23F0 **Time:** <t:${start_unix}:t>\n\n` +
            `<@${team2.captain_id || ''}>, please **Accept** or **Decline**.\n` +
            (cached.include_subs ? '\u2705 Substitutes included\n' : '') +
            (cached.allow_fill   ? '\u2705 Fill interest open' : '')
        )
        .setColor(0xFEE75C)
        .setFooter({ text: `Scrim ID: ${scrim_id}` })
        .setTimestamp();

    await scrimChannel.send({ content: team2.captain_id ? `<@${team2.captain_id}>` : '', embeds: [embed], components: [acceptRow] });
    await interaction.reply({ content: `\u2705 Manual scrim request sent to **${team2.name}**! Check <#${config.scrim_channel_id}>.`, flags: MessageFlags.Ephemeral });

    logger.info(`[scrim] Manual scrim ${scrim_id} created at <t:${start_unix}> by ${interaction.user.id}`);
}

module.exports = register_handlers;

// Exposed for the validation/test harness only (no effect on runtime behavior).
module.exports.__test = {
    setContext: (d, p, l) => { data = d; perms = p; logger = l; },
    checkDueScrims,
    buildResultEmbed,
    defaultRoster,
};
