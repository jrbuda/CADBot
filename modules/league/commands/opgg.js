'use strict';
const { EmbedBuilder } = require('discord.js');

// op.gg uses a hyphenated format: "GameName-TAG"
// Multi-search URL encodes summoners comma-separated
function toOpggName(gameName, tagLine) {
    return encodeURIComponent(gameName.trim() + '-' + tagLine.trim()).replace(/%20/g, '%20');
}

module.exports = {
    name: 'opgg',
    description: 'Get op.gg profile or multi-search link for a player or team.',
    permission: 'MEMBER',
    num_args: 0,
    options: [
        {
            name: 'player',
            description: 'Get op.gg for a specific Discord user',
            type: 'USER',
            required: false,
        },
        {
            name: 'team',
            description: 'Get op.gg multi-search for an entire team',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction) {
        const path = require('path');
        const DataManager = require('../../../core/js/data_manager.js');
        const data = new DataManager(path.join(__dirname, '../../../data'), { error: () => {}, info: () => {} });

        const focused = interaction.options.getFocused().toLowerCase();
        const teams   = data.getTeams();
        const choices = Object.values(teams)
            .filter(t => t.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(t => ({ name: t.name, value: t.id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target_user = interaction.options.getUser('player');
        const team_id     = interaction.options.getString('team');

        // Determine the OP.GG region slug (op.gg uses its own naming)
        const region = (process.env.RIOT_REGION || 'na1').toLowerCase();
        const opggRegion = region.replace(/\d+$/, '') || 'na'; // "na1" → "na", "euw1" → "euw"

        // Individual player
        if (target_user) {
            const player = data.getPlayer(target_user.id);
            if (!player?.riot_id) {
                await message.channel.send({
                    content: `<@${target_user.id}> has not linked their League of Legends account.`,
                });
                return;
            }

            const [gameName, tagLine] = player.riot_id.split('#');
            const slug = toOpggName(gameName, tagLine || opggRegion.toUpperCase());
            const url  = `https://www.op.gg/summoners/${opggRegion}/${slug}`;

            const embed = new EmbedBuilder()
                .setTitle(`op.gg — ${player.riot_id}`)
                .setURL(url)
                .setDescription(`[View ${gameName}'s op.gg profile](${url})`)
                .setColor(0xFF4438)
                .setThumbnail(`https://opgg-static.akamaized.net/assets/favicon/apple-touch-icon.png`);

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // Team multi-search
        if (team_id) {
            const team    = data.getTeam(team_id);
            if (!team) {
                await message.channel.send({ content: 'Team not found.' });
                return;
            }

            const members = data.getTeamPlayers(team_id).filter(p => p.riot_id);
            if (members.length === 0) {
                await message.channel.send({
                    content: `No linked players found on **${team.name}**.`,
                });
                return;
            }

            const summoners = members.map(p => {
                const [gameName, tagLine] = p.riot_id.split('#');
                return toOpggName(gameName, tagLine || opggRegion.toUpperCase());
            }).join('%2C');

            const url = `https://www.op.gg/multisearch/${opggRegion}?summoners=${summoners}`;

            const embed = new EmbedBuilder()
                .setTitle(`op.gg Multi — ${team.name}`)
                .setURL(url)
                .setDescription(
                    `[View ${team.name} multi-search](${url})\n\n` +
                    members.map(p => {
                        const [gn, tl] = p.riot_id.split('#');
                        const slug     = toOpggName(gn, tl || opggRegion.toUpperCase());
                        const purl     = `https://www.op.gg/summoners/${opggRegion}/${slug}`;
                        return `<@${p.discord_id}> — [${p.riot_id}](${purl}) (${p.team_role || '?'})`;
                    }).join('\n')
                )
                .setColor(0xFF4438);

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // Default: requesting user's own op.gg
        const player = data.getPlayer(message.author.id);
        if (!player?.riot_id) {
            await message.channel.send({
                content: 'You have not linked your League of Legends account. Use `/link` first.\nYou can also specify a `player` or `team` option.',
            });
            return;
        }

        const [gameName, tagLine] = player.riot_id.split('#');
        const slug = toOpggName(gameName, tagLine || opggRegion.toUpperCase());
        const url  = `https://www.op.gg/summoners/${opggRegion}/${slug}`;

        const embed = new EmbedBuilder()
            .setTitle(`op.gg — ${player.riot_id}`)
            .setURL(url)
            .setDescription(`[View your op.gg profile](${url})`)
            .setColor(0xFF4438);

        await message.channel.send({ embeds: [embed] });
    },
};
