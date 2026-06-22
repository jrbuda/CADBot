'use strict';
const { EmbedBuilder } = require('discord.js');

function toOpggName(gameName, tagLine) {
    return encodeURIComponent(gameName.trim() + '-' + tagLine.trim()).replace(/%20/g, '%20');
}

function opggRegionSlug() {
    return (process.env.RIOT_REGION || 'na1').toLowerCase().replace(/\d+$/, '') || 'na';
}

module.exports = {
    name: 'opgg',
    description: 'Get op.gg profile or multi-search link for a player or team.',
    permission: 'EVERYONE',
    options: [
        {
            name: 'player',
            description: 'Get op.gg for a specific player (only shows linked accounts)',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
        {
            name: 'team',
            description: 'Get op.gg multi-search for an entire team',
            type: 'STRING',
            required: false,
            autocomplete: true,
        },
    ],

    async autocomplete(interaction, extra) {
        const data = extra.data;

        const focused = interaction.options.getFocused(true);
        const query   = focused.value.toLowerCase();

        if (focused.name === 'player') {
            const players = data.getPlayers();
            const choices = Object.values(players)
                .filter(p => p.riot_id && p.riot_id.toLowerCase().includes(query))
                .slice(0, 25)
                .map(p => ({ name: p.riot_id, value: p.discord_id }));
            await interaction.respond(choices);
        } else {
            // team autocomplete
            const teams = data.getTeams();
            const choices = Object.values(teams)
                .filter(t => t.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(t => ({ name: t.name, value: t.id }));
            await interaction.respond(choices);
        }
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const player_id = interaction.options.getString('player');
        const team_id   = interaction.options.getString('team');
        const region    = opggRegionSlug();

        // ── Individual player ─────────────────────────────────────────────────
        if (player_id) {
            const player = data.getPlayer(player_id);
            if (!player?.riot_id) {
                await message.channel.send({ content: 'That player has not linked their League of Legends account.' });
                return;
            }
            const [gameName, tagLine] = player.riot_id.split('#');
            const slug = toOpggName(gameName, tagLine || region.toUpperCase());
            const url  = `https://www.op.gg/summoners/${region}/${slug}`;

            const embed = new EmbedBuilder()
                .setTitle(`op.gg — ${player.riot_id}`)
                .setURL(url)
                .setDescription(`[View ${gameName}'s op.gg profile](${url})`)
                .setColor(0xFF4438);

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── Team multi-search ─────────────────────────────────────────────────
        if (team_id) {
            const team    = data.getTeam(team_id);
            if (!team) {
                await message.channel.send({ content: 'Team not found.' });
                return;
            }
            const members = data.getTeamPlayers(team_id).filter(p => p.riot_id);
            if (members.length === 0) {
                await message.channel.send({ content: `No linked players found on **${team.name}**.` });
                return;
            }

            const summoners = members.map(p => {
                const [gameName, tagLine] = p.riot_id.split('#');
                return toOpggName(gameName, tagLine || region.toUpperCase());
            }).join('%2C');

            const url = `https://www.op.gg/multisearch/${region}?summoners=${summoners}`;

            const embed = new EmbedBuilder()
                .setTitle(`op.gg Multi — ${team.name}`)
                .setURL(url)
                .setDescription(
                    `[View ${team.name} multi-search](${url})\n\n` +
                    members.map(p => {
                        const [gn, tl] = p.riot_id.split('#');
                        const purl = `https://www.op.gg/summoners/${region}/${toOpggName(gn, tl || region.toUpperCase())}`;
                        return `<@${p.discord_id}> — [${p.riot_id}](${purl}) (${p.team_role || '?'})`;
                    }).join('\n')
                )
                .setColor(0xFF4438);

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── Default: requester's own profile ──────────────────────────────────
        const player = data.getPlayer(message.author.id);
        if (!player?.riot_id) {
            await message.channel.send({
                content: 'You have not linked your account. Use `/link` first, or specify a `player` or `team`.',
            });
            return;
        }
        const [gameName, tagLine] = player.riot_id.split('#');
        const slug = toOpggName(gameName, tagLine || region.toUpperCase());
        const url  = `https://www.op.gg/summoners/${region}/${slug}`;

        const embed = new EmbedBuilder()
            .setTitle(`op.gg — ${player.riot_id}`)
            .setURL(url)
            .setDescription(`[View your op.gg profile](${url})`)
            .setColor(0xFF4438);

        await message.channel.send({ embeds: [embed] });
    },
};
