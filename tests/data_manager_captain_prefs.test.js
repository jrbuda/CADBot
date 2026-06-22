'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Use a temp data directory to avoid affecting real data
const TMP_DIR = path.join(__dirname, '..', 'data', '__test_tmp__');
const DataManager = require('../core/js/data_manager.js');

// Fake logger
const fakeLogger = { error: () => {}, info: () => {}, warn: () => {} };

beforeEach(() => {
    if (fs.existsSync(TMP_DIR)) {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
    if (fs.existsSync(TMP_DIR)) {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
});

describe('DataManager captain_prefs', () => {
    it('returns empty object when no prefs file exists', () => {
        const dm = new DataManager(TMP_DIR, fakeLogger);
        const prefs = dm.getCaptainPrefs();
        assert.deepStrictEqual(prefs, {});
    });

    it('saves and loads captain prefs', () => {
        const dm = new DataManager(TMP_DIR, fakeLogger);
        const prefs = { '123': { game_type: 'practice', game_spots: 5, game_open_to: 'member_tryout' } };
        dm.saveCaptainPrefs(prefs);

        // Create a fresh DataManager to test cache + disk read
        const dm2 = new DataManager(TMP_DIR, fakeLogger);
        const loaded = dm2.getCaptainPrefs();
        assert.deepStrictEqual(loaded, prefs);
    });

    it('preserves existing keys when adding a new captain', () => {
        const dm = new DataManager(TMP_DIR, fakeLogger);
        dm.saveCaptainPrefs({ 'one': { game_type: 'practice', game_spots: 5, game_open_to: 'member_tryout' } });

        const prefs = dm.getCaptainPrefs();
        prefs['two'] = { game_type: 'custom_game', game_spots: 10, game_open_to: 'everyone' };
        dm.saveCaptainPrefs(prefs);

        const loaded = dm.getCaptainPrefs();
        assert.ok(loaded.one);
        assert.ok(loaded.two);
        assert.strictEqual(loaded.one.game_spots, 5);
        assert.strictEqual(loaded.two.game_spots, 10);
    });

    it('getCaptainPrefs caches correctly', () => {
        const dm = new DataManager(TMP_DIR, fakeLogger);
        dm.saveCaptainPrefs({ 'abc': { game_type: 'tryout', game_spots: 8, game_open_to: 'member' } });

        // Read (caches internally)
        const first = dm.getCaptainPrefs();
        // Manually invalidate and read again
        dm.invalidate('captain_prefs');
        const second = dm.getCaptainPrefs();
        assert.deepStrictEqual(first, second);
    });
});
