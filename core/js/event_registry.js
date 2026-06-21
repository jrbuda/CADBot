'use strict';

/**
 * Discovers and registers per-module event handlers.
 *
 * Each module's bot_module.json may define an "event_handler" string pointing
 * to a JS file relative to the module's folder. That file must export a single
 * function that accepts an EventRegistry instance and calls register() for each
 * Discord client event it wants to handle.
 */
class EventRegistry {
    /**
     * @param {import('discord.js').Client} client
     * @param {import('winston').Logger} logger
     */
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
    }

    /**
     * Iterates all enabled modules and registers any declared event handlers.
     * @param {import('./module_handler.js')} mod_handler
     */
    discover_event_handlers(mod_handler) {
        // Expose the shared core singletons so module event handlers reuse the
        // same DataManager/PermissionHandler instances the command handlers use.
        // This is critical: two separate DataManager instances would each keep
        // their own in-memory cache and could serve stale data after a write.
        this.data_manager = mod_handler.data;
        this.permissions  = mod_handler.permissions;

        for (const [name, mod] of mod_handler.modules) {
            if (mod.config.event_handler) {
                this.logger.info('Registering event handlers for module: ' + name);
                const handler_init = require(mod.location + mod.config.event_handler);
                handler_init(this);
            }
        }
    }

    /**
     * Registers a handler function for the given Discord client event.
     * @param {string} eventName
     * @param {Function} handler
     */
    register(eventName, handler) {
        this.client.on(eventName, handler);
    }
}

module.exports = EventRegistry;
