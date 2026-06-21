'use strict';
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { findScrimSlots, formatDate } = require('../lib/availability_utils.js');
const { randomUUID } = require('crypto');

// In-memory cache: scrim slot selections pending captain confirmation
// key: cache_id (8-char), value: { team1_id, team2_id, slots, include_subs, allow_fill, requested_by }
const pendingSlots = new Map();

module.exports = {
    name: 'scrim',
    description: 'Request a scrim against another team. Shows available overlapping time slots.',
    permission: 'CAPTAIN',
    no_defer: false,
    ephemeral: true,
    options: [
        {
            name: 'vs',
            description: 'Team to challenge',
            type: 'STRING',
            required: true,
            autocomplete: true,
        },
        {
            name: 'include_subs',
            description: 'Count substitutes toward the minimum 5 players per team (default: false)',
            type: 'BOOLEAN',
            required: false,
        },
        {
            name: 'allow_fill',
            description: 'Let non-team members click to show interest in filling an open spot',
            type: 'BOOLEAN',
            required: false,
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

        const focused = interaction.options.getFocused().toLowerCase();
        const teams   = data.getTeams();

        // Don't show the captain's own team
        const captainTeam = data.getTeamByCaptain(interaction.user.id);
        const choices = Object.values(teams)
            .filter(t => t.name.toLowerCase().includes(focused) && t.id !== captainTeam?.id)
            .slice(0, 25)
            .map(t => ({ name: t.name, value: t.id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const opp_team_id  = interaction.options.getString('vs');
        const include_subs = interaction.options.getBoolean('include_subs') ?? false;
        const allow_fill   = interaction.options.getBoolean('allow_fill')   ?? false;

        // Validate requesting captain owns a team
        const my_team = data.getTeamByCaptain(message.author.id);
        if (!my_team) {
            await message.channel.send({ content: 'You are not set as a captain of any team.' });
            return;
        }

        const opp_team = data.getTeam(opp_team_id);
        if (!opp_team) {
            await message.channel.send({ content: 'Opponent team not found.' });
            return;
        }

        if (my_team.id === opp_team.id) {
            await message.channel.send({ content: 'You cannot scrim your own team.' });
            return;
        }

        // Gather players
        const all_players = data.getTeamPlayers(my_team.id);
        const opp_players = data.getTeamPlayers(opp_team.id);

        const filterFn = include_subs
            ? (p) => p.team_role && p.riot_id   // all positions
            : (p) => p.team_type === 'Main' && p.riot_id;

        const my_ids  = all_players.filter(filterFn).map(p => p.discord_id);
        const opp_ids = opp_players.filter(filterFn).map(p => p.discord_id);

        const availability = data.getAvailability();
        const config       = data.getConfig();
        const timezone     = config.timezone || 'America/New_York';

        const slots = findScrimSlots(my_ids, opp_ids, availability, {
            days:         14,
            max_slots:    5,
            min_per_team: 5,
        });

        if (slots.length === 0) {
            await message.channel.send({
                content: `No overlapping availability found between **${my_team.name}** and **${opp_team.name}** in the next 14 days.\n` +
                         `Make sure both teams have set their availability with \`/availability\`.`,
            });
            return;
        }

        // Cache the slot data
        const cache_id = randomUUID().replace(/-/g, '').substring(0, 12);
        pendingSlots.set(cache_id, {
            team1_id:    my_team.id,
            team2_id:    opp_team.id,
            slots,
            include_subs,
            allow_fill,
            requested_by: message.author.id,
            timezone,
        });

        // Auto-expire cache entry after 15 minutes
        setTimeout(() => pendingSlots.delete(cache_id), 15 * 60 * 1000);

        // Build the select menu — labels use plain text; the embed uses <t:> for localisation
        const options = slots.map((slot, i) => {
            const tz = data.getConfig().timezone || 'America/New_York';
            const startDate = new Date(slot.start_unix * 1000);
            const endDate   = new Date(slot.end_unix   * 1000);
            const fmtOpts   = { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true };
            const dateStr   = startDate.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
            const startStr  = startDate.toLocaleTimeString('en-US', fmtOpts);
            const endStr    = endDate.toLocaleTimeString('en-US', fmtOpts);
            const label     = `${dateStr} — ${startStr}–${endStr}`;
            const desc      = `${my_team.name}: ${slot.t1_count} · ${opp_team.name}: ${slot.t2_count} players`;
            return new StringSelectMenuOptionBuilder()
                .setLabel(label.substring(0, 100))
                .setDescription(desc.substring(0, 100))
                .setValue(`${cache_id}:${i}`);
        });

        const select = new StringSelectMenuBuilder()
            .setCustomId('SCRIM_SLOT_SELECT')
            .setPlaceholder('Pick a time slot...')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);

        const embed = new EmbedBuilder()
            .setTitle(`Scrim Request — ${my_team.name} vs ${opp_team.name}`)
            .setDescription(
                `Found **${slots.length}** available time slot${slots.length !== 1 ? 's' : ''} in the next 14 days.\n` +
                `Select a slot below to send the request to **${opp_team.name}**'s captain.\n\n` +
                (include_subs ? '✅ Substitutes included\n' : '') +
                (allow_fill   ? '✅ Fill interest enabled' : '')
            )
            .setColor(0xC89B3C)
            .setFooter({ text: `Slot times shown in ${data.getConfig().timezone || 'America/New_York'} (league timezone). Scrim request uses Discord timestamps visible in your local time.` });

        await message.channel.send({ embeds: [embed], components: [row] });
        this.logger.info(`[scrim] ${message.author.id} opened scrim request ${my_team.name} vs ${opp_team.name}`);
    },

    // Expose the pendingSlots cache so events.js can read it
    pendingSlots,
};
