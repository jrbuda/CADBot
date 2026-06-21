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
    num_args: 0,
    options: [
        {
            name: 'action',
            description: 'What to do',
            type: 'STRING',
            required: true,
            choices: [
                { name: 'Create session',  value: 'create' },
                { name: 'List sessions',   value: 'list'   },
                { name: 'View interested', value: 'view'   },
                { name: 'Close session',   value: 'close'  },
            ],
        },
        {
            name: 'name',
            description: '(create) Session name — auto-generated if omitted',
            type: 'STRING',
            required: false,
        },
        {
            name: 'date',
            description: '(create) Date — YYYY-MM-DD. Defaults to today in your timezone.',
            type: 'STRING',
            required: false,
        },
        {
            name: 'time',
            description: '(create) Start time — 7pm, 7:30pm, or 19:00',
            type: 'STRING',
            required: false,
        },
        {
            name: 'type',
            description: '(create) Session type',
            type: 'STRING',
            required: false,
            choices: SESSION_TYPES,
        },
        {
            name: 'spots',
            description: '(create) Available spots (default 10)',
            type: 'INTEGER',
            required: false,
            min_value: 1,
            max_value: 20,
        },
        {
            name: 'open_to',
            description: '(create) Who can express interest',
            type: 'STRING',
            required: false,
            choices: [
                { name: 'Team members only', value: 'member'   },
                { name: 'Tryouts only',      value: 'tryout'   },
                { name: 'Anyone',            value: 'everyone' },
            ],
        },
        {
            name: 'team',
            description: '(create) Associate with a team and post to their game channel',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
        {
            name: 'session',
            description: '(view/close) Session to manage',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

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
            // session autocomplete
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

        const action = interaction.options.getString('action');

        // ── CREATE ───────────────────────────────────────────────────────────
        if (action === 'create') {
            // Captains can create for their own team; admins can create for any team
            const isCaptain = permissions.check('CAPTAIN', message.member, message.author.id);
            if (!isCaptain) {
                await message.channel.send({ content: 'Only captains and admins can create sessions.' });
                return;
            }

            const name_input = interaction.options.getString('name')?.trim();
            const date_input = interaction.options.getString('date');
            const time_input = interaction.options.getString('time');
            const spots      = interaction.options.getInteger('spots')   ?? 10;
            const type       = interaction.options.getString('type')     || 'custom_game';
            const open_to    = interaction.options.getString('open_to')  || 'member';
            let   team_id    = interaction.options.getString('team')     || null;

            // ── Resolve user timezone ─────────────────────────────────────────
            const userAvail  = data.getAvailability()[message.author.id];
            const timezone   = userAvail?.timezone || data.getConfig().timezone || 'America/New_York';

            // ── Validate and parse time ───────────────────────────────────────
            if (!time_input) {
                await message.channel.send({
                    content: '❌ A start time is required. Use `time:8pm`, `time:7:30pm`, or `time:19:00`.',
                });
                return;
            }
            const timeMins = parseTime(time_input);
            if (timeMins === null) {
                await message.channel.send({
                    content: `❌ **"${time_input}"** is not a valid time.\nUse formats like \`7pm\`, \`7:30pm\`, or \`19:00\`.`,
                });
                return;
            }

            // ── Resolve date ──────────────────────────────────────────────────
            let sessionDate;
            let dateWasProvided = !!date_input;

            if (date_input) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date_input)) {
                    await message.channel.send({ content: 'Invalid date — use `YYYY-MM-DD`, e.g. `2025-07-15`.' });
                    return;
                }
                sessionDate = date_input;
            } else {
                // Default to today in the user's timezone
                sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
            }

            // ── Build Unix timestamp ──────────────────────────────────────────
            const [y, m, d] = sessionDate.split('-').map(Number);
            const dateObj   = new Date(y, m - 1, d);   // local midnight (league TZ)
            let   start_unix = toUnixTimestamp(dateObj, timeMins, timezone);

            // If time has already passed today, automatically schedule for tomorrow
            if (!dateWasProvided && start_unix < Math.floor(Date.now() / 1000)) {
                dateObj.setDate(dateObj.getDate() + 1);
                start_unix  = toUnixTimestamp(dateObj, timeMins, timezone);
                sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(dateObj);
            }

            // ── Auto-resolve captain's team ───────────────────────────────────
            if (!team_id) {
                const captainTeam = data.getTeamByCaptain(message.author.id);
                if (captainTeam) team_id = captainTeam.id;
            }

            // ── Resolve destination channel ───────────────────────────────────
            let dest_channel_id = message.channel.id;
            if (team_id) {
                const team = data.getTeam(team_id);
                if (team?.channels?.game) dest_channel_id = team.channels.game;
            }

            // ── Persist session ───────────────────────────────────────────────
            const sessions   = data.getSessions();
            const session_id = randomUUID();
            const name       = name_input || `Gaming Session #${Object.keys(sessions).length + 1}`;

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

            // ── Build embed ───────────────────────────────────────────────────
            const typeLabel = SESSION_TYPES.find(t => t.value === type)?.name || type;
            const team      = team_id ? data.getTeam(team_id) : null;

            const embed = new EmbedBuilder()
                .setTitle(`${typeLabel} — ${name}`)
                .setDescription(
                    `📅 <t:${start_unix}:F>\n` +
                    `🕐 <t:${start_unix}:R>\n` +
                    `🎮 **Type:** ${typeLabel}\n` +
                    `👥 **Spots:** ${spots}\n` +
                    (team ? `🛡️ **Team:** ${team.name}\n` : '') +
                    `👋 **Open to:** ${open_to === 'member' ? 'Team members' : open_to === 'tryout' ? 'Tryouts' : 'Anyone'}\n\n` +
                    `Click below if you're in!`
                )
                .setColor(0xED4245)
                .setFooter({ text: `Session ID: ${session_id}` })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`GAME_INTEREST_${session_id}`)
                    .setLabel("I'm In")
                    .setStyle(ButtonStyle.Success),
            );

            // ── Post ──────────────────────────────────────────────────────────
            let posted;
            try {
                const destCh = dest_channel_id !== message.channel.id
                    ? await message.guild.channels.fetch(dest_channel_id)
                    : null;
                posted = destCh
                    ? await destCh.send({ embeds: [embed], components: [row] })
                    : await message.channel.send({ embeds: [embed], components: [row] });
            } catch (_) {
                posted = await message.channel.send({ embeds: [embed], components: [row] });
            }

            sessions[session_id].message_id = posted.id;
            data.saveSessions(sessions);

            const routeNote = dest_channel_id !== message.channel.id
                ? ` → posted to <#${dest_channel_id}>`
                : '';
            await message.channel.send({
                content: `Session **${name}** created for <t:${start_unix}:F>!${routeNote}`,
            });
            this.logger.info(`[game] Session created: ${name} (${session_id}) at unix ${start_unix}`);
            return;
        }

        // ── LIST ──────────────────────────────────────────────────────────────
        if (action === 'list') {
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

        // ── VIEW INTERESTED ───────────────────────────────────────────────────
        if (action === 'view') {
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
        if (action === 'close') {
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

            // Captains can close sessions for their own team; admins can close anything
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
