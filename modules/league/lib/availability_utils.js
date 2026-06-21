'use strict';

/**
 * Availability utility functions for CADBot.
 *
 * Each player stores times in THEIR OWN timezone (availability.timezone field).
 * All cross-player comparison (scrims, compare view) is done in UTC so players
 * across different timezones are compared correctly. Results are expressed as
 * Unix timestamps so Discord's <t:> formatting handles localisation for viewers.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Timezone options for the Set Timezone select menu ─────────────────────────

const TIMEZONE_OPTIONS = [
    { label: 'Eastern Time (ET)',       value: 'America/New_York',    description: 'UTC−5 / UTC−4 (DST)' },
    { label: 'Central Time (CT)',       value: 'America/Chicago',     description: 'UTC−6 / UTC−5 (DST)' },
    { label: 'Mountain Time (MT)',      value: 'America/Denver',      description: 'UTC−7 / UTC−6 (DST)' },
    { label: 'Pacific Time (PT)',       value: 'America/Los_Angeles', description: 'UTC−8 / UTC−7 (DST)' },
    { label: 'Alaska Time (AKT)',       value: 'America/Anchorage',   description: 'UTC−9 / UTC−8 (DST)' },
    { label: 'Hawaii Time (HT)',        value: 'Pacific/Honolulu',    description: 'UTC−10 (no DST)' },
    { label: 'Atlantic Time (AT)',      value: 'America/Halifax',     description: 'UTC−4 / UTC−3 (DST)' },
    { label: 'UTC',                     value: 'UTC',                 description: 'Coordinated Universal Time' },
    { label: 'London (GMT/BST)',        value: 'Europe/London',       description: 'UTC+0 / UTC+1 (DST)' },
    { label: 'Central Europe (CET)',    value: 'Europe/Paris',        description: 'UTC+1 / UTC+2 (DST)' },
    { label: 'Eastern Europe (EET)',    value: 'Europe/Helsinki',     description: 'UTC+2 / UTC+3 (DST)' },
    { label: 'Moscow (MSK)',            value: 'Europe/Moscow',       description: 'UTC+3 (no DST)' },
    { label: 'Korea Standard (KST)',    value: 'Asia/Seoul',          description: 'UTC+9 (no DST)' },
    { label: 'Japan Standard (JST)',    value: 'Asia/Tokyo',          description: 'UTC+9 (no DST)' },
    { label: 'Australia / Sydney',      value: 'Australia/Sydney',    description: 'UTC+10 / UTC+11 (DST)' },
];

// ── Time parsing / formatting ─────────────────────────────────────────────────

/**
 * Parses "HH:MM" (24h) or "H:MMam/pm" to minutes since midnight.
 * Returns null if unparseable.
 */
function parseTime(str) {
    if (!str) return null;
    str = str.trim();
    const h12 = str.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/i);
    if (h12) {
        let hours  = parseInt(h12[1], 10);
        const mins = parseInt(h12[2] || '0', 10);
        const ampm = h12[3].toLowerCase();
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        return hours * 60 + mins;
    }
    const h24 = str.match(/^(\d{1,2}):(\d{2})$/);
    if (h24) return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10);
    return null;
}

/** Formats minutes-since-midnight to a 12-hour string ("7:00 PM"). */
function formatTime(minutes) {
    const h    = Math.floor(minutes / 60) % 24;
    const m    = minutes % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

/** Formats a date to "DayName, Mon DD" (e.g. "Tuesday, Jan 21"). */
function formatDate(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/** Returns "YYYY-MM-DD" for a Date. */
function toDateStr(date) {
    return date.toISOString().split('T')[0];
}

// ── Timezone conversion ───────────────────────────────────────────────────────

/**
 * Converts a wall-clock time (date + minutes-since-midnight) in a given IANA
 * timezone to a UTC Unix timestamp (seconds). DST-aware.
 */
function toUnixTimestamp(date, minutes, timezone = 'America/New_York') {
    const year = date.getFullYear();
    const mon  = date.getMonth();
    const day  = date.getDate();
    const hour = Math.floor(minutes / 60);
    const min  = minutes % 60;

    const asUTC = Date.UTC(year, mon, day, hour, min, 0);

    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(new Date(asUTC));

    const get = (type) => parseInt(parts.find(p => p.type === type)?.value, 10);
    let zoneHour = get('hour');
    if (zoneHour === 24) zoneHour = 0;

    const asZone = Date.UTC(get('year'), get('month') - 1, get('day'), zoneHour, get('minute'), get('second'));
    const offset = asZone - asUTC;
    return Math.floor((asUTC - offset) / 1000);
}

// ── Per-player local window extraction ───────────────────────────────────────

/**
 * Returns the raw local-time windows (start/end in minutes-since-midnight, in
 * the player's own timezone) for a given date. Applies overrides over weekly.
 */
function getPlayerWindows(player_id, date, availability_data) {
    const avail = availability_data[player_id];
    if (!avail) return [];

    const dateStr = toDateStr(date);
    const dayName = DAY_NAMES[date.getDay()];

    if (avail.overrides && Object.prototype.hasOwnProperty.call(avail.overrides, dateStr)) {
        const override = avail.overrides[dateStr];
        if (override === null) return [];
        return (override || []).map(w => ({
            start: parseTime(w.start) ?? 0,
            end:   parseTime(w.end)   ?? 0,
        })).filter(w => w.end > w.start);
    }

    const dayWindows = avail.weekly?.[dayName] || [];
    return dayWindows.map(w => ({
        start: parseTime(w.start) ?? 0,
        end:   parseTime(w.end)   ?? 0,
    })).filter(w => w.end > w.start);
}

// ── UTC-based team window finder ──────────────────────────────────────────────

/**
 * Finds time blocks (as UTC Unix timestamps) where at least min_players from
 * the list are all free at the same time, for >= 60 minutes.
 *
 * Each player's stored times are interpreted in THEIR own timezone
 * (availability_data[id].timezone), then converted to UTC for comparison.
 *
 * @param {string[]} player_ids
 * @param {Date}     date
 * @param {Object}   availability_data
 * @param {number}   [min_players=5]
 * @returns {{ start_unix: number, end_unix: number, player_count: number }[]}
 */
function findTeamWindowsUTC(player_ids, date, availability_data, min_players = 5) {
    const all_windows = [];

    for (const pid of player_ids) {
        const avail = availability_data[pid];
        if (!avail) continue;
        const tz = avail.timezone || 'America/New_York';

        const localWins = getPlayerWindows(pid, date, availability_data);
        for (const w of localWins) {
            const start_unix = toUnixTimestamp(date, w.start, tz);
            const end_unix   = toUnixTimestamp(date, w.end,   tz);
            if (end_unix > start_unix) {
                all_windows.push({ pid, start_unix, end_unix });
            }
        }
    }

    if (all_windows.length === 0) return [];

    const range_start = Math.min(...all_windows.map(w => w.start_unix));
    const range_end   = Math.max(...all_windows.map(w => w.end_unix));

    // 5-minute resolution
    const SLOT_SEC  = 5 * 60;
    const num_slots = Math.ceil((range_end - range_start) / SLOT_SEC);
    if (num_slots <= 0 || num_slots > 20000) return [];

    const slot_counts = new Array(num_slots).fill(0);
    for (const w of all_windows) {
        const s = Math.max(0, Math.floor((w.start_unix - range_start) / SLOT_SEC));
        const e = Math.min(num_slots, Math.ceil((w.end_unix - range_start) / SLOT_SEC));
        for (let i = s; i < e; i++) slot_counts[i]++;
    }

    const results = [];
    let block_start = null;
    let block_min   = Infinity;

    for (let i = 0; i <= num_slots; i++) {
        const enough = i < num_slots && slot_counts[i] >= min_players;
        if (enough) {
            if (block_start === null) { block_start = i; block_min = Infinity; }
            block_min = Math.min(block_min, slot_counts[i]);
        } else if (block_start !== null) {
            const start_unix = range_start + block_start * SLOT_SEC;
            const end_unix   = range_start + i * SLOT_SEC;
            if (end_unix - start_unix >= 3600) {
                results.push({ start_unix, end_unix, player_count: block_min });
            }
            block_start = null;
            block_min   = Infinity;
        }
    }

    return results;
}

// ── Scrim slot finder ─────────────────────────────────────────────────────────

/**
 * Finds overlapping time slots between two teams over the next `days` days.
 * Times are expressed as Unix timestamps (UTC) so Discord localises them.
 *
 * @param {string[]} team1_players
 * @param {string[]} team2_players
 * @param {Object}   availability_data
 * @param {Object}   options
 * @returns {{ date: Date, start_unix: number, end_unix: number, t1_count: number, t2_count: number }[]}
 */
function findScrimSlots(team1_players, team2_players, availability_data, options = {}) {
    const { days = 14, max_slots = 5, min_per_team = 5 } = options;
    const results = [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = 1; d <= days && results.length < max_slots; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() + d);

        const t1_wins = findTeamWindowsUTC(team1_players, date, availability_data, min_per_team);
        const t2_wins = findTeamWindowsUTC(team2_players, date, availability_data, min_per_team);

        for (const w1 of t1_wins) {
            for (const w2 of t2_wins) {
                const start = Math.max(w1.start_unix, w2.start_unix);
                const end   = Math.min(w1.end_unix,   w2.end_unix);
                if (end - start >= 3600) {
                    results.push({ date, start_unix: start, end_unix: end, t1_count: w1.player_count, t2_count: w2.player_count });
                    if (results.length >= max_slots) break;
                }
            }
            if (results.length >= max_slots) break;
        }
    }

    return results;
}

// ── Two-player availability comparison ───────────────────────────────────────

/**
 * Compares two players' availability over the next `days` days and returns
 * per-day overlapping windows as Unix timestamps.
 *
 * @param {string} player1_id
 * @param {string} player2_id
 * @param {Object} availability_data
 * @param {number} [days=7]
 * @returns {{ date: Date, overlaps: { start_unix: number, end_unix: number }[] }[]}
 */
function comparePlayerAvailability(player1_id, player2_id, availability_data, days = 7) {
    const results = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = 1; d <= days; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() + d);

        const p1_wins = findTeamWindowsUTC([player1_id], date, availability_data, 1);
        const p2_wins = findTeamWindowsUTC([player2_id], date, availability_data, 1);

        const overlaps = [];
        for (const w1 of p1_wins) {
            for (const w2 of p2_wins) {
                const start = Math.max(w1.start_unix, w2.start_unix);
                const end   = Math.min(w1.end_unix,   w2.end_unix);
                if (end - start >= 1800) { // at least 30 minutes
                    overlaps.push({ start_unix: start, end_unix: end });
                }
            }
        }

        results.push({ date, overlaps });
    }

    return results;
}

// ── Availability display helpers ──────────────────────────────────────────────

/**
 * Returns a formatted summary of a player's weekly availability.
 * Times are shown in the player's own timezone.
 */
function formatWeeklySchedule(avail) {
    if (!avail?.weekly) return '_Not set_';
    const lines = [];
    for (const day of DAY_NAMES) {
        const windows  = avail.weekly[day] || [];
        const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
        if (windows.length === 0) {
            lines.push(`**${dayLabel}**: —`);
        } else {
            const ranges = windows
                .map(w => `${formatTime(parseTime(w.start))} – ${formatTime(parseTime(w.end))}`)
                .join(', ');
            lines.push(`**${dayLabel}**: ${ranges}`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    DAY_NAMES,
    TIMEZONE_OPTIONS,
    parseTime,
    formatTime,
    formatDate,
    toDateStr,
    getPlayerWindows,
    findTeamWindowsUTC,
    findScrimSlots,
    toUnixTimestamp,
    formatWeeklySchedule,
    comparePlayerAvailability,
};
