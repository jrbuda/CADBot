'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { toOpggName, opggRegionSlug, buildPlayerOpggUrl, buildTeamOpggUrl } = require('../modules/league/lib/opgg_utils.js');

describe('opggRegionSlug', () => {
    it('returns the region slug', () => {
        const slug = opggRegionSlug();
        assert.ok(typeof slug === 'string' && slug.length >= 2);
    });
});

describe('toOpggName', () => {
    it('encodes a gameName and tagLine', () => {
        const result = toOpggName('Hide on bush', 'NA1', 'NA');
        assert.ok(result.includes('Hide%20on%20bush-NA1'));
    });

    it('handles empty tagLine by using region fallback', () => {
        const result = toOpggName('Player', '', 'KR');
        assert.ok(result.includes('Player-KR'));
    });

    it('handles special characters', () => {
        const result = toOpggName('T1 Keria', 'KR1', 'KR');
        assert.ok(result.includes('T1%20Keria-KR1'));
    });
});

describe('buildPlayerOpggUrl', () => {
    it('builds a valid op.gg summoner URL', () => {
        const url = buildPlayerOpggUrl('Hide on bush#NA1');
        assert.ok(url.startsWith('https://www.op.gg/summoners/'));
        assert.ok(url.includes('Hide%20on%20bush-NA1'));
    });

    it('returns a URL for a riot_id without a tag', () => {
        const url = buildPlayerOpggUrl('Player');
        assert.ok(url.startsWith('https://www.op.gg/summoners/'));
    });
});

describe('buildTeamOpggUrl', () => {
    it('builds a multi-search URL for multiple players', () => {
        const players = [
            { riot_id: 'Hide on bush#NA1' },
            { riot_id: 'Gumayusi#KR1' },
        ];
        const url = buildTeamOpggUrl(players);
        assert.ok(url.startsWith('https://www.op.gg/multisearch/'));
        assert.ok(url.includes('%2C'));
    });

    it('returns null for empty players', () => {
        assert.strictEqual(buildTeamOpggUrl([]), null);
    });

    it('filters out players without riot_id', () => {
        const players = [
            { riot_id: 'Faker#KR1' },
            { name: 'no riot id' },
        ];
        const url = buildTeamOpggUrl(players);
        assert.ok(url.includes('Faker-KR1'));
        assert.ok(!url.includes('%2C')); // only one player
    });
});
