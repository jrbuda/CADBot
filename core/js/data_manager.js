'use strict';
const fs   = require('fs');
const path = require('path');

/**
 * Manages all local JSON data files for CADBot.
 *
 * Files are read from and written to the configured data folder.
 * An in-memory cache avoids redundant disk reads; call invalidate(filename)
 * after an external write if needed.
 *
 * Managed files:
 *   config.json      — bot configuration (role IDs, channel IDs, timezone, etc.)
 *   players.json     — linked player accounts keyed by Discord user ID
 *   teams.json       — team records keyed by team UUID
 *   availability.json — player weekly schedules + date overrides
 *   scrims.json      — scrim records keyed by scrim UUID
 *   sessions.json    — tryout / custom game sessions keyed by session UUID
 *   captain_prefs.json — per-captain defaults for game session creation
 */
class DataManager {
    /**
     * @param {string} data_path - Absolute path to the data directory
     * @param {import('winston').Logger} logger
     */
    constructor(data_path, logger) {
        this.data_path = data_path;
        this.logger    = logger;
        this._cache    = {};

        // Ensure the data directory exists
        if (!fs.existsSync(data_path)) {
            fs.mkdirSync(data_path, { recursive: true });
        }
    }

    // ── Generic read / write ──────────────────────────────────────────────────

    /**
     * Reads a JSON file from the data folder, returning the parsed object.
     * Returns {} if the file does not exist. Uses in-memory cache.
     * @param {string} filename - Without the .json extension
     * @returns {Object}
     */
    read(filename) {
        if (this._cache[filename] !== undefined) return this._cache[filename];

        const filepath = path.join(this.data_path, filename + '.json');
        if (fs.existsSync(filepath)) {
            try {
                this._cache[filename] = JSON.parse(fs.readFileSync(filepath, 'utf8'));
            } catch (err) {
                this.logger.error('[DataManager] Failed to parse ' + filename + '.json: ' + err.message);
                this._cache[filename] = {};
            }
        } else {
            this._cache[filename] = {};
        }

        return this._cache[filename];
    }

    /**
     * Writes data to a JSON file in the data folder and updates the cache.
     * Uses a temp-file + rename for atomicity so a crash mid-write won't
     * corrupt the file.
     * @param {string} filename - Without the .json extension
     * @param {Object} data
     */
    write(filename, data) {
        const filepath = path.join(this.data_path, filename + '.json');
        const tmppath  = filepath + '.tmp';
        try {
            fs.writeFileSync(tmppath, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmppath, filepath);
            this._cache[filename] = data;
        } catch (err) {
            this.logger.error('[DataManager] Failed to write ' + filename + '.json: ' + err.message);
            try { fs.unlinkSync(tmppath); } catch (_) {}
            throw err;
        }
    }

    /**
     * Evicts a file from the cache so the next read() loads fresh data.
     * @param {string} filename
     */
    invalidate(filename) {
        delete this._cache[filename];
    }

    invalidate_all() {
        this._cache = {};
    }

    // ── Named accessors ───────────────────────────────────────────────────────

    getConfig()       { return this.read('config'); }
    getPlayers()      { return this.read('players'); }
    getTeams()        { return this.read('teams'); }
    getAvailability() { return this.read('availability'); }
    getScrims()       { return this.read('scrims'); }
    getSessions()     { return this.read('sessions'); }
    getCaptainPrefs() { return this.read('captain_prefs'); }

    saveConfig(data)       { this.write('config', data); }
    savePlayers(data)      { this.write('players', data); }
    saveTeams(data)        { this.write('teams', data); }
    saveAvailability(data) { this.write('availability', data); }
    saveScrims(data)       { this.write('scrims', data); }
    saveSessions(data)     { this.write('sessions', data); }
    saveCaptainPrefs(data) { this.write('captain_prefs', data); }

    // ── Convenience helpers ───────────────────────────────────────────────────

    /**
     * Returns the player record for a Discord user ID, or null.
     * @param {string} discord_id
     */
    getPlayer(discord_id) {
        return this.getPlayers()[discord_id] || null;
    }

    /**
     * Returns the team record for a team UUID, or null.
     * @param {string} team_id
     */
    getTeam(team_id) {
        return this.getTeams()[team_id] || null;
    }

    /**
     * Returns the team record where captain_id matches, or null.
     * @param {string} discord_id
     */
    getTeamByCaptain(discord_id) {
        const teams = this.getTeams();
        return Object.values(teams).find(t => t.captain_id === discord_id) || null;
    }

    /**
     * Returns an array of player records for all members of a given team.
     * @param {string} team_id
     */
    getTeamPlayers(team_id) {
        const players = this.getPlayers();
        return Object.values(players).filter(p => p.team_id === team_id);
    }

    /**
     * Returns the scrim record for a scrim UUID, or null.
     * @param {string} scrim_id
     */
    getScrim(scrim_id) {
        return this.getScrims()[scrim_id] || null;
    }
}

module.exports = DataManager;
