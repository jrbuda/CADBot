'use strict';
const axios = require('axios');

const REGION     = process.env.RIOT_REGION            || 'na1';
const ROUTING    = process.env.RIOT_REGIONAL_ROUTING  || 'americas';
const API_KEY    = () => process.env.RIOT_API_KEY;

const PLATFORM_BASE  = `https://${REGION}.api.riotgames.com`;
const REGIONAL_BASE  = `https://${ROUTING}.api.riotgames.com`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function riotGet(url, logger) {
    try {
        const res = await axios.get(url, {
            headers: { 'X-Riot-Token': API_KEY() },
            timeout: 10000,
        });
        return res.data;
    } catch (err) {
        if (err.response?.status === 429) {
            const retryAfter = parseInt(err.response.headers['retry-after'] || '1', 10) * 1000;
            logger?.info(`[riot_api] 429 on ${url}, retrying in ${retryAfter}ms`);
            await sleep(retryAfter);
            return riotGet(url, logger);
        }
        throw err;
    }
}

/**
 * Fetches account data by Riot ID (gameName#tagLine).
 * Endpoint: GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}
 */
async function getAccountByRiotId(gameName, tagLine, logger) {
    const url = `${REGIONAL_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    return riotGet(url, logger);
}

/**
 * Fetches summoner data by PUUID.
 * Endpoint: GET /lol/summoner/v4/summoners/by-puuid/{encryptedPUUID}
 */
async function getSummonerByPuuid(puuid, logger) {
    const url = `${PLATFORM_BASE}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
    return riotGet(url, logger);
}

/**
 * Fetches ranked stats for a summoner by summoner ID.
 * Endpoint: GET /lol/league/v4/entries/by-summoner/{encryptedSummonerId}
 * @deprecated Riot has deprecated this endpoint (returns 403). Use getRankedStatsByPuuid instead.
 */
async function getRankedStats(summoner_id, logger) {
    const url = `${PLATFORM_BASE}/lol/league/v4/entries/by-summoner/${encodeURIComponent(summoner_id)}`;
    return riotGet(url, logger);
}

/**
 * Fetches ranked stats for a summoner by PUUID.
 * Endpoint: GET /lol/league/v4/entries/by-puuid/{encryptedPUUID}
 */
async function getRankedStatsByPuuid(puuid, logger) {
    const url = `${PLATFORM_BASE}/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
    return riotGet(url, logger);
}

/**
 * Looks up a full player profile from a Riot ID string ("GameName#TAG").
 * Returns both the account data and summoner data.
 *
 * @param {string} riotId  - "GameName#TAG"
 * @returns {Promise<{ account: Object, summoner: Object }>}
 */
async function lookupRiotId(riotId, logger) {
    const lastHash = riotId.lastIndexOf('#');
    if (lastHash === -1) throw new Error('Invalid Riot ID format. Expected "GameName#TAG".');

    const gameName = riotId.substring(0, lastHash);
    const tagLine  = riotId.substring(lastHash + 1);
    const account  = await getAccountByRiotId(gameName.trim(), tagLine.trim(), logger);
    const summoner = await getSummonerByPuuid(account.puuid, logger);
    return { account, summoner };
}

module.exports = {
    lookupRiotId,
    getAccountByRiotId,
    getSummonerByPuuid,
    getRankedStats,
    getRankedStatsByPuuid,
    REGION,
    ROUTING,
};
