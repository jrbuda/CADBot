'use strict';
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { lookupRiotId } = require('../../league/lib/riot_api.js');

module.exports = {
    name: 'admin_link',
    description: 'Link a League of Legends account for a user.',
    permission: 'ADMIN',
    no_defer: true,
    options: [
        {
            name: 'player',
            description: 'User to link an account for',
            type: 'USER',
            required: false,
        },
        {
            name: 'riot_id',
            description: 'The Riot ID (e.g. PlayerName#NA1) — skips the button',
            type: 'STRING',
            required: false,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const targetUser  = interaction.options.getUser('player');
        const riotIdInput = interaction.options.getString('riot_id');

        // Direct link: player + riot_id provided
        if (targetUser && riotIdInput) {
            if (!riotIdInput.includes('#')) {
                await interaction.reply({ content: 'Invalid Riot ID. Must include a tag, e.g. `PlayerName#NA1`.', flags: MessageFlags.Ephemeral });
                return;
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const { account, summoner } = await lookupRiotId(riotIdInput, this.logger);

                const players = data.getPlayers();
                players[targetUser.id] = {
                    discord_id:  targetUser.id,
                    riot_id:     `${account.gameName}#${account.tagLine}`,
                    puuid:       account.puuid,
                    summoner_level: summoner.summonerLevel,
                    team_id:     players[targetUser.id]?.team_id   || '',
                    team_role:   players[targetUser.id]?.team_role || '',
                    team_type:   players[targetUser.id]?.team_type || '',
                    is_tryout:   players[targetUser.id]?.is_tryout ?? false,
                    linked_at:   new Date().toISOString(),
                };
                data.savePlayers(players);

                const embed = new EmbedBuilder()
                    .setTitle(`Account Linked — ${targetUser.username}`)
                    .setColor(0x57F287)
                    .addFields(
                        { name: 'Riot ID',      value: `\`${account.gameName}#${account.tagLine}\``, inline: true },
                        { name: 'Summoner Lvl', value: String(summoner.summonerLevel),                inline: true },
                    );

                await interaction.editReply({ embeds: [embed] });
                this.logger.info(`[admin_link] ${message.author.id} linked ${targetUser.id} → ${account.gameName}#${account.tagLine}`);
            } catch (err) {
                this.logger.error('[admin_link] Riot API error: ' + err.message);
                await interaction.editReply({ content: `Failed to fetch account for \`${riotIdInput}\`. Check the Riot ID and try again.` });
            }
            return;
        }

        // Open the link flow for someone else (player specified, no riot_id)
        if (targetUser) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`LEAGUE_LINK_BUTTON_${targetUser.id}`)
                    .setLabel(`Link Riot Account for ${targetUser.username}`)
                    .setStyle(ButtonStyle.Primary),
            );

            const embed = new EmbedBuilder()
                .setTitle(`Link Account — ${targetUser.username}`)
                .setDescription(
                    `Click the button below to enter the **Riot ID** for <@${targetUser.id}>.\n\n` +
                    'The account will be linked to their Discord profile.'
                )
                .setColor(0xC89B3C);

            await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
            return;
        }

        // No args: show info about how to use
        await interaction.reply({
            content: 'Use `/admin_link player:@User riot_id:PlayerName#TAG` to link an account directly, or `/admin_link player:@User` to open the interactive flow.',
            flags: MessageFlags.Ephemeral,
        });
    },
};
