'use strict';
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

let logger;
let data;
let perms;

const CID = {
    DELETE_TEAM_CONFIRM: 'ADMIN_DELETE_TEAM_CONFIRM', // _<teamId>
    DELETE_TEAM_CANCEL:  'ADMIN_DELETE_TEAM_CANCEL',  // _<teamId>
    UNASSIGN_CONFIRM:    'ADMIN_UNASSIGN_CONFIRM',    // _<userId>
    UNASSIGN_CANCEL:     'ADMIN_UNASSIGN_CANCEL',     // _<userId>
    CHANNEL_TEST:        'ADMIN_SET_CHANNEL_TEST',    // _<channelId>
};

function register_handlers(event_registry) {
    logger = event_registry.logger;
    data   = event_registry.data_manager;
    perms  = event_registry.permissions;

    event_registry.register('interactionCreate', async (interaction) => {
        if (!interaction.isButton()) return;

        const id = interaction.customId;
        try {
            if (id.startsWith(CID.DELETE_TEAM_CONFIRM)) {
                await handleDeleteTeamConfirm(interaction, id.replace(CID.DELETE_TEAM_CONFIRM + '_', ''));
            } else if (id.startsWith(CID.DELETE_TEAM_CANCEL)) {
                await handleDeleteTeamCancel(interaction);
            } else if (id.startsWith(CID.UNASSIGN_CONFIRM)) {
                await handleUnassignConfirm(interaction, id.replace(CID.UNASSIGN_CONFIRM + '_', ''));
            } else if (id.startsWith(CID.UNASSIGN_CANCEL)) {
                await handleUnassignCancel(interaction);
            } else if (id.startsWith(CID.CHANNEL_TEST)) {
                await handleChannelTest(interaction, id.replace(CID.CHANNEL_TEST + '_', ''));
            }
        } catch (err) {
            logger.error('[admin/events] ' + err.message + '\n' + err.stack);
            try {
                await interaction.followUp({ content: 'An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
            } catch (e) { logger.warn('[admin/events] followUp error recovery failed: ' + e.message); }
        }
    });
}

// ── Delete team confirmation ──────────────────────────────────────────────────

async function handleDeleteTeamConfirm(interaction, team_id) {
    await interaction.deferUpdate();

    const team = data.getTeam(team_id);
    if (!team) {
        await interaction.editReply({ content: 'Team not found.', components: [] });
        return;
    }

    const teamName = team.name;
    const config   = data.getConfig();
    const players  = data.getPlayers();
    const teams    = data.getTeams();
    let unassigned = 0;

    for (const [uid, player] of Object.entries(players)) {
        if (player.team_id === team_id) {
            players[uid].team_id    = '';
            players[uid].team_role  = '';
            players[uid].team_type  = '';
            unassigned++;

            if (config.captain_role_id && team.captain_id === uid) {
                try {
                    const member = await interaction.guild.members.fetch(uid);
                    await member.roles.remove(config.captain_role_id);
                } catch (e) { logger.warn('[delete_team] Could not remove captain role from ' + uid + ': ' + e.message); }
            }

            if (player.team_role && config.position_roles?.[player.team_role]) {
                try {
                    const member = await interaction.guild.members.fetch(uid);
                    await member.roles.remove(config.position_roles[player.team_role]);
                } catch (e) { logger.warn('[delete_team] Could not remove position role from ' + uid + ': ' + e.message); }
            }

            const roleIds = [team.discord_role_id, team.captain_discord_role_id, team.sub_discord_role_id].filter(Boolean);
            for (const rid of roleIds) {
                try {
                    const member = await interaction.guild.members.fetch(uid);
                    await member.roles.remove(rid);
                } catch (e) { logger.warn('[delete_team] Could not remove team role ' + rid + ' from ' + uid + ': ' + e.message); }
            }
        }
    }
    data.savePlayers(players);

    delete teams[team_id];
    data.saveTeams(teams);

    let roleResult = '';
    const allRoleIds = [team.discord_role_id, team.captain_discord_role_id, team.sub_discord_role_id].filter(Boolean);
    for (const rid of allRoleIds) {
        try {
            const role = await interaction.guild.roles.fetch(rid);
            await role.delete(`Team ${teamName} deleted by admin`);
        } catch (e) { logger.warn('[delete_team] Could not delete Discord role ' + rid + ': ' + e.message); }
    }
    roleResult = allRoleIds.length > 0 ? 'Roles cleaned up.' : '';

    const embed = new EmbedBuilder()
        .setTitle('Team Deleted')
        .setColor(0xED4245)
        .setDescription(`**${teamName}** has been deleted.\n${unassigned} player(s) unassigned.\n${roleResult}`)
        .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] });
    logger.info(`[delete_team] ${interaction.user.id} deleted team "${teamName}" (${team_id})`);
}

async function handleDeleteTeamCancel(interaction) {
    await interaction.update({ content: 'Deletion cancelled.', embeds: [], components: [] });
}

// ── Unassign confirmation ─────────────────────────────────────────────────────

async function handleUnassignConfirm(interaction, targetId) {
    await interaction.deferUpdate();

    const player = data.getPlayer(targetId);
    if (!player || !player.team_id) {
        await interaction.editReply({ content: `<@${targetId}> is not currently assigned to any team.`, components: [] });
        return;
    }

    const team      = data.getTeam(player.team_id);
    const teamName  = team ? team.name : 'Unknown';
    const config    = data.getConfig();
    const players   = data.getPlayers();

    players[targetId].team_id   = '';
    players[targetId].team_role = '';
    players[targetId].team_type = '';
    data.savePlayers(players);

    if (team && team.captain_id === targetId) {
        const teams = data.getTeams();
        teams[team.id].captain_id = '';
        data.saveTeams(teams);

        if (config.captain_role_id) {
            try {
                const member = await interaction.guild.members.fetch(targetId);
                await member.roles.remove(config.captain_role_id);
            } catch (e) { logger.warn('[unassign_player] Could not remove server captain role: ' + e.message); }
        }
        if (team.captain_discord_role_id) {
            try {
                const member = await interaction.guild.members.fetch(targetId);
                await member.roles.remove(team.captain_discord_role_id);
            } catch (e) { logger.warn('[unassign_player] Could not remove team captain role: ' + e.message); }
        }
    }

    if (player.team_role && config.position_roles?.[player.team_role]) {
        try {
            const member = await interaction.guild.members.fetch(targetId);
            await member.roles.remove(config.position_roles[player.team_role]);
        } catch (e) { logger.warn('[unassign_player] Could not remove position role: ' + e.message); }
    }

    const roleIds = [team?.discord_role_id, team?.sub_discord_role_id].filter(Boolean);
    for (const rid of roleIds) {
        try {
            const member = await interaction.guild.members.fetch(targetId);
            await member.roles.remove(rid);
        } catch (e) { logger.warn('[unassign_player] Could not remove team role ' + rid + ': ' + e.message); }
    }

    await interaction.editReply({ content: `<@${targetId}> has been removed from **${teamName}**.`, components: [] });
    logger.info(`[unassign_player] ${targetId} unassigned from team "${teamName}" by ${interaction.user.id}`);
}

async function handleUnassignCancel(interaction) {
    await interaction.update({ content: 'Unassignment cancelled.', embeds: [], components: [] });
}

// ── Channel test ───────────────────────────────────────────────────────────────

async function handleChannelTest(interaction, channelId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const channel = await interaction.guild.channels.fetch(channelId);
        await channel.send({ content: '\u2705 This is a test message from CADBot \u2014 messages will appear here.' });
        await interaction.editReply({ content: `Test passed \u2014 message delivered to <#${channelId}>.` });
    } catch (err) {
        await interaction.editReply({ content: `Test failed \u2014 CADBot cannot send to <#${channelId}>. Check channel permissions.` });
    }
}

module.exports = register_handlers;
