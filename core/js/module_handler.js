'use strict';
const fs = require('fs');
const { Collection, MessageFlags, REST, Routes, SlashCommandBuilder } = require('discord.js');

/**
 * Core engine for CADBot. Discovers modules and commands, checks permissions,
 * registers slash commands with the Discord API, and routes incoming interactions
 * to the correct command handler.
 *
 * Differences from ModBot's ModuleHandler:
 *  - No external API dependency (DataManager is used instead)
 *  - Permission tiers are checked here via PermissionHandler before execution
 *  - Single-server design (GUILD_ID from .env)
 *  - No StateManager
 *  - `extra` always receives { data, permissions, interaction }
 *  - Core modules additionally receive extra.module_handler
 */
class ModuleHandler {
    /**
     * @param {string} program_path
     * @param {import('./data_manager.js')} data_manager
     * @param {import('./permission_handler.js')} permission_handler
     * @param {import('winston').Logger} logger
     */
    constructor(program_path, data_manager, permission_handler, logger) {
        this.program_path = program_path;
        this.data         = data_manager;
        this.permissions  = permission_handler;
        this.logger       = logger;
        this.modules      = null;
        this.disabled_modules = null;
    }

    // ── Module / command discovery ────────────────────────────────────────────

    discover_modules(modules_folder) {
        this.modules          = new Collection();
        this.disabled_modules = new Collection();

        this.logger.info('[Modules] Discovering in: ' + modules_folder);
        const entries = fs.readdirSync(modules_folder, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const config_path = modules_folder + '/' + entry.name + '/bot_module.json';
            if (!fs.existsSync(config_path)) continue;

            const config     = JSON.parse(fs.readFileSync(config_path));
            const the_module = { config, location: modules_folder + '/' + entry.name + '/' };

            if (config.enabled) {
                this.modules.set(config.name, the_module);
            } else {
                this.disabled_modules.set(config.name, the_module);
            }
        }
    }

    discover_commands() {
        for (const [, current_module] of this.modules) {
            current_module.commands = new Collection();
            const cmd_dir = current_module.location + current_module.config.commands_directory + '/';

            this.logger.info('[Commands] Discovering in: ' + cmd_dir);
            const files = fs.readdirSync(cmd_dir).filter(f => f.endsWith('.js'));

            for (const file of files) {
                const command    = require(cmd_dir + file);
                command.logger   = this.logger;
                current_module.commands.set(command.name, command);
            }
        }

        this.logger.info('[Modules] Active modules:');
        for (const [, mod] of this.modules) {
            this.logger.info('  + ' + mod.config.display_name + ' (' + mod.commands.size + ' commands)');
        }
        if (this.disabled_modules.size > 0) {
            for (const [, mod] of this.disabled_modules) {
                this.logger.info('  - ' + mod.config.display_name + ' (disabled)');
            }
        }
    }

    /**
     * Clears the require cache for all command files and re-runs discover_commands.
     * Used by the /reload command.
     */
    reload_commands() {
        for (const [, mod] of this.modules) {
            const dir   = mod.location + mod.config.commands_directory + '/';
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
            for (const file of files) {
                delete require.cache[require.resolve(dir + file)];
            }
        }
        this.discover_commands();
        this.logger.info('[Modules] Commands reloaded.');
    }

    // ── Slash command registration ────────────────────────────────────────────

    async register_slash_commands(client) {
        const token   = process.env.DISCORD_TOKEN;
        const guildId = process.env.GUILD_ID;

        const payload         = [];
        const registeredNames = new Map();

        for (const [module_name, mod] of this.modules) {
            for (const [, command] of mod.commands) {
                if (command.no_slash) continue;

                let slashName = command.name.toLowerCase()
                    .replace(/[^a-z0-9_-]/g, '_')
                    .substring(0, 32);

                // Resolve naming conflicts by prepending the module name
                if (registeredNames.has(slashName)) {
                    const conflict = registeredNames.get(slashName);
                    if (conflict.module_name !== module_name) {
                        if (!conflict.renamed) {
                            const orig       = this.modules.get(conflict.module_name).commands.get(conflict.command_name);
                            const origPrefixed = (conflict.module_name + '_' + orig._resolved_slash_name).substring(0, 32);
                            orig._resolved_slash_name = origPrefixed;
                            const idx = payload.findIndex(c => c.name === slashName);
                            if (idx !== -1) payload[idx].name = origPrefixed;
                            conflict.renamed = true;
                            registeredNames.set(origPrefixed, conflict);
                        }
                        slashName = (module_name + '_' + slashName).substring(0, 32);
                    }
                }

                command._resolved_slash_name = slashName;
                registeredNames.set(slashName, { module_name, command_name: command.name });

                const desc    = (command.description || 'No description').substring(0, 100);
                const builder = new SlashCommandBuilder().setName(slashName).setDescription(desc);

                if (command.options?.length > 0) {
                    const sorted = command.options.slice().sort((a, b) => (b.required === true) - (a.required === true));
                    for (const opt of sorted) {
                        try { this._add_slash_option(builder, opt); } catch (e) {
                            this.logger.error('[Slash] Option error on ' + slashName + ': ' + e.message);
                        }
                    }
                }

                payload.push(builder.toJSON());
                this.logger.info('[Slash] Queued: /' + slashName);
            }
        }

        const rest = new REST({ version: '10' }).setToken(token);

        if (guildId) {
            try {
                await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: payload });
                this.logger.info('[Slash] Registered ' + payload.length + ' commands to guild ' + guildId);
            } catch (err) {
                this.logger.error('[Slash] Guild registration failed: ' + err.message);
            }
        } else {
            try {
                await rest.put(Routes.applicationCommands(client.user.id), { body: payload });
                this.logger.info('[Slash] Registered ' + payload.length + ' commands globally');
            } catch (err) {
                this.logger.error('[Slash] Global registration failed: ' + err.message);
            }
        }
    }

    _add_slash_option(builder, opt) {
        const name     = opt.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 32);
        const desc     = ((opt.description || opt.name) + '').substring(0, 100);
        const required = opt.required === true;

        const applyCommon = (b) => {
            b.setName(name).setDescription(desc).setRequired(required);
            if (Number.isFinite(opt.min_value) && b.setMinValue) b.setMinValue(opt.min_value);
            if (Number.isFinite(opt.max_value) && b.setMaxValue) b.setMaxValue(opt.max_value);
            return b;
        };

        switch ((opt.type || 'STRING').toUpperCase()) {
            case 'STRING':
                builder.addStringOption(o => {
                    applyCommon(o);
                    if (opt.choices?.length > 0) {
                        o.addChoices(...opt.choices.map(c => typeof c === 'object' ? c : { name: String(c), value: String(c) }));
                    } else if (opt.autocomplete) {
                        o.setAutocomplete(true);
                    }
                    return o;
                });
                break;
            case 'INTEGER':     builder.addIntegerOption(o => applyCommon(o));     break;
            case 'NUMBER':      builder.addNumberOption(o => applyCommon(o));      break;
            case 'BOOLEAN':     builder.addBooleanOption(o => applyCommon(o));     break;
            case 'USER':        builder.addUserOption(o => applyCommon(o));        break;
            case 'CHANNEL':     builder.addChannelOption(o => applyCommon(o));     break;
            case 'ROLE':        builder.addRoleOption(o => applyCommon(o));        break;
            case 'MENTIONABLE': builder.addMentionableOption(o => applyCommon(o)); break;
            case 'ATTACHMENT':  builder.addAttachmentOption(o => applyCommon(o));  break;
            default:            builder.addStringOption(o => applyCommon(o));
        }
    }

    // ── Interaction handling ──────────────────────────────────────────────────

    async handle_slash_command(interaction) {
        const InteractionAdapter = require('./interaction_adapter.js');
        const slashName          = interaction.commandName;

        this.logger.info('[Slash] /' + slashName + ' from ' + interaction.user.id);

        // Find the command
        let current_module  = null;
        let current_command = null;

        outer: for (const [, mod] of this.modules) {
            for (const [, cmd] of mod.commands) {
                if (cmd._resolved_slash_name === slashName) {
                    current_module  = mod;
                    current_command = cmd;
                    break outer;
                }
            }
        }

        if (!current_command) {
            this.logger.warn('[Slash] No command found for: ' + slashName);
            await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
            return;
        }

        // Permission check
        const required = current_command.permission || 'EVERYONE';
        if (!this.permissions.check(required, interaction.member, interaction.user.id)) {
            await interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
            return;
        }

        // Defer reply unless the command handles its own response (e.g., modal-first commands)
        if (!current_command.no_defer) {
            try {
                const defer_opts = current_command.ephemeral ? { flags: MessageFlags.Ephemeral } : {};
                await interaction.deferReply(defer_opts);
            } catch (err) {
                this.logger.error('[Slash] deferReply failed for /' + slashName + ': ' + err.message);
            }
        }

        // Build positional args array (command name at [0], then each option in declaration order)
        const args      = [current_command.name];
        let firstUser   = null;
        let firstMember = null;

        if (current_command.options?.length > 0) {
            for (const opt of current_command.options) {
                const optName = opt.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 32);
                const type    = (opt.type || 'STRING').toUpperCase();

                switch (type) {
                    case 'USER': {
                        const u = interaction.options.getUser(optName);
                        const m = interaction.options.getMember(optName);
                        if (!firstUser && u) { firstUser = u; firstMember = m; }
                        args.push(u ? '<@' + u.id + '>' : null);
                        break;
                    }
                    case 'INTEGER': {
                        const v = interaction.options.getInteger(optName);
                        args.push(v !== null && v !== undefined ? String(v) : null);
                        break;
                    }
                    case 'NUMBER': {
                        const v = interaction.options.getNumber(optName);
                        args.push(v !== null && v !== undefined ? String(v) : null);
                        break;
                    }
                    case 'BOOLEAN': {
                        const v = interaction.options.getBoolean(optName);
                        args.push(v !== null && v !== undefined ? String(v) : null);
                        break;
                    }
                    case 'CHANNEL': {
                        const v = interaction.options.getChannel(optName);
                        args.push(v ? v.id : null);
                        break;
                    }
                    case 'ROLE': {
                        const v = interaction.options.getRole(optName);
                        args.push(v ? v.id : null);
                        break;
                    }
                    default: {
                        const v = interaction.options.getString(optName);
                        args.push(v);
                    }
                }
            }
        }

        const adapter = new InteractionAdapter(interaction, firstUser, firstMember, this.logger);
        const extra   = {
            data:        this.data,
            permissions: this.permissions,
            interaction: interaction,   // Raw interaction for modals, ephemeral replies, etc.
        };
        if (current_module.config.is_core) extra.module_handler = this;

        try {
            await current_command.execute(adapter, args, extra);
        } catch (err) {
            this.logger.error('[Slash] Error in /' + slashName + ': ' + err.message + '\n' + err.stack);
            try {
                const errPayload = { content: 'An internal error occurred.', flags: MessageFlags.Ephemeral };
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp(errPayload);
                } else {
                    await interaction.reply(errPayload);
                }
            } catch (_) {}
        }
    }

    async handle_autocomplete(interaction) {
        const slashName = interaction.commandName;
        for (const [, mod] of this.modules) {
            for (const [, cmd] of mod.commands) {
                if (cmd._resolved_slash_name === slashName && typeof cmd.autocomplete === 'function') {
                    try { await cmd.autocomplete(interaction); } catch (err) {
                        this.logger.error('[Autocomplete] Error: ' + err.message);
                    }
                    return;
                }
            }
        }
    }
}

module.exports = ModuleHandler;
