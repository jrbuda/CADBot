'use strict';

module.exports = {
    name: 'create_role',
    description: 'Create a new Discord role in this server.',
    permission: 'ADMIN',
    num_args: 0,
    options: [
        {
            name: 'name',
            description: 'Name of the role to create',
            type: 'STRING',
            required: true,
        },
        {
            name: 'color',
            description: 'Hex color code for the role (e.g. #FF5733)',
            type: 'STRING',
            required: false,
        },
        {
            name: 'hoist',
            description: 'Display the role separately in the member list',
            type: 'BOOLEAN',
            required: false,
        },
        {
            name: 'mentionable',
            description: 'Allow anyone to @mention this role',
            type: 'BOOLEAN',
            required: false,
        },
    ],

    async execute(message, args, extra) {
        const interaction = extra.interaction;

        const name        = interaction.options.getString('name').trim();
        const colorInput  = interaction.options.getString('color');
        const hoist       = interaction.options.getBoolean('hoist')       ?? false;
        const mentionable = interaction.options.getBoolean('mentionable') ?? false;

        // Parse color
        let color = null;
        if (colorInput) {
            const hex = colorInput.replace('#', '');
            const parsed = parseInt(hex, 16);
            if (!isNaN(parsed)) color = parsed;
        }

        try {
            const role = await message.guild.roles.create({
                name,
                colors:      color ? [color] : undefined,
                hoist,
                mentionable,
                reason:      `Created by ${message.author.tag} via /create_role`,
            });

            await message.channel.send({
                content: `Role **${role.name}** created! ID: \`${role.id}\`\nUse \`/set_role\` to configure it as an admin, captain, or tryout role.`,
            });
            this.logger.info(`[create_role] ${message.author.id} created role "${name}" (${role.id})`);
        } catch (err) {
            this.logger.error('[create_role] ' + err.message);
            await message.channel.send({ content: 'Failed to create role: ' + err.message });
        }
    },
};
