'use strict';

/**
 * Adapts a Discord.js ChatInputCommandInteraction to a message-like interface
 * so that command execute(message, args, extra) functions work identically for
 * both slash commands and any future prefix commands.
 *
 * Key mappings:
 *   message.author            → interaction.user
 *   message.member            → interaction.member
 *   message.guild             → interaction.guild
 *   message.channel.id        → interaction.channelId
 *   message.channel.send()    → interaction.editReply() / followUp()
 *   message.mentions.users.first()   → first USER-type option user
 *   message.mentions.members.first() → first USER-type option member
 */
class InteractionAdapter {
    /**
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     * @param {import('discord.js').User|null} firstUser
     * @param {import('discord.js').GuildMember|null} firstMember
     * @param {import('winston').Logger} logger
     */
    constructor(interaction, firstUser, firstMember, logger) {
        this._interaction          = interaction;
        this._firstUser            = firstUser  || null;
        this._firstMember          = firstMember || null;
        this._logger               = logger;
        this._hasEditedDeferredReply = false;

        this.author  = interaction.user;
        this.member  = interaction.member;
        this.guild   = interaction.guild;

        const self = this;
        this.channel = {
            id:    interaction.channelId,
            guild: interaction.guild,
            send:  async (payload) => self._respond(payload),
        };

        this.mentions = {
            users:   { first: () => this._firstUser   },
            members: { first: () => this._firstMember },
        };
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    async _respond(payload) {
        if (typeof payload === 'string') payload = { content: payload };
        try {
            if (this._interaction.replied) {
                return await this._interaction.followUp(payload);
            } else if (this._interaction.deferred) {
                if (!this._hasEditedDeferredReply) {
                    this._hasEditedDeferredReply = true;
                    return await this._interaction.editReply(payload);
                } else {
                    return await this._interaction.followUp(payload);
                }
            } else {
                return await this._interaction.reply(payload);
            }
        } catch (err) {
            if (this._logger) this._logger.error('[InteractionAdapter] _respond error: ' + err.message);
            try { return await this._interaction.followUp(payload); } catch (_) {}
        }
    }

    // ── Public message-like API ───────────────────────────────────────────────

    async reply(payload) {
        if (typeof payload === 'string') payload = { content: payload };
        return this._respond(payload);
    }

    async delete() {
        // No-op: slash interactions cannot be deleted this way.
    }
}

module.exports = InteractionAdapter;
