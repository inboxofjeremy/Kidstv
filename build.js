/**
 * build.js — Stremio & Wako Kids Weekly Schedule Static Catalog (TMDB Certification & Genre Powered)
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

async function getTmdbDetails(tmdbId, country = "US") {
  if (!tmdbId) return { certification: null, genres: [], tmdbType: "" };
  
  // Fetch TV show details and content ratings in parallel
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
  const tvmazeGenres = (show.genres || []).map(g => g.toLowerCase());
  const lang = (show.language || "").toLowerCase();
  const { certification, genres: tmdbGenres } = tmdbData;

  // 1. Hard block obvious adult/reality/soap/news franchises
  const blockedTitles = [
    "dancing with the stars", "strictly come dancing", "survivor", "masked singer", 
    "big brother", "the bachelor", "the bachelorette", "love island", "masterchef", 
    "the voice", "americas got talent", "britains got talent", "rupaul", "shark tank", 
    "top chef", "the amazing race", "american idol", "the kardashians", 
    "young and the restless", "bold and the beautiful", "days of our lives", 
    "general hospital", "beyond the gates", "assisted living", "smosh"
  ];
  if (blockedTitles.some(title => name.includes(title))) {
    return { exclude: true, reason: `Excluded: Adult/Soap/Reality Franchise (${show.name})` };
  }

  // 2. If TMDB certification explicitly rates it mature/teen-adult, block it
  const blockedCertifications = ["TV-14", "TV-MA", "R", "NC-17"];
  if (certification) {
    const certUpper = certification.toUpperCase();
    if (blockedCertifications.includes(certUpper)) {
      return { exclude: true, reason: `Blocked Certification (${certification})` };
    }
  }

  // 3. Block non-kids formats & languages
  const blockedLanguages = ["chinese", "japanese", "russian", "mandarin", "cantonese", "korean", "hindi", "thai", "spanish", "norwegian", "hungarian", "dutch", "swedish", "portuguese", "urdu", "turkish", "hebrew"];
  if (blockedLanguages.includes(lang)) {
    return { exclude: true, reason: `Blocked Language (${lang})` };
  }

  // 4. Safe Kids Validation (Accept if TMDB says TV-Y, TV-Y7, TV-G, or if genres include Kids/Animation/Family from either platform)
  const safeCerts = ["TV-Y", "TV-Y7", "TV-G", "G", "TV-PG", "PG"]; // Allow PG/TV-PG only if backed by kids genres
  const allGenres = [...new Set([...tvmazeGenres, ...tmdbGenres])];
  
  const hasKidsTags = allGenres.some(g => ["animation", "family", "children", "kids", "anime"].includes(g));
  const hasSafeCert = certification && safeCerts.includes(certification.toUpperCase());

  // If it has a safe kids certification (like TV-Y for Transformers) OR has animation/family tags, let it through!
  if (!hasSafeCert && !hasKidsTags) {
    return { exclude: true, reason: "Excluded: Lacks kids certification or family/animation genres" };
  }

  return { exclude: false, reason: `Passed validation (Cert: ${certification || 'None'}, Genres: ${allGenres.join(', ')})` };
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

  console.log(`Processing metadata mappings for ${activeShowIds.size} shows...`);

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData) continue;

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
      genres: [...new Set([...showData.genres, ...tmdbData.genres])],
      certification: tmdbData.certification || undefined,
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
  console.log("            TVMAZE + TMDB CERTIFICATION & GENRE REPORT                          ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
}

build().catch(err => { console.error(err); process.exit(1); });
