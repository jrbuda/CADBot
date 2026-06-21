'use strict';
const axios = require('axios');

const REGION     = process.env.RIOT_REGION            || 'na1';
const ROUTING    = process.env.RIOT_REGIONAL_ROUTING  || 'americas';
const API_KEY    = () => process.env.RIOT_API_KEY;

const PLATFORM_BASE  = `https://${REGION}.api.riotgames.com`;
const REGIONAL_BASE  = `https://${ROUTING}.api.riotgames.com`;

/**
 * Fetches account data by Riot ID (gameName#tagLine).
 * Endpoint: GET /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}
 *
 * @param {string} gameName
 * @param {string} tagLine
 * @returns {Promise<{ puuid: string, gameName: string, tagLine: string }>}
 */
async function getAccountByRiotId(gameName, tagLine) {
    const url = `${REGIONAL_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const res = await axios.get(url, { headers: { 'X-Riot-Token': API_KEY() } });
    return res.data;
}

/**
 * Fetches summoner data by PUUID.
 * Endpoint: GET /lol/summoner/v4/summoners/by-puuid/{encryptedPUUID}
 *
 * @param {string} puuid
 * @returns {Promise<{ id: string, accountId: string, puuid: string, name: string, profileIconId: number, revisionDate: number, summonerLevel: number }>}
 */
async function getSummonerByPuuid(puuid) {
    const url = `${PLATFORM_BASE}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
    const res = await axios.get(url, { headers: { 'X-Riot-Token': API_KEY() } });
    return res.data;
}

/**
 * Fetches ranked stats for a summoner by summoner ID.
 * Endpoint: GET /lol/league/v4/entries/by-summoner/{encryptedSummonerId}
 *
 * @param {string} summoner_id
 * @returns {Promise<Array>}
 */
async function getRankedStats(summoner_id) {
    const url = `${PLATFORM_BASE}/lol/league/v4/entries/by-summoner/${encodeURIComponent(summoner_id)}`;
    const res = await axios.get(url, { headers: { 'X-Riot-Token': API_KEY() } });
    return res.data;
}

/**
 * Looks up a full player profile from a Riot ID string ("GameName#TAG").
 * Returns both the account data and summoner data.
 *
 * @param {string} riotId  - "GameName#TAG"
 * @returns {Promise<{ account: Object, summoner: Object }>}
 */
async function lookupRiotId(riotId) {
    const parts = riotId.split('#');
    if (parts.length !== 2) throw new Error('Invalid Riot ID format. Expected "GameName#TAG".');

    const [gameName, tagLine] = parts;
    const account  = await getAccountByRiotId(gameName.trim(), tagLine.trim());
    const summoner = await getSummonerByPuuid(account.puuid);
    return { account, summoner };
}

module.exports = {
    lookupRiotId,
    getAccountByRiotId,
    getSummonerByPuuid,
    getRankedStats,
    REGION,
    ROUTING,
};
