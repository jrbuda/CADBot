'use strict';
const { EmbedBuilder } = require('discord.js');
const { randomUUID }   = require('crypto');

const POSITIONS = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];

async function ensurePositionRole(guild, config, data, position, logger) {
    if (!config.position_roles) config.position_roles = {};
    if (config.position_roles[position]) return config.position_roles[position];

    try {
        const role = await guild.roles.create({
            name: position,
            mentionable: true,
            reason: 'Auto-created position role for CADBot',
        });
        config.position_roles[position] = role.id;
        data.saveConfig(config);
        logger.info(`[setup] Auto-created @${position} role: ${role.id}`);
        return role.id;
    } catch (err) {
        logger.warn(`[setup] Could not create @${position} role: ${err.message}`);
        return null;
    }
}

async function assignPlayerToTeam(message, data, interaction, targetId, team, position, type, makeCaptain) {
    const config  = data.getConfig();
    const players = data.getPlayers();
    const player  = data.getPlayer(targetId);

    if (!player?.riot_id) {
        return { ok: false, reason: `<@${targetId}> has not linked their Riot account yet. They need to use \`/link\` first.` };
    }

    const wasTryout     = player.is_tryout;
    const oldTeamId     = player.team_id;
    const oldPosition   = player.team_role;

    if (oldTeamId && oldTeamId !== team.id) {
        const oldTeam = data.getTeam(oldTeamId);
        if (oldTeam) {
            if (oldTeam.captain_id === targetId) {
                const teams = data.getTeams();
                teams[oldTeam.id].captain_id = '';
                data.saveTeams(teams);
                if (config.captain_role_id) {
                    try {
                        const member = await message.guild.members.fetch(targetId);
                        await member.roles.remove(config.captain_role_id);
                    } catch (_) {}
                }
            }
            const oldRoleIds = [oldTeam.discord_role_id, oldTeam.captain_discord_role_id, oldTeam.sub_discord_role_id].filter(Boolean);
            for (const rid of oldRoleIds) {
                try {
                    const member = await message.guild.members.fetch(targetId);
                    await member.roles.remove(rid);
                } catch (_) {}
            }
        }
        if (oldPosition && config.position_roles?.[oldPosition]) {
            try {
                const member = await message.guild.members.fetch(targetId);
                await member.roles.remove(config.position_roles[oldPosition]);
            } catch (_) {}
        }
    }

    players[targetId].team_id   = team.id;
    players[targetId].team_role = position;
    players[targetId].team_type = type;
    players[targetId].is_tryout = false;
    data.savePlayers(players);

    const teamRoleId = type === 'Main' ? team.discord_role_id : team.sub_discord_role_id;
    try {
        const member = await message.guild.members.fetch(targetId);
        if (teamRoleId) await member.roles.add(teamRoleId);
        if (type === 'Main') {
            const posRoleId = await ensurePositionRole(message.guild, config, data, position, this?.logger || { warn: () => {} });
            if (posRoleId) await member.roles.add(posRoleId);
        }
        if (wasTryout && config.tryout_role_id) await member.roles.remove(config.tryout_role_id).catch(() => {});
    } catch (_) {}

    if (makeCaptain) {
        const teams = data.getTeams();
        const prevCapId = teams[team.id].captain_id;
        if (prevCapId && prevCapId !== targetId) {
            try {
                const prevMember = await message.guild.members.fetch(prevCapId);
                if (config.captain_role_id) await prevMember.roles.remove(config.captain_role_id);
                if (team.captain_discord_role_id) await prevMember.roles.remove(team.captain_discord_role_id);
            } catch (_) {}
        }
        teams[team.id].captain_id = targetId;
        data.saveTeams(teams);
        try {
            const member = await message.guild.members.fetch(targetId);
            if (config.captain_role_id) await member.roles.add(config.captain_role_id);
            if (team.captain_discord_role_id) await member.roles.add(team.captain_discord_role_id);
        } catch (_) {}
    }

    return { ok: true };
}

function buildRosterEmbed(team, members) {
    const posOrder = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];
    members.sort((a, b) => {
        if (a.team_type !== b.team_type) return a.team_type === 'Main' ? -1 : 1;
        return posOrder.indexOf(a.team_role) - posOrder.indexOf(b.team_role);
    });

    const mainLines = members
        .filter(p => p.team_type === 'Main')
        .map(p => `${posEmoji(p.team_role)} ${p.team_role} \u2014 <@${p.discord_id}>`);
    const subLines = members
        .filter(p => p.team_type === 'Substitute')
        .map(p => `\u25AA\uFE0F <@${p.discord_id}>`);

    const embed = new EmbedBuilder()
        .setTitle(`${team.name} [${team.short_name || '?'}] \u2014 Roster Created`)
        .setColor(0x57F287)
        .setTimestamp();

    if (team.captain_id) embed.addFields({ name: '\uD83D\uDC51 Captain', value: `<@${team.captain_id}>` });
    if (mainLines.length > 0) embed.addFields({ name: '\u2694\uFE0F Main Roster', value: mainLines.join('\n') });
    if (subLines.length > 0) embed.addFields({ name: '\uD83D\uDD39 Substitutes', value: subLines.join('\n') });
    const roles = [];
    if (team.discord_role_id) roles.push(`<@&${team.discord_role_id}>`);
    if (team.captain_discord_role_id) roles.push(`<@&${team.captain_discord_role_id}>`);
    if (team.sub_discord_role_id) roles.push(`<@&${team.sub_discord_role_id}>`);
    if (roles.length > 0) embed.addFields({ name: 'Roles', value: roles.join(' ') });

    return embed;
}

function posEmoji(pos) {
    const map = { Top: '\uD83D\uDEE1\uFE0F', Jungle: '\uD83C\uDF3F', Mid: '\u26A1', Bot: '\uD83C\uDFF9', Support: '\uD83D\uDC8A' };
    return map[pos] || '\u25AA\uFE0F';
}

module.exports = {
    name: 'setup',
    description: 'Configure the bot or create a team with its full roster in one command.',
    permission: 'EVERYONE',
    subcommands: [
        {
            name: 'server',
            description: 'Configure server-wide roles and channels (owner only)',
            options: [
                { name: 'admin_role',   description: 'Role for admins',         type: 'ROLE',    required: true },
                { name: 'captain_role', description: 'Server-wide captain role', type: 'ROLE',   required: true },
                { name: 'tryout_role',  description: 'Role for tryouts',        type: 'ROLE',    required: true },
                { name: 'scrim_channel', description: 'Channel for scrim requests', type: 'CHANNEL', required: true },
                { name: 'log_channel',   description: 'Channel for admin logs',     type: 'CHANNEL', required: true },
            ],
        },
        {
            name: 'team',
            description: 'Create a team with full roster in one command',
            options: [
                { name: 'name',       description: 'Team display name',                type: 'STRING', required: true },
                { name: 'short_name', description: 'Abbreviation (max 3 chars)',       type: 'STRING', required: false, max_length: 3 },
                { name: 'captain',    description: 'Team captain',                      type: 'USER',   required: true },
                { name: 'top',        description: 'Top lane starter',                  type: 'USER',   required: true },
                { name: 'jungle',     description: 'Jungle starter',                    type: 'USER',   required: true },
                { name: 'mid',        description: 'Mid lane starter',                  type: 'USER',   required: true },
                { name: 'bot',        description: 'Bot lane starter',                  type: 'USER',   required: true },
                { name: 'support',    description: 'Support starter',                   type: 'USER',   required: true },
                { name: 'sub1',       description: 'Substitute (optional)',             type: 'USER',   required: false },
                { name: 'sub2',       description: 'Substitute (optional)',             type: 'USER',   required: false },
            ],
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const permissions = extra.permissions;
        const interaction = extra.interaction;
        const subcommand  = interaction.options.getSubcommand();

        if (subcommand === 'server') {
            if (!permissions.isOwner(message.author.id)) {
                await message.channel.send({ content: 'Only the bot owner can run `/setup server`.' });
                return;
            }

            const adminRole   = interaction.options.getRole('admin_role');
            const captainRole = interaction.options.getRole('captain_role');
            const tryoutRole  = interaction.options.getRole('tryout_role');
            const scrimCh     = interaction.options.getChannel('scrim_channel');
            const logCh       = interaction.options.getChannel('log_channel');

            const config = data.getConfig();
            config.admin_role_id                 = adminRole.id;
            config.captain_role_id              = captainRole.id;
            config.tryout_role_id               = tryoutRole.id;
            config.scrim_channel_id             = scrimCh.id;
            config.log_channel_id               = logCh.id;
            data.saveConfig(config);

            const embed = new EmbedBuilder()
                .setTitle('\u2705 Server Configuration Saved')
                .setColor(0x57F287)
                .addFields(
                    { name: 'Admin',   value: `<@&${adminRole.id}>`,   inline: true },
                    { name: 'Captain', value: `<@&${captainRole.id}>`, inline: true },
                    { name: 'Tryout',  value: `<@&${tryoutRole.id}>`,  inline: true },
                    { name: 'Scrim Channel', value: `<#${scrimCh.id}>`, inline: true },
                    { name: 'Log Channel',   value: `<#${logCh.id}>`,   inline: true },
                )
                .setFooter({ text: 'Ready for /setup team to create teams.' })
                .setTimestamp();

            await message.channel.send({ embeds: [embed] });
            return;
        }

        // ── /setup team ───────────────────────────────────────────────────────
        if (!permissions.check('ADMIN', message.member, message.author.id)) {
            await message.channel.send({ content: 'Only admins can create teams.' });
            return;
        }

        const teamName  = interaction.options.getString('name').trim();
        const shortName = (interaction.options.getString('short_name') || '').trim().toUpperCase();

        if (!teamName) {
            await message.channel.send({ content: 'Team name cannot be empty.' });
            return;
        }
        if (shortName.length > 3) {
            await message.channel.send({ content: 'Short name must be at most 3 characters.' });
            return;
        }

        const captainUser = interaction.options.getUser('captain');
        const mainUsers = POSITIONS.map(pos => ({
            position: pos,
            user: interaction.options.getUser(pos.toLowerCase()),
        })).filter(p => p.user);

        const subUsers = [
            interaction.options.getUser('sub1'),
            interaction.options.getUser('sub2'),
        ].filter(Boolean);

        const allUsers = [captainUser, ...mainUsers.map(p => p.user), ...subUsers];
        const allUserIds = new Set(allUsers.map(u => u.id));
        if (allUserIds.size !== allUsers.length) {
            await message.channel.send({ content: 'Duplicate players detected. Each player can only be assigned once.' });
            return;
        }

        if (!allUserIds.has(captainUser.id)) {
            await message.channel.send({ content: 'The captain must be one of the team\'s players.' });
            return;
        }

        const teams = data.getTeams();
        if (Object.values(teams).find(t => t.name.toLowerCase() === teamName.toLowerCase())) {
            await message.channel.send({ content: `A team named **${teamName}** already exists.` });
            return;
        }

        const team_id = randomUUID();
        let discord_role_id         = '';
        let captain_discord_role_id = '';
        let sub_discord_role_id     = '';

        try {
            const role = await message.guild.roles.create({
                name: teamName,
                mentionable: true,
                reason: `Team role for ${teamName}`,
            });
            discord_role_id = role.id;
        } catch (err) {
            this.logger.warn(`[setup] Could not create main role for "${teamName}": ${err.message}`);
        }

        try {
            const capRole = await message.guild.roles.create({
                name: `${teamName} Captain`,
                color: 0xF1C40F,
                mentionable: true,
                reason: `Captain role for ${teamName}`,
            });
            captain_discord_role_id = capRole.id;
        } catch (err) {
            this.logger.warn(`[setup] Could not create captain role for "${teamName}": ${err.message}`);
        }

        try {
            const subRole = await message.guild.roles.create({
                name: `${teamName} Sub`,
                color: 0x95A5A6,
                mentionable: true,
                reason: `Substitute role for ${teamName}`,
            });
            sub_discord_role_id = subRole.id;
        } catch (err) {
            this.logger.warn(`[setup] Could not create sub role for "${teamName}": ${err.message}`);
        }

        const config = data.getConfig();
        if (!config.captain_role_id) {
            try {
                const capRole = await message.guild.roles.create({
                    name: 'Captain',
                    color: 0xF1C40F,
                    mentionable: true,
                    reason: 'Auto-created server-wide captain role for CADBot',
                });
                config.captain_role_id = capRole.id;
                data.saveConfig(config);
            } catch (err) {
                this.logger.warn('[setup] Could not auto-create server-wide captain role: ' + err.message);
            }
        }

        const team = {
            id:                      team_id,
            name:                    teamName,
            short_name:              shortName,
            discord_role_id,
            captain_discord_role_id,
            sub_discord_role_id,
            captain_id:              '',
            created_at:              new Date().toISOString(),
        };
        teams[team_id] = team;
        data.saveTeams(teams);

        const skipped = [];

        for (const mp of mainUsers) {
            const result = await assignPlayerToTeam(message, data, interaction, mp.user.id, team, mp.position, 'Main', mp.user.id === captainUser.id);
            if (!result.ok) skipped.push(result.reason);
        }

        for (const su of subUsers) {
            const result = await assignPlayerToTeam(message, data, interaction, su.id, team, 'Substitute', 'Substitute', false);
            if (!result.ok) skipped.push(result.reason);
        }

        const members = data.getTeamPlayers(team_id);
        const embed = buildRosterEmbed(team, members);

        if (skipped.length > 0) {
            embed.addFields({ name: '\u26A0\uFE0F Skipped', value: skipped.join('\n') });
        }

        await message.channel.send({ embeds: [embed] });
        this.logger.info(`[setup] ${message.author.id} created team "${teamName}" (${team_id}) with ${members.length} players, ${skipped.length} skipped`);
    },
};
