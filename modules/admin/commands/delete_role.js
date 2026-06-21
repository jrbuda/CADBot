'use strict';

module.exports = {
    name: 'delete_role',
    description: 'Delete a Discord role from this server.',
    permission: 'ADMIN',
    num_args: 0,
    options: [
        {
            name: 'role',
            description: 'The role to delete',
            type: 'ROLE',
            required: true,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;
        const role        = interaction.options.getRole('role');

        // Refuse to delete any role currently configured as admin / captain / tryout
        const config        = data.getConfig();
        const protected_ids = [
            config.admin_role_id,
            config.captain_role_id,
            config.tryout_role_id,
        ].filter(Boolean);

        if (protected_ids.includes(role.id)) {
            await message.channel.send({
                content: `Cannot delete <@&${role.id}> — it is currently assigned as a configured bot role (admin, captain, or tryout).\nUse \`/set_role\` to reassign that tier to a different role first.`,
            });
            return;
        }

        // Also refuse to delete any team's linked role
        const teams = data.getTeams();
        const linkedTeam = Object.values(teams).find(t => t.discord_role_id === role.id);
        if (linkedTeam) {
            await message.channel.send({
                content: `Cannot delete <@&${role.id}> — it is linked to team **${linkedTeam.name}**.\nUse \`/create_team\` or edit the team to reassign the role first.`,
            });
            return;
        }

        const roleName = role.name;
        try {
            await role.delete(`Deleted by ${message.author.tag} via /delete_role`);
            await message.channel.send({ content: `Role **${roleName}** has been deleted.` });
            this.logger.info(`[delete_role] ${message.author.id} deleted role "${roleName}" (${role.id})`);
        } catch (err) {
            this.logger.error('[delete_role] ' + err.message);
            await message.channel.send({ content: `Failed to delete role: ${err.message}` });
        }
    },
};
