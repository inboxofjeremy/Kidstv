/**
 * build.js — Automated Stremio & Wako Kids Catalog
 * Discovery: TVMaze Schedule + Active Show Index (No Hardcoding)
 * Filtering: TMDB Kids/Children/Animation Genres
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY || TMDB_API_KEY.trim() === "") {
  console.error("\n❌ ERROR: TMDB_API_KEY environment variable is not defined or is empty!\n");
  process.exit(1);
}

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const DISCOVERY_DAYS_BACK = 14; 
const RETENTION_DAYS_BACK = 30; // 30-day retention keeps current seasons intact even with minor schedule lags

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
  if (!show.videos || show.videos.length === 0) return maxDate;
  
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

async function findTmdbId(show) {
  if (TMDB_ID_OVERRIDES[show.id]) return TMDB_ID_OVERRIDES[show.id];

  // 1. Strict Match via External IMDb ID
  if (show.externals?.imdb) {
    let rawImdb = String(show.externals.imdb).trim();
    if (rawImdb.length > 0) {
      const imdbId = rawImdb.startsWith('tt') ? rawImdb : `tt${rawImdb.padStart(7, '0')}`;
      const findRes = await fetchJSON(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
      );
      if (findRes?.tv_results?.length > 0) {
        return findRes.tv_results[0].id;
      }
    }
  }

  // 2. Strict Match via Exact Title Comparison
  const normalizeTitle = str => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  const cleanTitle = (show.name || "").replace(/\s*\(\d{4}\)\s*/g, "").trim();
  const targetNormalized = normalizeTitle(cleanTitle);

  const search = await fetchJSON(
    `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`
  );
  
  if (search?.results?.length > 0) {
    const exactMatch = search.results.find(r => 
      normalizeTitle(r.name) === targetNormalized || 
      normalizeTitle(r.original_name) === targetNormalized
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  return null;
}

async function getTmdbMetadata(tmdbId, country = "US") {
  if (!tmdbId) return null;
  
  const [details, ratingsData, externalIds] = await Promise.all([
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`)
  ]);

  if (!details) return null;

  const ratingObj = ratingsData?.results?.find(r => r.iso_3166_1 === country) || ratingsData?.results?.[0];
  
  return {
    details,
    certification: ratingObj ? ratingObj.rating : null,
    imdbId: externalIds?.imdb_id || null,
    genres: details.genres ? details.genres.map(g => g.name) : []
  };
}

function evaluateExclusion(showData, tmdbMeta) {
  const name = (showData.name || "").toLowerCase();

  // 1. Title Blocklist for adult programming, news, soap operas
  const blockedTitles = [
    "gma", "news", "hallmark", "dancing with the stars", "survivor", "masked singer", 
    "big brother", "bachelor", "love island", "masterchef", "voice", "kardashians",
    "young and the restless", "bold and the beautiful", "days of our lives", "general hospital"
  ];
  if (blockedTitles.some(title => name.includes(title))) {
    return { exclude: true, reason: `Excluded: Blocklisted title (${showData.name})` };
  }

  if (!tmdbMeta) {
    return { exclude: true, reason: "Excluded: Missing exact IMDb/Title match in TMDB" };
  }

  const { genres } = tmdbMeta;

  // 2. Automated Genre Gatekeeper: Must contain "kids", "children", or "animation"
  const hasValidGenre = (genres || []).some(g => {
    const genreLower = String(g).toLowerCase();
    return genreLower.includes("kids") || 
           genreLower.includes("children") || 
           
  });

  if (!hasValidGenre) {
    return { exclude: true, reason: `Excluded: Genre lacks kids/animation tags (Genres: ${genres.join(', ') || 'none'})` };
  }

  return { exclude: false, reason: `Passed genre check (Genres: ${genres.join(', ')})` };
}

async function build() {
  const activeShowIds = new Set();
  const targetCountries = ["US", "GB", "CA", "AU", "NZ"];
  
  console.log(`Pulling active schedule list from TVMaze...`);

  // 1. Daily Schedule Discovery
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

  // 2. Automatic Full Index Discovery (Catches non-daily or web-first kids shows)
  console.log(`Checking TVMaze Show Index pages for ongoing series...`);
  const indexShows = await fetchJSON(`https://api.tvmaze.com/shows?page=0`);
  if (Array.isArray(indexShows)) {
    indexShows.forEach(show => {
      if (show.status === "Running" || show.status === "In Development") {
        activeShowIds.add(show.id);
      }
    });
  }

  console.log(`Discovered ${activeShowIds.size} total shows. Filtering automatically via TMDB...`);

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData) continue;

    const tmdbId = await findTmdbId(showData);
    const tmdbMeta = await getTmdbMetadata(tmdbId);

    const audit = evaluateExclusion(showData, tmdbMeta);
    if (audit.exclude) {
      auditLogs.push({ name: showData.name, status: "DROPPED", detail: audit.reason });
      continue;
    }
    
    const imdbId = tmdbMeta?.imdbId || showData.externals?.imdb || null;
    let stremioId = (tmdbId ? `tmdb:${tmdbId}` : null) || (imdbId ? `imdb:${imdbId}` : `tvmaze:${showData.id}`);

    const mappedVideos = (showData._embedded?.episodes || [])
      .sort((a, b) => (a.season - b.season) || (a.number - b.number))
      .map(ep => ({
        released: ep.airdate || (ep.airstamp ? ep.airstamp.split('T')[0] : null),
        season: Number(ep.season || 1),
        episode: Number(ep.number || 0)
      }));

    const tmdbDetails = tmdbMeta.details;

    metas.push({
      id: stremioId,
      imdb_id: imdbId || undefined,
      tmdb_id: tmdbId || undefined,
      tvmazeId: showData.id,
      type: "series",
      name: tmdbDetails.name || showData.name,
      genres: tmdbMeta.genres,
      certification: tmdbMeta.certification || undefined,
      year: tmdbDetails.first_air_date ? tmdbDetails.first_air_date.split("-")[0] : (showData.premiered ? showData.premiered.split("-")[0] : undefined),
      description: tmdbDetails.overview || cleanHTML(showData.summary),
      poster: tmdbDetails.poster_path ? `https://image.tmdb.org/t/p/original${tmdbDetails.poster_path}` : (showData.image?.original || null),
      background: tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbDetails.backdrop_path}` : (showData.image?.original || null),
      videos: mappedVideos 
    });

    auditLogs.push({ name: showData.name, status: "KEPT", detail: audit.reason });
  }

  const todayStr = pacificDateString(new Date());
  const cutoffTarget = new Date();
  cutoffTarget.setDate(cutoffTarget.getDate() - RETENTION_DAYS_BACK);
  const cutoffStr = pacificDateString(cutoffTarget);

  const filteredMetas = metas.filter(show => {
    const latest = getLatestValidDate(show, todayStr);
    // If show is actively running on TVMaze, keep it even if TVMaze hasn't updated individual episode dates yet
    if (latest === "0000-00-00") return true; 
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
  console.log("            FULLY AUTOMATED KIDS CATALOG REPORT                                  ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${finalMetas.length} kids shows in the catalog.`);
}

build().catch(err => { console.error(err); process.exit(1); });
