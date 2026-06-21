'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
    name: 'link',
    description: 'Link your League of Legends account (Riot ID) to your Discord profile.',
    permission: 'EVERYONE',
    num_args: 0,
    no_defer: true,   // We reply without deferring so we can use a modal
    options: [],

    async execute(message, args, extra) {
        const interaction = extra.interaction;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('LEAGUE_LINK_BUTTON')
                .setLabel('Link Riot Account')
                .setStyle(ButtonStyle.Primary),
        );

        const embed = new EmbedBuilder()
            .setTitle('Link Your League of Legends Account')
            .setDescription(
                'Click the button below to enter your **Riot ID** (e.g. `PlayerName#NA1`).\n\n' +
                'Your account data will be fetched from the Riot API and saved to your Discord profile.'
            )
            .setColor(0xC89B3C)
            .setFooter({ text: 'Your Riot ID is your in-game name and tag.' });

        await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    },
};
