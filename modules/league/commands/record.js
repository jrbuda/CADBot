'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');

module.exports = {
    name: 'record',
    description: 'Manually submit a scrim result (fallback for the auto-posted result embed).',
    permission: 'CAPTAIN',
    no_defer: false,
    ephemeral: true,
    options: [],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        // Find the captain's team
        const my_team = data.getTeamByCaptain(message.author.id);
        if (!my_team) {
            await message.channel.send({ content: 'You are not set as a captain of any team.' });
            return;
        }

        // Find scrims involving this team that are confirmed but not yet fully recorded
        const scrims   = data.getScrims();
        const pending  = Object.values(scrims).filter(s =>
            (s.team1_id === my_team.id || s.team2_id === my_team.id) &&
            s.status === 'confirmed' &&
            !s.result
        );

        if (pending.length === 0) {
            await message.channel.send({
                content: 'No confirmed scrims found that need a result recorded. If a scrim was just completed, make sure it was in **confirmed** status.',
            });
            return;
        }

        // Build select menu of pending scrims
        const teams = data.getTeams();
        const options = pending.slice(0, 25).map(s => {
            const opp_id   = s.team1_id === my_team.id ? s.team2_id : s.team1_id;
            const opp_team = teams[opp_id];
            const dt       = new Date(s.scheduled_time);
            const label    = `vs ${opp_team?.name || 'Unknown'} — ${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
            return new StringSelectMenuOptionBuilder()
                .setLabel(label.substring(0, 100))
                .setValue(s.id);
        });

        const select = new StringSelectMenuBuilder()
            .setCustomId('RECORD_SCRIM_SELECT')
            .setPlaceholder('Choose a scrim to record...')
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(select);

        const embed = new EmbedBuilder()
            .setTitle('Record Scrim Result')
            .setDescription(
                `Select a scrim to submit the result for. You are recording for **${my_team.name}**.\n\n` +
                `The result will be logged immediately. The opposing captain will be notified and can dispute within 48 hours.`
            )
            .setColor(0x5865F2);

        await message.channel.send({ embeds: [embed], components: [row] });
    },
};
