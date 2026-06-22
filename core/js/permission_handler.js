'use strict';

/**
 * Permission tiers (lower number = higher authority).
 * Each command declares a required tier via its `permission` field.
 * The owner (hardcoded ID) bypasses all tier checks.
 */
const TIERS = {
    OWNER:    0,
    ADMIN:    1,
    CAPTAIN:  2,
    MEMBER:   3,
    TRYOUT:   4,
    EVERYONE: 5,
};

// Hardcoded owner Discord ID — always has full access.
const OWNER_ID = '185223223892377611';

class PermissionHandler {
    /**
     * @param {import('./data_manager.js')} data_manager
     */
    constructor(data_manager) {
        this.data = data_manager;
    }

    /**
     * Checks whether a guild member satisfies the required permission tier.
     *
     * @param {string} required   - One of: OWNER, ADMIN, CAPTAIN, MEMBER, TRYOUT, EVERYONE
     * @param {import('discord.js').GuildMember} member
     * @param {string} user_id    - The Discord user ID of the invoking user
     * @returns {boolean}
     */
    check(required, member, user_id) {
        if (!required || required === 'EVERYONE') return true;

        // Owner always passes.
        if (user_id === OWNER_ID) return true;

        const config = this.data.getConfig();

        switch (required.toUpperCase()) {
            case 'ADMIN':
                return this._hasRole(member, config.admin_role_id);

            case 'CAPTAIN':
                // Captains and admins both satisfy this tier.
                return (
                    this._hasRole(member, config.captain_role_id) ||
                    this._hasRole(member, config.admin_role_id)
                );

            case 'MEMBER': {
                // Any team member (has their team's role, or a direct team assignment), plus captains and admins.
                const player = this.data.getPlayer(user_id);
                const isOnTeam = !!(player && player.team_id);
                return (
                    isOnTeam ||
                    this._hasRole(member, config.admin_role_id) ||
                    this._hasRole(member, config.captain_role_id)
                );
            }

            case 'TRYOUT':
                // Tryouts, plus all higher tiers.
                return (
                    this._hasRole(member, config.tryout_role_id) ||
                    this._hasRole(member, config.captain_role_id) ||
                    this._hasRole(member, config.admin_role_id)
                );

            default:
                return false;
        }
    }

    /**
     * Returns true if the member has the given role ID (non-empty string check).
     * @param {import('discord.js').GuildMember} member
     * @param {string} role_id
     * @returns {boolean}
     */
    _hasRole(member, role_id) {
        if (!role_id || !member || !member.roles) return false;
        const roles = member.roles;
        // GuildMember → roles.cache (Collection with .has)
        if (roles.cache && typeof roles.cache.has === 'function') {
            return roles.cache.has(role_id);
        }
        // Raw API interaction member → roles is an array of role ID strings
        if (Array.isArray(roles)) {
            return roles.includes(role_id);
        }
        return false;
    }

    /**
     * Convenience: returns whether a user is the hardcoded owner.
     * @param {string} user_id
     */
    isOwner(user_id) {
        return user_id === OWNER_ID;
    }

    getTier(member, user_id) {
        if (user_id === OWNER_ID) return 'OWNER';
        const config = this.data.getConfig();
        if (this._hasRole(member, config.admin_role_id)) return 'ADMIN';
        if (this._hasRole(member, config.captain_role_id)) return 'CAPTAIN';
        const player = this.data.getPlayer(user_id);
        if (player && player.team_id) return 'MEMBER';
        if (this._hasRole(member, config.tryout_role_id)) return 'TRYOUT';
        return 'EVERYONE';
    }
}

module.exports = PermissionHandler;
