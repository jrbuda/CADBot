'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { randomUUID } = require('crypto');

const SESSION_TYPES = [
    { name: 'Tryout',     value: 'tryout'      },
    { name: 'Custom Game', value: 'custom_game' },
    { name: 'Practice',   value: 'practice'    },
];

module.exports = {
    name: 'tryout',
    description: 'Manage tryout and custom game sessions.',
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
                { name: 'Create session',    value: 'create' },
                { name: 'List sessions',     value: 'list'   },
                { name: 'View interested',   value: 'view'   },
                { name: 'Close session',     value: 'close'  },
            ],
        },
        {
            name: 'name',
            description: '(create) Session name',
            type: 'STRING',
            required: false,
        },
        {
            name: 'date',
            description: '(create) Date — format: YYYY-MM-DD',
            type: 'STRING',
            required: false,
        },
        {
            name: 'time',
            description: '(create) Start time — format: HH:MM (24h) or H:MMpm',
            type: 'STRING',
            required: false,
        },
        {
            name: 'spots',
            description: '(create) Number of available spots',
            type: 'INTEGER',
            required: false,
            min_value: 1,
            max_value: 20,
        },
        {
            name: 'type',
            description: '(create) Session type',
            type: 'STRING',
            required: false,
            choices: SESSION_TYPES,
        },
        {
            name: 'session',
            description: '(view/close) Session ID',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
        {
            name: 'open_to',
            description: '(create) Who can express interest',
            type: 'STRING',
            required: false,
            choices: [
                { name: 'Tryouts only',        value: 'tryout'   },
                { name: 'All team members',    value: 'member'   },
                { name: 'Anyone',              value: 'everyone' },
            ],
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

        const focused   = interaction.options.getFocused().toLowerCase();
        const sessions  = data.getSessions();
        const choices = Object.values(sessions)
            .filter(s => s.status !== 'closed' && s.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(s => ({ name: `${s.name} (${s.date})`, value: s.id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;
        const permissions = extra.permissions;

        const action = interaction.options.getString('action');

        // ── CREATE ───────────────────────────────────────────────────────────
        if (action === 'create') {
            if (!permissions.check('ADMIN', message.member, message.author.id)) {
                await message.channel.send({ content: 'Only admins can create sessions.' });
                return;
            }

            const name_input = interaction.options.getString('name')?.trim();
            const date    = interaction.options.getString('date');
            const time    = interaction.options.getString('time');
            const spots   = interaction.options.getInteger('spots') ?? 10;
            const type    = interaction.options.getString('type')   || 'tryout';
            const open_to = interaction.options.getString('open_to') || 'tryout';

            if (!date || !time) {
                await message.channel.send({ content: 'Please provide a `date` (YYYY-MM-DD) and `time` when creating a session.' });
                return;
            }

            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                await message.channel.send({ content: 'Invalid date format — use `YYYY-MM-DD`, e.g. `2025-07-15`.' });
                return;
            }

            // Auto-generate a name if none was provided
            const sessions   = data.getSessions();
            const session_id = randomUUID();
            const name = name_input || `Gaming Session #${Object.keys(sessions).length + 1}`;
            sessions[session_id] = {
                id:         session_id,
                type,
                name,
                date,
                time,
                spots,
                open_to,
                created_by: message.author.id,
                created_at: new Date().toISOString(),
                channel_id: message.channel.id,
                message_id: '',
                status:     'open',
                interested: [],
            };
            data.saveSessions(sessions);

            const typeLabel = SESSION_TYPES.find(t => t.value === type)?.name || type;

            const embed = new EmbedBuilder()
                .setTitle(`${typeLabel} — ${name}`)
                .setDescription(
                    `📅 **Date:** ${date}\n⏰ **Time:** ${time}\n` +
                    `🎮 **Type:** ${typeLabel}\n👥 **Spots:** ${spots}\n` +
                    `👋 **Open to:** ${open_to.charAt(0).toUpperCase() + open_to.slice(1)}\n\n` +
                    `React below if you're interested!`
                )
                .setColor(0xED4245)
                .setFooter({ text: `Session ID: ${session_id}` })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`TRYOUT_INTEREST_${session_id}`)
                    .setLabel("I'm Interested")
                    .setStyle(ButtonStyle.Success),
            );

            const posted = await message.guild.channels.fetch(message.channel.id)
                .then(ch => ch.send({ embeds: [embed], components: [row] }))
                .catch(() => message.channel.send({ embeds: [embed], components: [row] }));

            // Store the message_id for later reference
            sessions[session_id].message_id = posted.id;
            data.saveSessions(sessions);

            await message.channel.send({ content: `Session **${name}** created! ID: \`${session_id}\`` });
            this.logger.info(`[tryout] Session created: ${name} (${session_id})`);
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
                embed.addFields({
                    name:  s.name,
                    value: `📅 ${s.date} ${s.time} | 👥 ${s.interested.length}/${s.spots} interested | ID: \`${s.id.substring(0, 8)}\``,
                });
            }

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── VIEW INTERESTED ───────────────────────────────────────────────────
        if (action === 'view') {
            const session_id = interaction.options.getString('session');
            if (!session_id) {
                await message.channel.send({ content: 'Please provide a `session` ID.' });
                return;
            }

            const sessions = data.getSessions();
            const session  = sessions[session_id];
            if (!session) {
                await message.channel.send({ content: 'Session not found.' });
                return;
            }

            if (session.interested.length === 0) {
                await message.channel.send({ content: `No one has expressed interest in **${session.name}** yet.` });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Interested — ${session.name}`)
                .setDescription(session.interested.map(id => `<@${id}>`).join('\n'))
                .setColor(0x57F287)
                .setFooter({ text: `${session.interested.length} / ${session.spots} spots` });

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── CLOSE ─────────────────────────────────────────────────────────────
        if (action === 'close') {
            if (!permissions.check('ADMIN', message.member, message.author.id)) {
                await message.channel.send({ content: 'Only admins can close sessions.' });
                return;
            }

            const session_id = interaction.options.getString('session');
            if (!session_id) {
                await message.channel.send({ content: 'Please provide a `session` ID.' });
                return;
            }

            const sessions = data.getSessions();
            if (!sessions[session_id]) {
                await message.channel.send({ content: 'Session not found.' });
                return;
            }

            sessions[session_id].status = 'closed';
            data.saveSessions(sessions);

            await message.channel.send({ content: `Session **${sessions[session_id].name}** has been closed.` });
            return;
        }
    },
};
