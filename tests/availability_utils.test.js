'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    parseTime,
    toUnixTimestamp,
    findScrimSlots,
    formatTime,
    comparePlayerAvailability,
} = require('../modules/league/lib/availability_utils.js');

// ── parseTime ─────────────────────────────────────────────────────────────────

describe('parseTime', () => {
    it('parses 12-hour format without minutes', () => {
        assert.strictEqual(parseTime('7pm'), 19 * 60);
        assert.strictEqual(parseTime('7am'), 7 * 60);
        assert.strictEqual(parseTime('12pm'), 12 * 60);
        assert.strictEqual(parseTime('12am'), 0);
    });

    it('parses 12-hour format with minutes', () => {
        assert.strictEqual(parseTime('7:30pm'), 19 * 60 + 30);
        assert.strictEqual(parseTime('7:00am'), 7 * 60);
        assert.strictEqual(parseTime('11:59pm'), 23 * 60 + 59);
    });

    it('parses 12-hour format with spaces around am/pm', () => {
        assert.strictEqual(parseTime('7 pm'), 19 * 60);
        assert.strictEqual(parseTime('7:30 PM'), 19 * 60 + 30);
        assert.strictEqual(parseTime('12:00 am'), 0);
    });

    it('parses 24-hour format', () => {
        assert.strictEqual(parseTime('19:00'), 19 * 60);
        assert.strictEqual(parseTime('00:00'), 0);
        assert.strictEqual(parseTime('23:59'), 23 * 60 + 59);
        assert.strictEqual(parseTime('7:00'), 7 * 60);
        assert.strictEqual(parseTime('0:00'), 0);
    });

    it('returns null for invalid input', () => {
        assert.strictEqual(parseTime(''), null);
        assert.strictEqual(parseTime(null), null);
        assert.strictEqual(parseTime('abc'), null);
    });
});

// ── toUnixTimestamp ───────────────────────────────────────────────────────────

describe('toUnixTimestamp', () => {
    it('converts Eastern Time correctly (EDT, DST)', () => {
        // 2025-07-04 19:00 EDT = 23:00 UTC = 1751670000
        const unix = toUnixTimestamp(2025, 6, 4, 19 * 60, 'America/New_York');
        assert.strictEqual(unix, 1751670000);
    });

    it('converts Eastern Time correctly (EST, no DST)', () => {
        // 2025-01-15 19:00 EST = 00:00 UTC next day = 1736996400
        const unix = toUnixTimestamp(2025, 0, 15, 19 * 60, 'America/New_York');
        // EST = UTC-5, so 19:00 EST = 00:00 UTC on Jan 16
        const expected = Date.UTC(2025, 0, 16, 0, 0, 0) / 1000;
        assert.strictEqual(unix, expected);
    });

    it('handles UTC timezone', () => {
        const unix = toUnixTimestamp(2025, 0, 1, 12 * 60, 'UTC');
        const expected = Date.UTC(2025, 0, 1, 12, 0, 0) / 1000;
        assert.strictEqual(unix, expected);
    });

    it('handles Pacific Time (PST)', () => {
        // Jan 15 is PST (UTC-8): 19:00 PST = 03:00 UTC next day
        const unix = toUnixTimestamp(2025, 0, 15, 19 * 60, 'America/Los_Angeles');
        const expected = Date.UTC(2025, 0, 16, 3, 0, 0) / 1000;
        assert.strictEqual(unix, expected);
    });

    it('handles Pacific Time (PDT, DST)', () => {
        // Jul 4 is PDT (UTC-7): 19:00 PDT = 02:00 UTC next day
        const unix = toUnixTimestamp(2025, 6, 4, 19 * 60, 'America/Los_Angeles');
        const expected = Date.UTC(2025, 6, 5, 2, 0, 0) / 1000;
        assert.strictEqual(unix, expected);
    });

    it('handles midnight', () => {
        const unix = toUnixTimestamp(2025, 0, 1, 0, 'America/New_York');
        const expected = Date.UTC(2025, 0, 1, 5, 0, 0) / 1000; // EST UTC-5
        assert.strictEqual(unix, expected);
    });
});

// ── findScrimSlots ────────────────────────────────────────────────────────────

describe('findScrimSlots', () => {
    const tz = 'America/New_York';

    function makeAvail(playerIds, dayWindows) {
        const avail = {};
        for (const pid of playerIds) {
            avail[pid] = {
                discord_id: pid,
                timezone: tz,
                weekly: {
                    monday: [], tuesday: [], wednesday: [], thursday: [],
                    friday: [], saturday: [], sunday: [],
                },
                overrides: {},
            };
            for (const [day, windows] of Object.entries(dayWindows)) {
                if (avail[pid].weekly[day]) avail[pid].weekly[day] = windows;
            }
        }
        return avail;
    }

    it('finds overlapping slots when both teams have evening availability', () => {
        // Team 1: 5 players available Mon-Thu 7pm-10pm
        const t1 = ['a1', 'a2', 'a3', 'a4', 'a5'];
        // Team 2: 5 players available Mon-Thu 8pm-11pm
        const t2 = ['b1', 'b2', 'b3', 'b4', 'b5'];
        const avail = {
            ...makeAvail(t1, {
                monday: [{ start: '19:00', end: '22:00' }],
                tuesday: [{ start: '19:00', end: '22:00' }],
                wednesday: [{ start: '19:00', end: '22:00' }],
                thursday: [{ start: '19:00', end: '22:00' }],
            }),
            ...makeAvail(t2, {
                monday: [{ start: '20:00', end: '23:00' }],
                tuesday: [{ start: '20:00', end: '23:00' }],
                wednesday: [{ start: '20:00', end: '23:00' }],
                thursday: [{ start: '20:00', end: '23:00' }],
            }),
        };

        const slots = findScrimSlots(t1, t2, avail, { days: 14, max_slots: 5, min_per_team: 5 });
        // Overlap is 8pm-10pm = 2 hours >= 1 hour minimum
        assert.ok(slots.length > 0, 'Should find overlapping slots');
        assert.ok(slots.every(s => s.t1_count >= 5 && s.t2_count >= 5));
    });

    it('finds overlapping slots across different timezones', () => {
        // Team 1 in ET, Team 2 in PT
        const t1 = ['a1', 'a2', 'a3', 'a4', 'a5'];
        const t2 = ['b1', 'b2', 'b3', 'b4', 'b5'];
        const avail = {};

        for (const pid of t1) {
            avail[pid] = {
                discord_id: pid,
                timezone: 'America/New_York',
                weekly: {
                    monday: [{ start: '19:00', end: '22:00' }],
                    tuesday: [], wednesday: [], thursday: [],
                    friday: [], saturday: [], sunday: [],
                },
                overrides: {},
            };
        }
        for (const pid of t2) {
            avail[pid] = {
                discord_id: pid,
                timezone: 'America/Los_Angeles',
                weekly: {
                    monday: [{ start: '16:00', end: '19:00' }], // 4pm-7pm PT = 7pm-10pm ET
                    tuesday: [], wednesday: [], thursday: [],
                    friday: [], saturday: [], sunday: [],
                },
                overrides: {},
            };
        }

        const slots = findScrimSlots(t1, t2, avail, { days: 14, max_slots: 5, min_per_team: 5 });
        assert.ok(slots.length > 0, 'Should find overlapping slots across timezones');
    });

    it('returns empty when teams have no overlap', () => {
        const t1 = ['a1', 'a2', 'a3', 'a4', 'a5'];
        const t2 = ['b1', 'b2', 'b3', 'b4', 'b5'];
        const avail = {
            ...makeAvail(t1, { monday: [{ start: '08:00', end: '12:00' }] }),
            ...makeAvail(t2, { monday: [{ start: '18:00', end: '22:00' }] }),
        };

        const slots = findScrimSlots(t1, t2, avail, { days: 14, max_slots: 5, min_per_team: 5 });
        assert.strictEqual(slots.length, 0);
    });

    it('returns empty when fewer than 5 players are available per team', () => {
        const t1 = ['a1', 'a2', 'a3']; // only 3 players
        const t2 = ['b1', 'b2', 'b3', 'b4', 'b5'];
        const windows = { monday: [{ start: '19:00', end: '22:00' }] };
        const avail = {
            ...makeAvail(t1, windows),
            ...makeAvail(t2, windows),
        };

        const slots = findScrimSlots(t1, t2, avail, { days: 14, max_slots: 5, min_per_team: 5 });
        assert.strictEqual(slots.length, 0);
    });
});

// ── formatTime ────────────────────────────────────────────────────────────────

describe('formatTime', () => {
    it('formats minutes to 12-hour string', () => {
        assert.strictEqual(formatTime(19 * 60), '7:00 PM');
        assert.strictEqual(formatTime(0), '12:00 AM');
        assert.strictEqual(formatTime(12 * 60), '12:00 PM');
        assert.strictEqual(formatTime(7 * 60 + 30), '7:30 AM');
    });
});

// ── comparePlayerAvailability ─────────────────────────────────────────────────

describe('comparePlayerAvailability', () => {
    it('finds overlap between two players with overlapping schedules', () => {
        const avail = {};
        avail['p1'] = {
            discord_id: 'p1', timezone: 'America/New_York',
            weekly: {
                monday: [{ start: '19:00', end: '23:00' }],
                tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
            },
            overrides: {},
        };
        avail['p2'] = {
            discord_id: 'p2', timezone: 'America/New_York',
            weekly: {
                monday: [{ start: '21:00', end: '23:59' }],
                tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
            },
            overrides: {},
        };

        const result = comparePlayerAvailability('p1', 'p2', avail, 7);
        const monday = result.find(r => r.date.getDay() === 1); // Monday
        assert.ok(monday, 'Should have a Monday entry');
        assert.ok(monday.overlaps.length > 0, 'Monday should have overlap (9pm-11pm)');
    });

    it('returns no overlap for non-overlapping schedules', () => {
        const avail = {};
        avail['p1'] = {
            discord_id: 'p1', timezone: 'America/New_York',
            weekly: { monday: [{ start: '08:00', end: '12:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
            overrides: {},
        };
        avail['p2'] = {
            discord_id: 'p2', timezone: 'America/New_York',
            weekly: { monday: [{ start: '18:00', end: '22:00' }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
            overrides: {},
        };

        const result = comparePlayerAvailability('p1', 'p2', avail, 7);
        const monday = result.find(r => r.date.getDay() === 1);
        assert.ok(monday);
        assert.strictEqual(monday.overlaps.length, 0);
    });
});
