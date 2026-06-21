module.exports = {
    name: 'ping',
    description: 'Check if CADBot is online and responsive.',
    permission: 'EVERYONE',
    num_args: 0,
    options: [],
    async execute(message, args, extra) {
        await message.channel.send({ content: 'Pong! CADBot is online.' });
    },
};
