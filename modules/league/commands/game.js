'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const { randomUUID } = require('crypto');

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
            description: '(create) Date — YYYY-MM-DD',
            type: 'STRING',
            required: false,
        },
        {
            name: 'time',
            description: '(create) Start time — 7pm or 19:00',
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
                .map(s => ({ name: `${s.name} (${s.date})`, value: s.id }));
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
            const date       = interaction.options.getString('date');
            const time       = interaction.options.getString('time');
            const spots      = interaction.options.getInteger('spots')   ?? 10;
            const type       = interaction.options.getString('type')     || 'custom_game';
            const open_to    = interaction.options.getString('open_to')  || 'member';
            let   team_id    = interaction.options.getString('team')     || null;

            if (!date || !time) {
                await message.channel.send({ content: 'Please provide a `date` (YYYY-MM-DD) and `time`.' });
                return;
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                await message.channel.send({ content: 'Invalid date — use `YYYY-MM-DD`, e.g. `2025-07-15`.' });
                return;
            }

            // Captains: auto-resolve their team if not specified
            if (!team_id && permissions.check('CAPTAIN', message.member, message.author.id)) {
                const captainTeam = data.getTeamByCaptain(message.author.id);
                if (captainTeam) team_id = captainTeam.id;
            }

            const sessions   = data.getSessions();
            const session_id = randomUUID();
            const name       = name_input || `Gaming Session #${Object.keys(sessions).length + 1}`;

            // Resolve the destination channel:
            // use the team's configured game channel, fall back to current channel
            let dest_channel_id = message.channel.id;
            if (team_id) {
                const team = data.getTeam(team_id);
                if (team?.channels?.game) dest_channel_id = team.channels.game;
            }

            sessions[session_id] = {
                id:          session_id,
                type,
                name,
                date,
                time,
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

            const typeLabel = SESSION_TYPES.find(t => t.value === type)?.name || type;
            const team      = team_id ? data.getTeam(team_id) : null;

            const embed = new EmbedBuilder()
                .setTitle(`${typeLabel} — ${name}`)
                .setDescription(
                    `📅 **Date:** ${date}\n⏰ **Time:** ${time}\n` +
                    `🎮 **Type:** ${typeLabel}\n👥 **Spots:** ${spots}\n` +
                    (team ? `👥 **Team:** ${team.name}\n` : '') +
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

            // Post to team game channel (or current channel)
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
            await message.channel.send({ content: `Session **${name}** created!${routeNote}` });
            this.logger.info(`[game] Session created: ${name} (${session_id})`);
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
                const team = s.team_id ? data.getTeam(s.team_id) : null;
                embed.addFields({
                    name:  s.name,
                    value: `📅 ${s.date} ${s.time}${team ? ` · ${team.name}` : ''} | 👥 ${s.interested.length}/${s.spots} | ID: \`${s.id.substring(0, 8)}\``,
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
