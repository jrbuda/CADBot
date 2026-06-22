'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');

module.exports = {
    name: 'record',
    description: 'Manually submit a scrim result — pick a scrim, then click Win or Loss.',
    permission: 'CAPTAIN',
    ephemeral: true,
    options: [],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const my_team = data.getTeamByCaptain(message.author.id);
        if (!my_team) {
            await message.channel.send({ content: 'You are not set as a captain of any team.' });
            return;
        }

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
                `Select a scrim below. After selecting, use the **Win** or **Loss** buttons to record the result. No typing needed.`
            )
            .setColor(0x5865F2);

        await message.channel.send({ embeds: [embed], components: [row] });
    },
};
