/**
 * build.js — TMDB Daily Kids Discover (9-Day Window)
 * Generates static JSON for GitHub Pages directly from TMDB air dates.
 * Strictly filters for English-language kids content.
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
const RETENTION_DAYS_BACK = 90;
const TMDB_KIDS_GENRE_ID = "10762"; // TMDB Official Genre ID for 'Kids'

const auditLogs = [];

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
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
    genres: details.genres ? details.genres.map(g => g.name) : [],
    originalLanguage: details.original_language
  };
}

function evaluateExclusion(showName, tmdbMeta) {
  const name = (showName || "").toLowerCase();

  // 1. Language Check: Strictly enforce English original language
  if (tmdbMeta.originalLanguage && tmdbMeta.originalLanguage !== "en") {
    return { exclude: true, reason: `Excluded: Non-English original language ('${tmdbMeta.originalLanguage}')` };
  }

  // 2. Non-Latin / Foreign Character Check (e.g., Chinese, Japanese, Korean, Cyrillic)
  const nonEnglishCharRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/;
  if (nonEnglishCharRegex.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script/characters (${showName})` };
  }

  // 3. Core Title Blocklist
  const blockedTitles = [
    "gma", "news", "hallmark", "dancing with the stars", "survivor", "masked singer", 
    "big brother", "bachelor", "love island", "masterchef", "voice", "kardashians",
    "young and the restless", "bold and the beautiful", "days of our lives", "general hospital"
  ];
  if (blockedTitles.some(title => name.includes(title))) {
    return { exclude: true, reason: `Excluded: Blocklisted title (${showName})` };
  }

  // 4. Genre Check for Kids / Children
  const genres = tmdbMeta.genres || [];
  const hasValidGenre = genres.some(g => {
    const genreLower = String(g).toLowerCase();
    return genreLower.includes("kids") || genreLower.includes("children");
  });

  if (!hasValidGenre) {
    return { exclude: true, reason: `Excluded: Lacks 'kids' or 'children' genre (Genres: ${genres.join(', ') || 'none'})` };
  }

  return { exclude: false, reason: `Passed kids genre & language check` };
}

async function build() {
  const discoveredShows = new Map(); // tmdbId -> latestAirDate

  console.log(`Discovering English kids shows from TMDB for the past ${RETENTION_DAYS_BACK} days...`);

  // Query TMDB Discover for each day, filtered by Kids genre (10762) AND English language (with_original_language=en)
  for (let i = 0; i < RETENTION_DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);

    const discoverUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&air_date.gte=${dateStr}&air_date.lte=${dateStr}&with_genres=${TMDB_KIDS_GENRE_ID}&with_original_language=en&sort_by=popularity.desc`;
    const data = await fetchJSON(discoverUrl);

    if (data?.results) {
      for (const show of data.results) {
        if (!discoveredShows.has(show.id)) {
          discoveredShows.set(show.id, dateStr);
        }
      }
    }
  }

  console.log(`Discovered ${discoveredShows.size} unique English kids shows airing in the last 9 days. Processing metadata...`);

  const metas = [];
  for (const [tmdbId, latestAirDate] of discoveredShows.entries()) {
    const tmdbMeta = await getTmdbMetadata(tmdbId);
    if (!tmdbMeta) continue;

    const showName = tmdbMeta.details.name;
    const audit = evaluateExclusion(showName, tmdbMeta);
    
    if (audit.exclude) {
      auditLogs.push({ name: showName, status: "DROPPED", detail: audit.reason });
      continue;
    }
    
    const imdbId = tmdbMeta.imdbId || null;
    const stremioId = `tmdb:${tmdbId}`;
    const tmdbDetails = tmdbMeta.details;

    metas.push({
      id: stremioId,
      imdb_id: imdbId || undefined,
      tmdb_id: tmdbId,
      type: "series",
      name: showName,
      genres: tmdbMeta.genres,
      certification: tmdbMeta.certification || undefined,
      year: tmdbDetails.first_air_date ? tmdbDetails.first_air_date.split("-")[0] : undefined,
      description: tmdbDetails.overview || "",
      poster: tmdbDetails.poster_path ? `https://image.tmdb.org/t/p/original${tmdbDetails.poster_path}` : null,
      background: tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbDetails.backdrop_path}` : null,
      latestAirDate: latestAirDate
    });

    auditLogs.push({ name: showName, status: "KEPT", detail: audit.reason });
  }

  // Sort by most recent air date
  metas.sort((a, b) => b.latestAirDate.localeCompare(a.latestAirDate));
  metas.forEach(show => { delete show.latestAirDate; });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, "tvmaze_kids_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TMDB DAILY KIDS DISCOVERY REPORT (ENGLISH ONLY)                      ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${metas.length} English kids shows in the catalog.`);
}

build().catch(err => { console.error(err); process.exit(1); });
