/**
 * build.js — Stremio & Wako Kids Weekly Schedule (TVMaze Schedule + TMDB Certification Filtering)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
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

/**
 * Fetch TMDB certification and genres. We rely strictly on TMDB for age certificates.
 */
async function getTmdbDetails(tmdbId, country = "US") {
  if (!tmdbId) return { certification: null, genres: [] };
  
  const [details, ratingsData] = await Promise.all([
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?api_key=${TMDB_API_KEY}`)
  ]);

  const ratingObj = ratingsData?.results?.find(r => r.iso_3166_1 === country) || ratingsData?.results?.[0];
  const certification = ratingObj ? ratingObj.rating : null;
  const genres = details?.genres ? details.genres.map(g => g.name.toLowerCase()) : [];

  return { certification, genres };
}

function evaluateExclusion(show, tmdbData) {
  const name = (show.name || "").toLowerCase();
  const { certification } = tmdbData;

  // 1. Hard block obvious adult/news/talk/reality franchises that might slip through
  const blockedTitles = [
    "gma", "news", "hallmark", "heartland", "simpsons", "georgie & mandy", 
    "young and the restless", "bold and the beautiful", "days of our lives", 
    "general hospital", "dancing with the stars", "survivor", "masked singer", 
    "big brother", "bachelor", "love island", "masterchef", "voice", "kardashians"
  ];
  if (blockedTitles.some(title => name.includes(title))) {
    return { exclude: true, reason: `Excluded by title blocklist (${show.name})` };
  }

  // 2. STENCT CERTIFICATION CHECK: Must have a valid child-friendly TMDB certificate
  const allowedCertifications = ["TV-Y", "TV-Y7", "TV-G", "G"];
  
  if (!certification) {
    return { exclude: true, reason: "Excluded: Missing TMDB age certification" };
  }

  const certUpper = certification.toUpperCase();
  if (!allowedCertifications.includes(certUpper)) {
    return { exclude: true, reason: `Excluded: Certification '${certification}' is not TV-Y, TV-Y7, TV-G, or G` };
  }

  return { exclude: false, reason: `Passed TMDB certification check: ${certUpper}` };
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
  
  console.log(`Pulling schedule from TVMaze API...`);

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

    const webList = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${dateStr}`);
    if (Array.isArray(webList)) {
      webList.forEach(ep => {
        const show = ep.show || (ep._embedded && ep._embedded.show);
        if (show?.id) activeShowIds.add(show.id);
      });
    }
  }

  console.log(`Processing metadata mappings for ${activeShowIds.size} shows using TMDB certifications...`);

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData) continue;

    // Pull TMDB ID and evaluate strictly using TMDB content ratings
    const tmdbId = await findTmdbId(showData);
    const tmdbData = await getTmdbDetails(tmdbId);

    const audit = evaluateExclusion(showData, tmdbData);
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
      genres: tmdbData.genres.length > 0 ? tmdbData.genres : showData.genres,
      certification: tmdbData.certification,
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
  console.log("            TVMAZE SCHEDULE + STRICT TMDB CERTIFICATION REPORT                  ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
}

build().catch(err => { console.error(err); process.exit(1); });
