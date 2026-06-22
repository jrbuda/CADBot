'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { randomUUID } = require('crypto');
const { parseTime, toUnixTimestamp } = require('../lib/availability_utils.js');

const SESSION_TYPES = [
    { name: 'Tryout',      value: 'tryout'      },
    { name: 'Custom Game', value: 'custom_game' },
    { name: 'Practice',    value: 'practice'    },
];

module.exports = {
    name: 'game',
    description: 'Create and manage game sessions — customs, tryouts, practice, and more.',
    permission: 'EVERYONE',
    no_defer: false,
    subcommands: [
        {
            name: 'create',
            description: 'Create a new game session (captains and admins only)',
            options: [
                {
                    name: 'time',
                    description: 'Start time — 7pm, 7:30pm, or 19:00',
                    type: 'STRING',
                    required: true,
                },
                {
                    name: 'date',
                    description: 'Date — YYYY-MM-DD. Defaults to today in your timezone.',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'name',
                    description: 'Session name — auto-generated if omitted',
                    type: 'STRING',
                    required: false,
                },
                {
                    name: 'type',
                    description: 'Session type',
                    type: 'STRING',
                    required: false,
                    choices: SESSION_TYPES,
                },
                {
                    name: 'spots',
                    description: 'Available spots (default 10)',
                    type: 'INTEGER',
                    required: false,
                    min_value: 1,
                    max_value: 20,
                },
                {
                    name: 'open_to',
                    description: 'Who can express interest',
                    type: 'STRING',
                    required: false,
                    choices: [
                        { name: 'Members + Tryouts', value: 'member_tryout' },
                        { name: 'Team members only', value: 'member'   },
                        { name: 'Tryouts only',      value: 'tryout'   },
                        { name: 'Anyone',            value: 'everyone' },
                    ],
                },
                {
                    name: 'team',
                    description: 'Associate with a team and post to their game channel',
                    type: 'STRING',
                    required: false,
                    autocomplete: true,
                },
            ],
        },
        {
            name: 'list',
            description: 'List all active game sessions',
            options: [],
        },
        {
            name: 'view',
            description: 'View who has signed up for a session',
            options: [
                {
                    name: 'session',
                    description: 'Session to view',
                    type: 'STRING',
                    required: true,
                    autocomplete: true,
                },
            ],
        },
        {
            name: 'close',
            description: 'Close a game session (creator, team captain, or admin)',
            options: [
                {
                    name: 'session',
                    description: 'Session to close',
                    type: 'STRING',
                    required: true,
                    autocomplete: true,
                },
            ],
        },
    ],

    async autocomplete(interaction, extra) {
        const data = extra.data;

        const focused = interaction.options.getFocused(true);
        const query   = focused.value.toLowerCase();

        if (focused.name === 'team') {
            const teams   = data.getTeams();
            const choices = Object.values(teams)
                .filter(t => t.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(t => ({ name: t.name, value: t.id }));
            await interaction.respond(choices);
        } else {
            // session autocomplete (for view/close)
            const sessions = data.getSessions();
            const choices  = Object.values(sessions)
                .filter(s => s.status !== 'closed' && s.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(s => ({ name: `${s.name} (${s.date || '?'})`, value: s.id }));
            await interaction.respond(choices);
        }
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;
        const permissions = extra.permissions;
        const subcommand  = interaction.options.getSubcommand();

        // ── CREATE ───────────────────────────────────────────────────────────
        if (subcommand === 'create') {
            const isCaptain = permissions.check('CAPTAIN', message.member, message.author.id);
            if (!isCaptain) {
                await message.channel.send({ content: 'Only captains and admins can create sessions.' });
                return;
            }

            const name_input = interaction.options.getString('name')?.trim();
            const date_input = interaction.options.getString('date');
            const time_input = interaction.options.getString('time');

            const prefs = data.getCaptainPrefs();
            const myPrefs = prefs[message.author.id] || {};

            const spots      = interaction.options.getInteger('spots')   ?? myPrefs.game_spots    ?? 10;
            const type       = interaction.options.getString('type')     || myPrefs.game_type     || 'practice';
            const open_to    = interaction.options.getString('open_to')  || myPrefs.game_open_to  || 'member_tryout';
            let   team_id    = interaction.options.getString('team')     || null;

            const userAvail  = data.getAvailability()[message.author.id];
            const timezone   = userAvail?.timezone || data.getConfig().timezone || 'America/New_York';

            const timeMins = parseTime(time_input);
            if (timeMins === null) {
                await message.channel.send({
                    content: `❌ **"${time_input}"** is not a valid time.\nUse formats like \`7pm\`, \`7:30pm\`, or \`19:00\`.`,
                });
                return;
            }

            let sessionDate;
            let dateWasProvided = !!date_input;

            if (date_input) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date_input)) {
                    await message.channel.send({ content: 'Invalid date — use `YYYY-MM-DD`, e.g. `2025-07-15`.' });
                    return;
                }
                sessionDate = date_input;
            } else {
                sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
            }

            const [y, mo, dy] = sessionDate.split('-').map(Number);
            let start_unix = toUnixTimestamp(y, mo - 1, dy, timeMins, timezone);

            let autoTomorrow = false;
            if (!dateWasProvided && start_unix < Math.floor(Date.now() / 1000)) {
                const tomorrow = new Date(Date.UTC(y, mo - 1, dy) + 86400000);
                const tY = tomorrow.getUTCFullYear();
                const tM = tomorrow.getUTCMonth();
                const tD = tomorrow.getUTCDate();
                start_unix  = toUnixTimestamp(tY, tM, tD, timeMins, timezone);
                sessionDate = `${tY}-${String(tM + 1).padStart(2, '0')}-${String(tD).padStart(2, '0')}`;
                autoTomorrow = true;
            }

            if (!team_id) {
                const captainTeam = data.getTeamByCaptain(message.author.id);
                if (captainTeam) team_id = captainTeam.id;
            }

            let dest_channel_id = message.channel.id;
            if (team_id) {
                const team = data.getTeam(team_id);
                if (team?.channels?.game) dest_channel_id = team.channels.game;
            }

            const typeLabel  = SESSION_TYPES.find(t => t.value === type)?.name || type;
            const sessions   = data.getSessions();
            const session_id = randomUUID();
            const name       = name_input || `${typeLabel} — ${sessionDate}`;

            sessions[session_id] = {
                id:          session_id,
                type,
                name,
                date:        sessionDate,
                start_unix,
                spots,
                open_to,
                team_id:     team_id || '',
                created_by:  message.author.id,
                created_at:  new Date().toISOString(),
                channel_id:  dest_channel_id,
                message_id:  '',
                status:      'open',
                interested:  [],
            };
            data.saveSessions(sessions);

            const team      = team_id ? data.getTeam(team_id) : null;

            const descParts = [
                `📅 <t:${start_unix}:F>`,
                `🕐 <t:${start_unix}:R>`,
                `🎮 **Type:** ${typeLabel}`,
                `👥 **Spots:** ${spots}`,
                team ? `🛡️ **Team:** ${team.name}` : null,
                `👋 **Open to:** ${open_to === 'member' ? 'Team members' : open_to === 'tryout' ? 'Tryouts' : open_to === 'member_tryout' ? 'Members + Tryouts' : 'Anyone'}`,
                null,
                `Click below if you're in!`,
            ].filter(Boolean).join('\n');

            const embed = new EmbedBuilder()
                .setTitle(`${typeLabel} — ${name}`)
                .setDescription(descParts)
                .setColor(0xED4245)
                .setFooter({ text: `Session ID: ${session_id}` })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`GAME_INTEREST_${session_id}`)
                    .setLabel("I'm In")
                    .setStyle(ButtonStyle.Success),
            );

            const settingsRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`GAME_SETTINGS_${session_id}`)
                    .setLabel('\u2699\uFE0F Settings')
                    .setStyle(ButtonStyle.Secondary),
            );

            let posted;
            try {
                const destCh = dest_channel_id !== message.channel.id
                    ? await message.guild.channels.fetch(dest_channel_id)
                    : null;
                posted = destCh
                    ? await destCh.send({ embeds: [embed], components: [row, settingsRow] })
                    : await message.channel.send({ embeds: [embed], components: [row, settingsRow] });
            } catch (e) {
                this.logger.warn('[game] Could not send session to team channel ' + dest_channel_id + ': ' + e.message);
                posted = await message.channel.send({ embeds: [embed], components: [row, settingsRow] });
            }

            sessions[session_id].message_id = posted.id;
            data.saveSessions(sessions);

            if (isCaptain) {
                prefs[message.author.id] = { game_type: type, game_spots: spots, game_open_to: open_to };
                data.saveCaptainPrefs(prefs);
            }

            const config = data.getConfig();
            if ((open_to === 'tryout' || open_to === 'everyone' || open_to === 'member_tryout')
                && config.tryout_announcements_channel_id) {
                try {
                    const tryoutCh = await message.guild.channels.fetch(config.tryout_announcements_channel_id);
                    if (tryoutCh && tryoutCh.id !== dest_channel_id) {
                        const tryoutEmbed = EmbedBuilder.from(embed);
                        const tryoutRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`GAME_INTEREST_${session_id}`)
                                .setLabel("I'm In")
                                .setStyle(ButtonStyle.Success),
                        );
                        await tryoutCh.send({ embeds: [tryoutEmbed], components: [tryoutRow] });
                    }
                } catch (e) { this.logger.warn('[game] Could not send tryout announcement for session ' + session_id + ': ' + e.message); }
            }

            const routeNote = dest_channel_id !== message.channel.id
                ? ` → posted to <#${dest_channel_id}>`
                : '';
            const tomorrowNote = autoTomorrow
                ? '\n⏰ The time you picked has already passed today, so this session was scheduled for **tomorrow** instead.'
                : '';
            await message.channel.send({
                content: `Session **${name}** created for <t:${start_unix}:F>!${routeNote}${tomorrowNote}`,
            });
            this.logger.info(`[game] Session created: ${name} (${session_id}) at unix ${start_unix}`);
            return;
        }

        // ── LIST ──────────────────────────────────────────────────────────────
        if (subcommand === 'list') {
            const sessions = data.getSessions();
            const open     = Object.values(sessions).filter(s => s.status !== 'closed');

            if (open.length === 0) {
                await message.channel.send({ content: 'No active sessions found.' });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('Active Sessions')
                .setColor(0x5865F2)
                .setTimestamp();

            for (const s of open.slice(0, 10)) {
                const team    = s.team_id ? data.getTeam(s.team_id) : null;
                const timeStr = s.start_unix
                    ? `<t:${s.start_unix}:f>`
                    : `${s.date || '?'}`;
                embed.addFields({
                    name:  s.name,
                    value: `📅 ${timeStr}${team ? ` · ${team.name}` : ''} | 👥 ${s.interested.length}/${s.spots} | ID: \`${s.id.substring(0, 8)}\``,
                });
            }

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── VIEW ──────────────────────────────────────────────────────────────
        if (subcommand === 'view') {
            const session_id = interaction.options.getString('session');
            if (!session_id) {
                await message.channel.send({ content: 'Please select a session from the dropdown.' });
                return;
            }

            const session = data.getSessions()[session_id];
            if (!session) {
                await message.channel.send({ content: 'Session not found.' });
                return;
            }

            if (session.interested.length === 0) {
                await message.channel.send({ content: `No one has signed up for **${session.name}** yet.` });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Sign-ups — ${session.name}`)
                .setDescription(session.interested.map(id => `<@${id}>`).join('\n'))
                .setColor(0x57F287)
                .setFooter({ text: `${session.interested.length} / ${session.spots} spots` });

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── CLOSE ─────────────────────────────────────────────────────────────
        if (subcommand === 'close') {
            const session_id = interaction.options.getString('session');
            if (!session_id) {
                await message.channel.send({ content: 'Please select a session from the dropdown.' });
                return;
            }

            const sessions = data.getSessions();
            const session  = sessions[session_id];
            if (!session) {
                await message.channel.send({ content: 'Session not found.' });
                return;
            }

            const isAdmin   = permissions.check('ADMIN', message.member, message.author.id);
            const myTeam    = data.getTeamByCaptain(message.author.id);
            const canClose  = isAdmin || (myTeam && session.team_id === myTeam.id) || session.created_by === message.author.id;

            if (!canClose) {
                await message.channel.send({ content: 'You can only close sessions you created or that belong to your team.' });
                return;
            }

            sessions[session_id].status = 'closed';
            data.saveSessions(sessions);

            await message.channel.send({ content: `Session **${session.name}** has been closed.` });
            return;
        }
    },
};
