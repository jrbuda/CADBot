'use strict';
require('dotenv/config');

const fs = require('fs');

// ── Timezone ─────────────────────────────────────────────────────────────────
// Force the process timezone to the league's configured timezone BEFORE any
// Date objects are created. This keeps day-of-week / calendar-date matching in
// the availability engine consistent with how times are interpreted, regardless
// of the host server's own timezone.
let _leagueTz = 'America/New_York';
try {
    const _cfg = JSON.parse(fs.readFileSync(__dirname + '/data/config.json', 'utf8'));
    if (_cfg && _cfg.timezone) _leagueTz = _cfg.timezone;
} catch (_) { /* fall back to default */ }
process.env.TZ = _leagueTz;

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const LogHandler      = require('./core/js/log_handler.js');
const DataManager     = require('./core/js/data_manager.js');
const PermissionHandler = require('./core/js/permission_handler.js');
const ModuleHandler   = require('./core/js/module_handler.js');
const EventRegistry   = require('./core/js/event_registry.js');

// ── Config ───────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync('cadbot.json'));

// ── Logger ───────────────────────────────────────────────────────────────────
const logger = LogHandler.build_logger(__dirname + '/' + config.log_folder);

// ── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildScheduledEvents,
    ],
});

// ── Core systems ─────────────────────────────────────────────────────────────
const data        = new DataManager(__dirname + '/' + config.data_folder, logger);
const permissions = new PermissionHandler(data);
const modules     = new ModuleHandler(__dirname, data, permissions, logger);

modules.discover_modules(__dirname + '/' + config.modules_folder);
modules.discover_commands();

const event_registry = new EventRegistry(client, logger);
event_registry.discover_event_handlers(modules);

logger.info('Event registration complete.');

// ── Interaction routing ───────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        try {
            await modules.handle_autocomplete(interaction);
        } catch (err) {
            logger.error('[interactionCreate] Autocomplete error: ' + err.message);
        }
        return;
    }

    // Slash commands — all other interaction types (buttons, modals, selects)
    // are handled by each module's events.js file via the EventRegistry.
    if (!interaction.isChatInputCommand()) return;

    try {
        await modules.handle_slash_command(interaction);
    } catch (err) {
        logger.error('[interactionCreate] Unhandled error: ' + err.message);
    }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.on('clientReady', async () => {
    logger.info('Logged in as ' + client.user.tag);

    // Register slash commands with Discord
    try {
        await modules.register_slash_commands(client);
    } catch (err) {
        logger.error('[Startup] Slash command registration failed: ' + err.message);
    }

    // Set bot activity
    try {
        client.user.setActivity(config.bot_activity.name, { type: ActivityType.Playing });
    } catch (_) {}

    // Startup message
    const startupChannelId = process.env.STARTUP_CHANNEL_ID || config.startup_channel_id;
    if (startupChannelId) {
        try {
            const channel = await client.channels.fetch(startupChannelId);
            if (channel) {
                const isUpdate = fs.existsSync(__dirname + '/updated.txt');
                await channel.send({ content: isUpdate ? config.startup_messages.update : config.startup_messages.start });
                if (isUpdate) fs.unlinkSync(__dirname + '/updated.txt');
            }
        } catch (err) {
            logger.warn('[Startup] Could not send startup message: ' + err.message);
        }
    }

    logger.info('CADBot is ready!');
});

// ── Login ─────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
if (!token) {
    logger.error('DISCORD_TOKEN is not set in .env — exiting.');
    process.exit(1);
}
client.login(token);
