/**
 * build.js — Stremio & Wako Kids Weekly Schedule Static Catalog (Strict Whitelist without Keyword Lists)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const CATALOG_DIR = path.join(__dirname, "catalog", "kids_series");
const DISCOVERY_DAYS_BACK = 12; 
const RETENTION_DAYS_BACK = 9;

const TMDB_ID_OVERRIDES = {};
const TVMAZE_DELAY_MS = 250; 
let lastTvmazeCall = 0;

const auditLogs = [];

async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(0, TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall));
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastTvmazeCall = Date.now();
    }
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function getLatestValidDate(show, todayStr) {
  let maxDate = "0000-00-00";
  if (!show.videos) return maxDate;
  
  for (let i = 0; i < show.videos.length; i++) {
    const d = show.videos[i].released;
    if (d && typeof d === 'string' && d.includes('-') && d <= todayStr) {
      if (d > maxDate) {
        maxDate = d;
      }
    }
  }
  return maxDate;
}

async function getTmdbCertification(tmdbId, country = "US") {
  if (!tmdbId) return null;
  const data = await fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?api_key=${TMDB_API_KEY}`);
  if (!data?.results) return null;

  const ratingObj = data.results.find(r => r.iso_3166_1 === country) || data.results[0];
  return ratingObj ? ratingObj.rating : null;
}

function evaluateExclusion(show, certification) {
  const name = (show.name || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const webChannel = (show.webChannel?.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();

  // 1. Hard block obvious adult networks or terms if they leak in
  const blockedTerms = ["news", "sport", "pga", "nfl", "ufc", "wwe", "aew", "housewives", "kardashians", "bachelor", "survivor", "dancing with the stars"];
  if (blockedTerms.some(term => name.includes(term) || network.includes(term))) {
    return { exclude: true, reason: "Blocked: Matched adult/news/sports keyword" };
  }

  // 2. Enforce certification limits if present
  const allowedCertifications = ["TV-Y", "TV-Y7", "TV-G", "G"];
  const blockedCertifications = ["TV-14", "TV-MA", "R", "NC-17", "TV-PG", "PG"];

  if (certification) {
    const certUpper = certification.toUpperCase();
    if (blockedCertifications.includes(certUpper)) {
      return { exclude: true, reason: `Blocked Certification (${certification})` };
    }
  }

  // 3. Kids Networks Whitelist & Animation/Family Genre Checks
  const kidsNetworks = [
    "disney channel", "disney junior", "disney+", "nickelodeon", "nick jr", 
    "cartoon network", "cbeebies", "cbbc", "pbs kids", "netflix", "apple tv+"
  ];

  const hasKidsNetwork = kidsNetworks.some(net => network.includes(net) || webChannel.includes(net));
  const hasAnimationGenre = genres.includes("animation") || genres.includes("children") || genres.includes("family");
  const hasSafeCert = certification && allowedCertifications.includes(certification.toUpperCase());

  // A show must belong to a kids network, OR have a certified Y/Y7/G rating combined with an animation/children/family genre.
  if (!hasKidsNetwork && !(hasAnimationGenre && hasSafeCert)) {
    return { exclude: true, reason: "Excluded: Failed strict kids validation whitelist" };
  }

  return { exclude: false, reason: "Passed strict kids verification" };
}

async function findTmdbId(show) {
  if (TMDB_ID_OVERRIDES[show.id]) return TMDB_ID_OVERRIDES[show.id];

  const normalizeTitle = str => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  const targetNormalized = normalizeTitle(show.name);
  
  const search = await fetchJSON(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(show.name)}`);
  if (!search?.results?.length) return null;

  const matchingResults = search.results.filter(r => normalizeTitle(r.name) === targetNormalized);
  return matchingResults.length > 0 ? matchingResults[0].id : search.results[0].id;
}

async function getImdbId(showData, tmdbId) {
  if (showData.externals?.imdb) return showData.externals.imdb;
  if (tmdbId) {
    const ext = await fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
    if (ext?.imdb_id) return ext.imdb_id;
  }
  return null;
}

async function build() {
  const activeShowIds = new Set();
  const targetCountries = ["US", "GB", "CA", "AU", "NZ"];
  
  console.log(`Starting strict kids schedule analysis...`);

  for (let i = 0; i < DISCOVERY_DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    
    for (const country of targetCountries) {
      const broadcastList = await fetchJSON(`https://api.tvmaze.com/schedule?country=${country}&date=${dateStr}`);
      if (Array.isArray(broadcastList)) {
        broadcastList.forEach(ep => {
          const show = ep.show || (ep._embedded && ep._embedded.show);
          if (show?.id) activeShowIds.add(show.id);
        });
      }
    }
  }

  console.log(`Processing metadata mappings for ${activeShowIds.size} shows...`);

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData) continue;

    const tmdbId = await findTmdbId(showData);
    const certification = await getTmdbCertification(tmdbId);

    const audit = evaluateExclusion(showData, certification);
    if (audit.exclude) {
      auditLogs.push({ name: showData.name, type: showData.type, status: "DROPPED", detail: audit.reason });
      continue;
    }
    
    const imdbId = await getImdbId(showData, tmdbId);
    let stremioId = (tmdbId ? `tmdb:${tmdbId}` : null) || imdbId || `tvmaze:${showData.id}`;

    const mappedVideos = (showData._embedded?.episodes || [])
      .sort((a, b) => (a.season - b.season) || (a.number - b.number))
      .map(ep => ({
        released: ep.airdate || (ep.airstamp ? ep.airstamp.split('T')[0] : null),
        season: Number(ep.season || 1),
        episode: Number(ep.number || 0)
      }));

    metas.push({
      id: stremioId,
      imdb_id: imdbId || undefined,
      tmdb_id: tmdbId || undefined,
      tvmazeId: showData.id,
      type: "series",
      name: showData.name,
      genres: showData.genres || [],
      certification: certification || undefined,
      year: showData.premiered ? showData.premiered.split("-")[0] : undefined,
      description: cleanHTML(showData.summary),
      poster: showData.image?.original || showData.image?.medium || null,
      background: showData.image?.original || null,
      videos: mappedVideos 
    });
  }

  const todayStr = pacificDateString(new Date());
  const cutoffTarget = new Date();
  cutoffTarget.setDate(cutoffTarget.getDate() - RETENTION_DAYS_BACK);
  const cutoffStr = pacificDateString(cutoffTarget);

  const filteredMetas = metas.filter(show => {
    const latest = getLatestValidDate(show, todayStr);
    return latest >= cutoffStr && latest <= todayStr;
  });

  const uniqueMetasMap = new Map();
  filteredMetas.forEach(show => {
    if (uniqueMetasMap.has(show.id)) show.id = `tvmaze-fallback:${show.tvmazeId}`;
    uniqueMetasMap.set(show.id, show);
  });

  const finalMetas = Array.from(uniqueMetasMap.values());
  finalMetas.sort((a, b) => getLatestValidDate(b, todayStr).localeCompare(getLatestValidDate(a, todayStr)));

  finalMetas.forEach(show => { delete show.videos; });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, "tvmaze_kids_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas: finalMetas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            STRICT KIDS PIPELINE REPORT                                         ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
}

build().catch(err => { console.error(err); process.exit(1); });
