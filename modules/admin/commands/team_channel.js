'use strict';
const { ChannelType } = require('discord.js');

module.exports = {
    name: 'team_channel',
    description: 'Set the game post channel for your team.',
    permission: 'CAPTAIN',
    ephemeral: true,
    options: [
        {
            name: 'channel',
            description: 'Text channel where /game session posts will appear',
            type: 'CHANNEL',
            required: true,
        },
        {
            name: 'team',
            description: 'Team to configure (admins only — captains default to their own team)',
            type: 'STRING',
            required: false,
            autocomplete: true,
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
        const permissions = extra.permissions;
        const interaction = extra.interaction;

        const channel = interaction.options.getChannel('channel');
        let   team_id = interaction.options.getString('team') || null;

        if (channel.type !== ChannelType.GuildText) {
            await message.channel.send({ content: 'Please select a text channel.' });
            return;
        }

        // Resolve team: captains default to their own
        if (!team_id) {
            const captainTeam = data.getTeamByCaptain(message.author.id);
            if (!captainTeam) {
                await message.channel.send({ content: 'You are not set as a captain of any team. Admins must specify a `team`.' });
                return;
            }
            team_id = captainTeam.id;
        }

        // Captains can only configure their own team
        if (!permissions.check('ADMIN', message.member, message.author.id)) {
            const captainTeam = data.getTeamByCaptain(message.author.id);
            if (!captainTeam || captainTeam.id !== team_id) {
                await message.channel.send({ content: 'You can only configure channels for your own team.' });
                return;
            }
        }

        const team = data.getTeam(team_id);
        if (!team) {
            await message.channel.send({ content: 'Team not found.' });
            return;
        }

        const teams = data.getTeams();
        if (!teams[team_id].channels) teams[team_id].channels = {};
        teams[team_id].channels.game = channel.id;
        data.saveTeams(teams);

        await message.channel.send({
            content: `**${team.name}**'s game session channel has been set to <#${channel.id}>.\nAll \`/game create\` posts for this team will appear there.`,
        });
        this.logger.info(`[team_channel] ${team.name} game channel set to ${channel.id} by ${message.author.id}`);
    },
};
