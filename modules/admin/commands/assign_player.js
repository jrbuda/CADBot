'use strict';
const { EmbedBuilder } = require('discord.js');

const POSITIONS = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];
const TYPES     = ['Main', 'Substitute'];

module.exports = {
    name: 'assign_player',
    description: 'Assign a player to a team. Optionally promote them to captain.',
    permission: 'ADMIN',
    num_args: 0,
    options: [
        {
            name: 'player',
            description: 'The Discord user to assign',
            type: 'USER',
            required: true,
        },
        {
            name: 'team',
            description: 'Team to assign the player to',
            type: 'STRING',
            required: true,
            autocomplete: true,
        },
        {
            name: 'position',
            description: 'Lane/role in the game',
            type: 'STRING',
            required: true,
            choices: POSITIONS.map(p => ({ name: p, value: p })),
        },
        {
            name: 'type',
            description: 'Roster type',
            type: 'STRING',
            required: true,
            choices: TYPES.map(t => ({ name: t, value: t })),
        },
        {
            name: 'captain',
            description: 'Make this player the captain of the team',
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
        const choices = Object.values(teams)
            .filter(t => t.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(t => ({ name: t.name, value: t.id }));

        await interaction.respond(choices);
    },

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const target    = interaction.options.getUser('player');
        const team_id   = interaction.options.getString('team');
        const position  = interaction.options.getString('position');
        const type      = interaction.options.getString('type');
        const makeCaptain = interaction.options.getBoolean('captain') ?? false;

        const team = data.getTeam(team_id);
        if (!team) {
            await message.channel.send({ content: 'Team not found.' });
            return;
        }

        const player = data.getPlayer(target.id);
        if (!player) {
            await message.channel.send({
                content: `<@${target.id}> has not linked their League of Legends account yet. They must use \`/link\` first.`,
            });
            return;
        }

        const config  = data.getConfig();
        const players = data.getPlayers();

        // Update player record
        players[target.id].team_id   = team_id;
        players[target.id].team_role = position;
        players[target.id].team_type = type;
        data.savePlayers(players);

        // Assign team Discord role if configured
        if (team.discord_role_id) {
            try {
                const member = await message.guild.members.fetch(target.id);
                await member.roles.add(team.discord_role_id);
            } catch (err) {
                this.logger.warn(`[assign_player] Could not assign team role: ${err.message}`);
            }
        }

        // ── Captain promotion ─────────────────────────────────────────────────
        if (makeCaptain) {
            const teams = data.getTeams();
            const previousCaptainId = teams[team_id].captain_id;

            // Remove captain role from the previous captain (if different person)
            if (previousCaptainId && previousCaptainId !== target.id && config.captain_role_id) {
                try {
                    const prevMember = await message.guild.members.fetch(previousCaptainId);
                    await prevMember.roles.remove(config.captain_role_id);
                } catch (_) { /* previous captain may have left the server */ }
            }

            // Set new captain
            teams[team_id].captain_id = target.id;
            data.saveTeams(teams);

            // Assign captain role
            if (config.captain_role_id) {
                try {
                    const member = await message.guild.members.fetch(target.id);
                    await member.roles.add(config.captain_role_id);
                } catch (err) {
                    this.logger.warn(`[assign_player] Could not assign captain role: ${err.message}`);
                }
            }
        }

        const embed = new EmbedBuilder()
            .setTitle('Player Assigned')
            .setColor(0x5865F2)
            .addFields(
                { name: 'Player',   value: `<@${target.id}>`,                              inline: true },
                { name: 'Team',     value: team.name,                                       inline: true },
                { name: 'Position', value: position,                                        inline: true },
                { name: 'Type',     value: type,                                            inline: true },
                { name: 'Captain',  value: makeCaptain ? '✅ Yes' : '—',                    inline: true },
            )
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });
        this.logger.info(`[assign_player] ${target.id} → ${team.name} (${type} ${position}${makeCaptain ? ', captain' : ''})`);
    },
};
