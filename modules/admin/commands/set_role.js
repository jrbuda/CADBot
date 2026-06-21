'use strict';

const ROLE_TYPES = ['admin', 'captain', 'tryout'];

module.exports = {
    name: 'set_role',
    description: 'Link a Discord role to an admin, captain, or tryout tier.',
    permission: 'ADMIN',
    ephemeral: true,
    options: [
        {
            name: 'type',
            description: 'Which permission tier to assign this role to',
            type: 'STRING',
            required: true,
            choices: ROLE_TYPES.map(t => ({ name: t.charAt(0).toUpperCase() + t.slice(1), value: t })),
        },
        {
            name: 'role',
            description: 'The Discord role to assign',
            type: 'ROLE',
            required: true,
        },
    ],

    async execute(message, args, extra) {
        const data        = extra.data;
        const interaction = extra.interaction;

        const type = interaction.options.getString('type');
        const role = interaction.options.getRole('role');

        const config = data.getConfig();
        config[type + '_role_id'] = role.id;
        data.saveConfig(config);

        await message.channel.send({
            content: `The **${type}** role has been set to <@&${role.id}>.`,
        });
        this.logger.info(`[set_role] ${type}_role_id set to ${role.id}`);
    },
};
