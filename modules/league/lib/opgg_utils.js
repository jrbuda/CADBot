'use strict';

function toOpggName(gameName, tagLine, region) {
    return encodeURIComponent((gameName || '').trim() + '-' + (tagLine || region || 'NA').trim());
}

function opggRegionSlug() {
    return (process.env.RIOT_REGION || 'na1').toLowerCase().replace(/\d+$/, '') || 'na';
}

function buildPlayerOpggUrl(riot_id) {
    const [gameName, tagLine] = (riot_id || '').split('#');
    const region = opggRegionSlug();
    const slug = toOpggName(gameName, tagLine, region.toUpperCase());
    return `https://www.op.gg/summoners/${region}/${slug}`;
}

function buildTeamOpggUrl(teamPlayers) {
    const region = opggRegionSlug();
    const summoners = teamPlayers
        .filter(p => p.riot_id)
        .map(p => {
            const [gn, tl] = p.riot_id.split('#');
            return toOpggName(gn, tl, region.toUpperCase());
        })
        .join('%2C');
    if (!summoners) return null;
    return `https://www.op.gg/multisearch/${region}?summoners=${summoners}`;
}

module.exports = {
    toOpggName,
    opggRegionSlug,
    buildPlayerOpggUrl,
    buildTeamOpggUrl,
};
