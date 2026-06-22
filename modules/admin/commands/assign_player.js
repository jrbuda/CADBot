'use strict';
const { EmbedBuilder } = require('discord.js');

const POSITIONS = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];
const TYPES     = ['Main', 'Substitute'];

async function ensurePositionRole(guild, config, data, position, logger) {
    if (!config.position_roles) config.position_roles = {};
    if (config.position_roles[position]) return config.position_roles[position];

    try {
        const role = await guild.roles.create({
            name: position,
            mentionable: true,
            reason: `Auto-created position role for CADBot`,
        });
        config.position_roles[position] = role.id;
        data.saveConfig(config);
        logger.info(`[position_role] Auto-created @${position} role: ${role.id}`);
        return role.id;
    } catch (err) {
        logger.warn(`[position_role] Could not create @${position} role: ${err.message}`);
        return null;
    }
}

module.exports = {
    name: 'assign_player',
    description: 'Assign a player to a team. Optionally promote them to captain.',
    permission: 'ADMIN',
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

    async autocomplete(interaction, extra) {
        const data = extra.data;

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

        const target      = interaction.options.getUser('player');
        const team_id     = interaction.options.getString('team');
        const position    = interaction.options.getString('position');
        const type        = interaction.options.getString('type');
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

        const wasTryout      = players[target.id].is_tryout;
        const oldTeamId      = players[target.id].team_id;
        const oldPosition    = players[target.id].team_role;
        const oldType        = players[target.id].team_type;
        const isReassignment = oldTeamId && oldTeamId !== team_id;

        // Remove old team roles if reassigning from another team
        if (isReassignment) {
            const oldTeam = data.getTeam(oldTeamId);
            if (oldTeam) {
                if (oldTeam.captain_id === target.id) {
                    const teams = data.getTeams();
                    teams[oldTeam.id].captain_id = '';
                    data.saveTeams(teams);
                    if (config.captain_role_id) {
                        try {
                            const member = await message.guild.members.fetch(target.id);
                            await member.roles.remove(config.captain_role_id);
                        } catch (e) { this.logger.warn('[assign_player] Could not remove server captain role on reassign: ' + e.message); }
                    }
                }
                const oldRoleIds = [oldTeam.discord_role_id, oldTeam.captain_discord_role_id, oldTeam.sub_discord_role_id].filter(Boolean);
                for (const rid of oldRoleIds) {
                    try {
                        const member = await message.guild.members.fetch(target.id);
                        await member.roles.remove(rid);
                    } catch (e) { this.logger.warn('[assign_player] Could not remove old team role ' + rid + ': ' + e.message); }
                }
            }
            if (oldPosition && config.position_roles?.[oldPosition]) {
                try {
                    const member = await message.guild.members.fetch(target.id);
                    await member.roles.remove(config.position_roles[oldPosition]);
                } catch (e) { this.logger.warn('[assign_player] Could not remove old position role: ' + e.message); }
            }
        }

        // Update player record
        players[target.id].team_id   = team_id;
        players[target.id].team_role = position;
        players[target.id].team_type = type;
        players[target.id].is_tryout = false;
        data.savePlayers(players);

        const memberToRole = async () => {
            try { return await message.guild.members.fetch(target.id); } catch (_) { return null; }
        };
        const member = await memberToRole();

        // Assign team role based on type
        const teamRoleId = type === 'Main' ? team.discord_role_id : team.sub_discord_role_id;
        if (member && teamRoleId) {
            try { await member.roles.add(teamRoleId); }
            catch (e) { this.logger.warn('[assign_player] Could not assign team type role: ' + e.message); }
        }

        // Position role (mains only)
        if (type === 'Main' && POSITIONS.includes(position)) {
            const posRoleId = await ensurePositionRole(message.guild, config, data, position, this.logger);
            if (member && posRoleId) {
                // Remove old position role if changing positions (same team reassign)
                if (oldPosition && oldPosition !== position && oldTeamId === team_id && config.position_roles?.[oldPosition]) {
                    try { await member.roles.remove(config.position_roles[oldPosition]); }
                    catch (e) { this.logger.warn('[assign_player] Could not swap position role: ' + e.message); }
                }
                if (!isReassignment || oldPosition !== position) {
                    try { await member.roles.add(posRoleId); }
                    catch (e) { this.logger.warn('[assign_player] Could not assign position role: ' + e.message); }
                }
            }
        }

        // Clear tryout role if present
        if (wasTryout && member && config.tryout_role_id) {
            try { await member.roles.remove(config.tryout_role_id); }
            catch (e) { this.logger.warn('[assign_player] Could not remove tryout role: ' + e.message); }
        }

        // Captain promotion / demotion
        if (makeCaptain) {
            const teams = data.getTeams();
            const previousCaptainId = teams[team_id].captain_id;

            if (previousCaptainId && previousCaptainId !== target.id && config.captain_role_id) {
                try {
                    const prevMember = await message.guild.members.fetch(previousCaptainId);
                    await prevMember.roles.remove(config.captain_role_id);
                    if (team.captain_discord_role_id) await prevMember.roles.remove(team.captain_discord_role_id);
                } catch (e) { this.logger.warn('[assign_player] Could not demote previous captain ' + previousCaptainId + ': ' + e.message); }
            }

            teams[team_id].captain_id = target.id;
            data.saveTeams(teams);

            if (member && config.captain_role_id) {
                try { await member.roles.add(config.captain_role_id); }
                catch (e) { this.logger.warn('[assign_player] Could not assign server captain role: ' + e.message); }
            }
            if (member && team.captain_discord_role_id) {
                try { await member.roles.add(team.captain_discord_role_id); }
                catch (e) { this.logger.warn('[assign_player] Could not assign team captain role: ' + e.message); }
            }
        } else {
            if (team.captain_id === target.id) {
                const teams = data.getTeams();
                teams[team_id].captain_id = '';
                data.saveTeams(teams);

                if (member && config.captain_role_id) {
                    try { await member.roles.remove(config.captain_role_id); }
                    catch (e) { this.logger.warn('[assign_player] Could not remove server captain role: ' + e.message); }
                }
                if (member && team.captain_discord_role_id) {
                    try { await member.roles.remove(team.captain_discord_role_id); }
                    catch (e) { this.logger.warn('[assign_player] Could not remove team captain role: ' + e.message); }
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
                { name: 'Captain',  value: makeCaptain ? '\u2705 Yes' : '\u2014',           inline: true },
            )
            .setTimestamp();

        if (wasTryout) {
            embed.addFields({ name: 'Note', value: 'Tryout status cleared.', inline: false });
        }

        await message.channel.send({ embeds: [embed] });
        this.logger.info(`[assign_player] ${target.id} \u2192 ${team.name} (${type} ${position}${makeCaptain ? ', captain' : ''})`);
    },
};
