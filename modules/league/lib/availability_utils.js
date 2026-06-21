'use strict';

/**
 * Availability utility functions for CADBot.
 *
 * Times in availability data are stored as "HH:MM" (24-hour, server timezone).
 * Slot granularity is 30 minutes → 48 slots per day (slot 0 = 00:00, slot 47 = 23:30).
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// ── Time parsing / formatting ─────────────────────────────────────────────────

/**
 * Parses "HH:MM" (24h) or "H:MMam/pm" to minutes since midnight.
 * Returns null if unparseable.
 * @param {string} str
 * @returns {number|null}
 */
function parseTime(str) {
    if (!str) return null;
    str = str.trim();

    // 12-hour format: "7pm", "7:30pm", "7:00 PM"
    const h12 = str.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/i);
    if (h12) {
        let hours   = parseInt(h12[1], 10);
        const mins  = parseInt(h12[2] || '0', 10);
        const ampm  = h12[3].toLowerCase();
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        return hours * 60 + mins;
    }

    // 24-hour format: "19:00", "7:00"
    const h24 = str.match(/^(\d{1,2}):(\d{2})$/);
    if (h24) return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10);

    return null;
}

/**
 * Formats minutes-since-midnight to a 12-hour string ("7:00 PM").
 * @param {number} minutes
 * @returns {string}
 */
function formatTime(minutes) {
    const h    = Math.floor(minutes / 60) % 24;
    const m    = minutes % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

/**
 * Formats a date to "DayName, Mon DD" (e.g. "Tuesday, Jan 21").
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Returns the YYYY-MM-DD string for a Date in UTC.
 * @param {Date} date
 * @returns {string}
 */
function toDateStr(date) {
    return date.toISOString().split('T')[0];
}

// ── Slot helpers ──────────────────────────────────────────────────────────────

/** Convert minutes-since-midnight to a 30-min slot index (0–47). */
function minsToSlot(minutes) { return Math.floor(minutes / 30); }

/** Convert a 30-min slot index back to minutes. */
function slotToMins(slot)    { return slot * 30; }

// ── Core availability logic ───────────────────────────────────────────────────

/**
 * Returns an array of available time windows for a single player on a given date.
 *
 * @param {string} player_id        - Discord user ID
 * @param {Date}   date             - Date to check
 * @param {Object} availability_data - Full availability.json object
 * @returns {{ start: number, end: number }[]}  Array of { start, end } in minutes
 */
function getPlayerWindows(player_id, date, availability_data) {
    const avail = availability_data[player_id];
    if (!avail) return [];

    const dateStr = toDateStr(date);
    const dayName = DAY_NAMES[date.getDay()];

    // Date override takes priority over weekly schedule
    if (avail.overrides && Object.prototype.hasOwnProperty.call(avail.overrides, dateStr)) {
        const override = avail.overrides[dateStr];
        if (override === null) return [];           // Marked explicitly unavailable
        return (override || []).map(w => ({
            start: parseTime(w.start) ?? 0,
            end:   parseTime(w.end)   ?? 0,
        })).filter(w => w.end > w.start);
    }

    // Weekly recurring schedule
    const dayWindows = avail.weekly?.[dayName] || [];
    return dayWindows.map(w => ({
        start: parseTime(w.start) ?? 0,
        end:   parseTime(w.end)   ?? 0,
    })).filter(w => w.end > w.start);
}

/**
 * Finds time windows on a given date where at least `min_players` from the
 * provided player list are simultaneously available, for a minimum of 60 minutes.
 *
 * @param {string[]} player_ids      - Discord user IDs to check
 * @param {Date}     date
 * @param {Object}   availability_data
 * @param {number}   [min_players=5] - Minimum players required
 * @returns {{ start: number, end: number, player_count: number }[]}
 */
function findTeamWindows(player_ids, date, availability_data, min_players = 5) {
    // Count how many players are available in each 30-min slot
    const slot_counts = new Array(48).fill(0);

    for (const pid of player_ids) {
        const windows = getPlayerWindows(pid, date, availability_data);
        for (const w of windows) {
            const s = Math.max(0, minsToSlot(w.start));
            const e = Math.min(48, minsToSlot(w.end));
            for (let i = s; i < e; i++) slot_counts[i]++;
        }
    }

    // Gather contiguous blocks with enough players
    const results = [];
    let block_start      = null;
    let block_min_count  = Infinity;

    for (let i = 0; i <= 48; i++) {
        const enough = i < 48 && slot_counts[i] >= min_players;

        if (enough) {
            if (block_start === null) { block_start = i; block_min_count = Infinity; }
            block_min_count = Math.min(block_min_count, slot_counts[i]);
        } else {
            if (block_start !== null) {
                const startMins = slotToMins(block_start);
                const endMins   = slotToMins(i);
                if (endMins - startMins >= 60) {   // Require at least 1 hour
                    results.push({ start: startMins, end: endMins, player_count: block_min_count });
                }
                block_start     = null;
                block_min_count = Infinity;
            }
        }
    }

    return results;
}

/**
 * Finds overlapping windows between two teams over the next `days` days.
 * Returns up to `max_slots` results sorted by date.
 *
 * @param {string[]} team1_players
 * @param {string[]} team2_players
 * @param {Object}   availability_data
 * @param {Object}   options
 * @param {number}   [options.days=14]
 * @param {number}   [options.max_slots=5]
 * @param {number}   [options.min_per_team=5]
 * @returns {{ date: Date, start: number, end: number, t1_count: number, t2_count: number }[]}
 */
function findScrimSlots(team1_players, team2_players, availability_data, options = {}) {
    const { days = 14, max_slots = 5, min_per_team = 5 } = options;
    const results = [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = 1; d <= days && results.length < max_slots; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() + d);

        const t1_windows = findTeamWindows(team1_players, date, availability_data, min_per_team);
        const t2_windows = findTeamWindows(team2_players, date, availability_data, min_per_team);

        // Intersect team1 and team2 windows
        for (const w1 of t1_windows) {
            for (const w2 of t2_windows) {
                const start = Math.max(w1.start, w2.start);
                const end   = Math.min(w1.end,   w2.end);
                if (end - start >= 60) {
                    results.push({
                        date,
                        start,
                        end,
                        t1_count: w1.player_count,
                        t2_count: w2.player_count,
                    });
                    if (results.length >= max_slots) break;
                }
            }
            if (results.length >= max_slots) break;
        }
    }

    return results;
}

/**
 * Converts a date + minutes-since-midnight to a Unix timestamp (seconds).
 * Assumes the stored time is in the server's local timezone offset from config.
 * Uses the IANA timezone string for accurate DST-aware conversion.
 *
 * @param {Date}   date
 * @param {number} minutes - Minutes since midnight
 * @param {string} [timezone='America/New_York']
 * @returns {number} Unix timestamp in seconds
 */
function toUnixTimestamp(date, minutes, timezone = 'America/New_York') {
    // Calendar components of the intended wall-clock time.
    const year = date.getFullYear();
    const mon  = date.getMonth();
    const day  = date.getDate();
    const hour = Math.floor(minutes / 60);
    const min  = minutes % 60;

    // Treat the desired wall-clock time as if it were UTC.
    const asUTC = Date.UTC(year, mon, day, hour, min, 0);

    // Render that same instant in the target timezone to discover the zone's
    // offset at that moment (DST-aware), then back the offset out.
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year:     'numeric', month:  '2-digit', day:    '2-digit',
        hour:     '2-digit', minute: '2-digit', second: '2-digit',
        hour12:   false,
    }).formatToParts(new Date(asUTC));

    const get = (type) => parseInt(parts.find(p => p.type === type)?.value, 10);
    let zoneHour = get('hour');
    if (zoneHour === 24) zoneHour = 0; // Intl can emit "24" for midnight in some envs

    const asZone = Date.UTC(get('year'), get('month') - 1, get('day'), zoneHour, get('minute'), get('second'));

    // offset = (wall-clock interpreted in zone) - (wall-clock interpreted as UTC)
    const offset = asZone - asUTC;

    // The true UTC instant for the requested wall-clock time in `timezone`.
    return Math.floor((asUTC - offset) / 1000);
}

// ── Availability display helpers ──────────────────────────────────────────────

/**
 * Returns a formatted summary of a player's weekly availability.
 * @param {Object} avail - The player's availability record
 * @returns {string}
 */
function formatWeeklySchedule(avail) {
    if (!avail?.weekly) return '_Not set_';
    const lines = [];
    for (const day of DAY_NAMES) {
        const windows = avail.weekly[day] || [];
        const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
        if (windows.length === 0) {
            lines.push(`**${dayLabel}**: —`);
        } else {
            const ranges = windows.map(w => `${formatTime(parseTime(w.start))} – ${formatTime(parseTime(w.end))}`).join(', ');
            lines.push(`**${dayLabel}**: ${ranges}`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    DAY_NAMES,
    parseTime,
    formatTime,
    formatDate,
    toDateStr,
    getPlayerWindows,
    findTeamWindows,
    findScrimSlots,
    toUnixTimestamp,
    formatWeeklySchedule,
};
