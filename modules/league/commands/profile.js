'use strict';
const { EmbedBuilder } = require('discord.js');
const { getRankedStats } = require('../lib/riot_api.js');

const POSITION_EMOJI = {
    Top: '🛡️', Jungle: '🌿', Mid: '⚡', Bot: '🏹', Support: '💊',
};

const TIER_COLORS = {
    IRON: 0x736357, BRONZE: 0xAD7B4B, SILVER: 0xA8A8A8,
    GOLD: 0xF4C842, PLATINUM: 0x4FC2A0, EMERALD: 0x2DB87D,
    DIAMOND: 0x607BE8, MASTER: 0x9B59B6, GRANDMASTER: 0xE74C3C, CHALLENGER: 0xF1C40F,
};

module.exports = {
    name: 'profile',
    description: 'View a linked player\'s League of Legends profile and team info.',
    permission: 'EVERYONE',
    ephemeral: true,
    options: [
        {
            name: 'player',
            description: 'Player to look up (only shows linked accounts)',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

        const query   = interaction.options.getFocused().toLowerCase();
        const players = data.getPlayers();
        const choices = Object.values(players)
            .filter(p => p.riot_id && p.riot_id.toLowerCase().includes(query))
            .slice(0, 25)
            .map(p => ({ name: p.riot_id, value: p.discord_id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target_id = interaction.options.getString('player') || message.author.id;
        const isSelf    = target_id === message.author.id;

        const player = data.getPlayer(target_id);
        if (!player) {
            const mention = isSelf ? 'You have' : `<@${target_id}> has`;
            await message.channel.send({ content: `${mention} not linked a League of Legends account. Use \`/link\` to get started.` });
            return;
        }

        // Fetch the Discord user for display name and avatar
        let displayName = isSelf ? (message.author.globalName || message.author.username) : `<@${target_id}>`;
        let avatarUrl   = isSelf ? (message.author.displayAvatarURL?.({ size: 256 }) ?? null) : null;
        try {
            const member = await message.guild.members.fetch(target_id);
            displayName  = member.displayName || member.user.globalName || member.user.username;
            avatarUrl    = member.user.displayAvatarURL({ size: 256 });
        } catch (_) { /* member may have left; fall back to above */ }

        const team     = player.team_id ? data.getTeam(player.team_id) : null;
        const posEmoji = POSITION_EMOJI[player.team_role] || '';

        const embed = new EmbedBuilder()
            .setTitle(displayName)
            .setColor(0x5865F2)
            .setTimestamp();
        if (avatarUrl) embed.setThumbnail(avatarUrl);

        // Riot ID
        embed.addFields({ name: 'Riot ID', value: `\`${player.riot_id || 'Unknown'}\``, inline: true });

        // Team info
        if (team) {
            embed.addFields(
                { name: 'Team',     value: team.name,                                       inline: true },
                { name: 'Position', value: `${posEmoji} ${player.team_role || '?'}`,        inline: true },
                { name: 'Type',     value: player.team_type || '?',                         inline: true },
            );
        } else if (player.is_tryout) {
            embed.addFields({ name: 'Status', value: '🔎 Tryout', inline: true });
        } else {
            embed.addFields({ name: 'Team', value: 'Unassigned', inline: true });
        }

        // Attempt to fetch ranked stats from Riot API
        if (player.summoner_id) {
            try {
                const ranked = await getRankedStats(player.summoner_id, this.logger);
                const solo   = ranked.find(q => q.queueType === 'RANKED_SOLO_5x5');
                const flex   = ranked.find(q => q.queueType === 'RANKED_FLEX_SR');

                if (solo) {
                    const wr = ((solo.wins / (solo.wins + solo.losses)) * 100).toFixed(1);
                    embed.addFields({
                        name: 'Solo/Duo',
                        value: `${solo.tier} ${solo.rank} (${solo.leaguePoints} LP)\n${solo.wins}W / ${solo.losses}L — ${wr}% WR`,
                        inline: true,
                    });
                    const tierColor = TIER_COLORS[solo.tier?.toUpperCase()];
                    if (tierColor) embed.setColor(tierColor);
                }
                if (flex) {
                    const wr = ((flex.wins / (flex.wins + flex.losses)) * 100).toFixed(1);
                    embed.addFields({
                        name: 'Flex',
                        value: `${flex.tier} ${flex.rank} (${flex.leaguePoints} LP)\n${flex.wins}W / ${flex.losses}L — ${wr}% WR`,
                        inline: true,
                    });
                }
                if (!solo && !flex) {
                    embed.addFields({ name: 'Ranked', value: 'Unranked', inline: true });
                }
            } catch (err) {
                this.logger.warn('[profile] Ranked stats fetch failed: ' + err.message);
                embed.addFields({ name: 'Ranked', value: '_Unable to fetch_', inline: true });
            }
        }

        embed.setFooter({ text: `Linked ${new Date(player.linked_at).toLocaleDateString()}` });

        await message.channel.send({ embeds: [embed] });
    },
};
