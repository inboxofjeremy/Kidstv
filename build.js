/**
 * build.js — Stremio & Wako Kids/Family Weekly Schedule (TMDB Discover Direct)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const DISCOVERY_DAYS_BACK = 30; // 30-day discovery window
const RETENTION_DAYS_BACK = 9;  // 9-day retention window for final catalog

const auditLogs = [];

async function fetchJSON(url) {
  try {
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

async function getTmdbShowDetails(tmdbId, country = "US") {
  const [details, ratingsData, externalIds] = await Promise.all([
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`)
  ]);

  const ratingObj = ratingsData?.results?.find(r => r.iso_3166_1 === country) || ratingsData?.results?.[0];
  const certification = ratingObj ? ratingObj.rating : null;
  
  return {
    details,
    certification,
    imdbId: externalIds?.imdb_id || null,
    genres: details?.genres ? details.genres.map(g => g.name.toLowerCase()) : []
  };
}

async function build() {
  const todayStr = pacificDateString(new Date());
  
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - DISCOVERY_DAYS_BACK);
  const startDateStr = pacificDateString(startDateObj);

  console.log(`Discovering kids/family shows on TMDB between ${startDateStr} and ${todayStr}...`);

  let discoverResults = [];

  // Query pages 1 through 5 using TMDB Discover
  // with_status=0|3|4 catches Returning (0), Ended (3), and Canceled (4) shows
  // with_genres=10762|16 targets Kids (10762) and Animation (16)
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.themoviedb.org/3/discover/tv` +
      `?api_key=${TMDB_API_KEY}` +
      `&air_date.gte=${startDateStr}` +
      `&air_date.lte=${todayStr}` +
      `&with_genres=10762|16` +
      `&with_status=0|3|4` +
      `&timezone=America/Los_Angeles` +
      `&sort_by=popularity.desc` +
      `&page=${page}`;

    const data = await fetchJSON(url);
    if (data?.results?.length) {
      discoverResults.push(...data.results);
    }
  }

  const uniqueShows = Array.from(new Map(discoverResults.map(show => [show.id, show])).values());
  console.log(`Found ${uniqueShows.length} potential shows via TMDB Discover. Processing full series episode maps...`);

  const metas = [];
  
  for (const rawShow of uniqueShows) {
    const { details, certification, imdbId, genres } = await getTmdbShowDetails(rawShow.id);
    if (!details) continue;

    const name = (details.name || "").toLowerCase();

    // 1. Explicit title blocklist guardrails
    const blockedTitles = [
      "gma", "news", "hallmark", "dancing with the stars", "survivor", "masked singer", 
      "big brother", "bachelor", "love island", "masterchef", "voice", "kardashians"
    ];
    if (blockedTitles.some(title => name.includes(title))) {
      auditLogs.push({ name: details.name, status: "DROPPED", detail: "Matched title blocklist" });
      continue;
    }

    // 2. Age Certification Check (PG & Below, including international equivalents like C, C8)
    const allowedCertifications = ["TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "G", "TV-PG", "PG", "C", "C8", "E"];
    const blockedCertifications = ["TV-14", "TV-MA", "R", "NC-17", "14+", "18+"];

    if (certification) {
      const certUpper = certification.toUpperCase();
      if (blockedCertifications.includes(certUpper)) {
        auditLogs.push({ name: details.name, status: "DROPPED", detail: `Blocked Certification (${certification})` });
        continue;
      }
      if (!allowedCertifications.includes(certUpper)) {
        auditLogs.push({ name: details.name, status: "DROPPED", detail: `Unrecognized Certification (${certification})` });
        continue;
      }
    }

    // 3. Map ALL seasons and episodes for Stremio video structure
    const seasons = details.seasons || [];
    const mappedVideos = [];

    for (const season of seasons) {
      if (season.season_number < 0) continue; // Skip specials if not needed
      const seasonData = await fetchJSON(`https://api.themoviedb.org/3/tv/${details.id}/season/${season.season_number}?api_key=${TMDB_API_KEY}`);
      
      if (seasonData?.episodes) {
        seasonData.episodes.forEach(ep => {
          if (ep.air_date) {
            mappedVideos.push({
              released: ep.air_date,
              season: Number(season.season_number),
              episode: Number(ep.episode_number)
            });
          }
        });
      }
    }

    let stremioId = `tmdb:${details.id}`;

    metas.push({
      id: stremioId,
      imdb_id: imdbId || undefined,
      tmdb_id: details.id,
      type: "series",
      name: details.name,
      genres: genres,
      certification: certification || undefined,
      year: details.first_air_date ? details.first_air_date.split("-")[0] : undefined,
      description: cleanHTML(details.overview),
      poster: details.poster_path ? `https://image.tmdb.org/t/p/original${details.poster_path}` : null,
      background: details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : null,
      videos: mappedVideos
    });

    auditLogs.push({ name: details.name, status: "KEPT", detail: `Cert: ${certification || 'N/A'}, Episodes: ${mappedVideos.length}` });
  }

  // Retention Window Filtering: Keep only shows that aired an episode within the last RETENTION_DAYS_BACK days
  const cutoffTarget = new Date();
  cutoffTarget.setDate(cutoffTarget.getDate() - RETENTION_DAYS_BACK);
  const cutoffStr = pacificDateString(cutoffTarget);

  const filteredMetas = metas.filter(show => {
    const latest = getLatestValidDate(show, todayStr);
    return latest >= cutoffStr && latest <= todayStr;
  });

  // Strip heavy video arrays before writing out final catalog file
  filteredMetas.forEach(show => { delete show.videos; });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, "tvmaze_kids_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas: filteredMetas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TMDB DISCOVER (ACTIVE + ENDED + CANCELED) REPORT                     ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${filteredMetas.length} shows in the kids weekly catalog.`);
}

build().catch(err => { console.error(err); process.exit(1); });
