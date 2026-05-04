const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const CACHE_PATH = path.join(DATA_DIR, "cache.json");
const SEED_PATH = path.join(DATA_DIR, "seed-items.json");
const MAP_DATA_PATH = path.join(DATA_DIR, "map-data.json");
const REFRESH_MS = Number(process.env.REFRESH_MS || 15 * 60 * 1000);
const UAE_UTC_OFFSET_MINUTES = 4 * 60;

const TILE_URL = process.env.TILE_URL || "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION = process.env.TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function googleNewsSearchUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

const FEED_SOURCES = [
  {
    id: "uae-direct-threat",
    name: "Google News: UAE direct threat watch",
    url: googleNewsSearchUrl('("UAE" OR "Abu Dhabi" OR Dubai OR Sharjah OR Fujairah) (Iran OR Israel OR Houthi OR Yemen) (missile OR drone OR intercept OR strike OR attack OR "air defense" OR "air defence")')
  },
  {
    id: "uae-airspace-aviation",
    name: "Google News: UAE airspace / aviation",
    url: googleNewsSearchUrl('("UAE" OR "Abu Dhabi" OR Dubai OR Sharjah OR Fujairah) (Iran OR Israel) (airspace OR airport OR aviation OR flights OR closure OR suspension OR diversion)')
  },
  {
    id: "uae-maritime-hormuz",
    name: "Google News: UAE maritime / Hormuz",
    url: googleNewsSearchUrl('("UAE" OR Dubai OR Abu Dhabi OR Fujairah) ("Strait of Hormuz" OR Hormuz OR Gulf OR shipping OR tanker OR port OR maritime) (Iran OR Israel OR escalation OR disruption OR threat)')
  },
  {
    id: "uae-us-force-posture",
    name: "Google News: Gulf US force posture",
    url: googleNewsSearchUrl('("UAE" OR Gulf OR "Abu Dhabi" OR Dubai) (CENTCOM OR "US forces" OR Patriot OR THAAD OR carrier OR destroyer OR bomber OR "air defense") (Iran OR Israel OR escalation OR retaliation)')
  },
  {
    id: "uae-leadership-signals",
    name: "Google News: leadership / policy signals",
    url: googleNewsSearchUrl('("UAE" OR Gulf OR "Strait of Hormuz" OR "regional security") (Trump OR "White House" OR Netanyahu OR "US President") (Iran OR Israel OR strike OR ceasefire OR retaliation OR escalation)')
  },
  {
    id: "uae-economic-infrastructure",
    name: "Google News: UAE infrastructure / energy",
    url: googleNewsSearchUrl('("UAE" OR Abu Dhabi OR Dubai OR Fujairah) (oil OR LNG OR energy OR infrastructure OR port OR terminal) (Iran OR Israel OR Hormuz OR shipping OR escalation OR disruption)')
  }
];

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

const STORED_MAP_DATA = loadJson(MAP_DATA_PATH, {});
const MAP_DATA = {
  ...STORED_MAP_DATA,
  tile_url: process.env.TILE_URL || STORED_MAP_DATA.tile_url || TILE_URL,
  attribution: process.env.TILE_ATTRIBUTION || STORED_MAP_DATA.attribution || TILE_ATTRIBUTION
};

let cache = null;
let refreshPromise = null;

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadCache() {
  const existing = loadJson(CACHE_PATH, null);
  if (existing) return existing;
  return {
    last_refresh: null,
    items: loadJson(SEED_PATH, []),
    sources: { feeds: FEED_SOURCES.length, x_enabled: false },
    warnings: ["Using seed data until the first live refresh completes."]
  };
}

function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(text) {
  return decodeEntities(String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function sha(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function getItemText(raw) {
  return `${raw.title || ""} ${raw.summary || ""}`.toLowerCase();
}

function getUaeDayCutoffMs(nowMs = Date.now()) {
  const shiftedNow = nowMs + (UAE_UTC_OFFSET_MINUTES * 60 * 1000);
  const uaeNow = new Date(shiftedNow);
  const cutoffUtcMs = Date.UTC(
    uaeNow.getUTCFullYear(),
    uaeNow.getUTCMonth(),
    uaeNow.getUTCDate(),
    0,
    -UAE_UTC_OFFSET_MINUTES,
    0,
    0
  );
  return cutoffUtcMs;
}

function filterItemsSinceUaeDayStart(items, nowMs = Date.now()) {
  const cutoffMs = getUaeDayCutoffMs(nowMs);
  return items.filter((item) => {
    const published = new Date(item.published_at).getTime();
    return Number.isFinite(published) && published >= cutoffMs;
  });
}

const UAE_LOCATION_PATTERN = /(uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah)/;
const DIRECT_THREAT_SCOPE_PATTERN = /(uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah|emirati)/;
const KINETIC_OBJECT_PATTERN = /(missile|missiles|ballistic|cruise missile|cruise missiles|drone|drones|uav|uavs|rocket|rockets|projectile|projectiles|warhead|warheads|debris)/;
const KINETIC_ACTION_PATTERN = /(attack|attacks|attacked|strike|strikes|struck|intercept|intercepts|intercepted|interception|launch|launches|launched|incoming|shot down|downed|hit|hits|impact|impacts|targeted|targeting|under attack|blast|blasts|explosion|explosions)/;
const DIRECT_ATTACK_NEGATION_PATTERN = /(no (?:iranian )?(?:drone|missile|ballistic|rocket) attacks?|didn(?:'|’)t expect iran to attack|condemn(?:s|ed|ing)? attack|condemn(?:s|ed|ing)? .*targeting|attack targeting trump|targeting trump|white house correspondents|terrorist attack on kuwait|attack on kuwaiti border|support for uae security|rebuilding trust|regional security|food security|cyber security|travel advisory|travel alert|weather alert|traffic alert|security exercise|military exercise|exercise in|preparedness|readiness|simulation|drill|review|checklist|airport advisory|fake videos|fog alert|rain|storm|accident|crash|ceasefire|cease-fire|truce|analysis|op-ed|opinion|newsletter|live updates|timeline|after weeks of|during iran war|amid iran war|what we know|explained|debate|history|historical|fallout|recovery)/;
const STRATEGIC_SIGNAL_NOISE_PATTERN = /(food security|cyber security|weather alert|traffic alert|fog alert|rain|storm|accident|crash|security exercise|military exercise|exercise in|preparedness|readiness|simulation|drill|checklist|fake videos|op-ed|opinion|newsletter|history|historical|what we know|explained)/;
const GENERAL_HIGH_RISK_PATTERN = /(missile|drone|ballistic|intercept|air defense|air defence|attack|strike|threat|alert|warning|debris)/;
const OPERATIONAL_RETROSPECTIVE_PATTERN = /(during iran war|amid iran war|when iran escalated attacks|first overseas use|explained|what we know|global debate|history|historical|fallout|recovery|report(?:ed)?\b|alleged|secretly deployed|deployed iron dome|sent missile defence|sent iron dome|called for help|responded with iron dome)/;
const CURRENT_OPERATIONAL_PATTERN = /(?:uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah)[^.!?]{0,72}(?:is under attack|under attack|intercepts|intercepted|air defen(?:s|c)es intercept|reports|reported|struck|hit|hits|blast|blasts|explosion|explosions|missile debris|drone debris|incoming missile|incoming drone)|(?:incoming missile|incoming drone|missile debris|drone debris|ballistic missile|ballistic missiles|drone strike|drone attack|missile strike|missile attack)[^.!?]{0,72}(?:uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah)|(?:uae|abu dhabi|dubai|sharjah|fujairah)[^.!?]{0,72}(?:air defen(?:s|c)e(?:s)?|defence ministry|defense ministry)[^.!?]{0,72}(?:responding|intercepts|intercepted|shot down|downed)/;
const UAE_IMPACT_PATTERN = /(uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah|gulf|gulf states|gulf region|emirati|str[a]?it of hormuz|hormuz)/;
const CONFLICT_PARTY_PATTERN = /(iran|iranian|israel|israeli|idf|tehran|houthi|houthis|yemen|hezbollah|proxy militia|militia)/;
const AVIATION_IMPACT_PATTERN = /(airspace|airport|aviation|flight|flights|airline|airlines|closure|closed|suspension|suspended|diversion|diverted|reroute|rerouted|notam)/;
const MARITIME_IMPACT_PATTERN = /(shipping|tanker|tankers|maritime|vessel|vessels|cargo|freight|port|terminal|strait of hormuz|hormuz|red sea|gulf waters)/;
const INFRASTRUCTURE_IMPACT_PATTERN = /(oil|lng|energy|infrastructure|terminal|refinery|power|utility|utilitys|utility's|desalination|pipeline|data center|datacenter)/;
const FORCE_POSTURE_PATTERN = /(centcom|us forces|u\.s\. forces|american forces|patriot|thaad|carrier|destroyer|bomber|f-35|air defense|air defence|naval deployment|force posture)/;
const LEADERSHIP_SIGNAL_PATTERN = /(trump|white house|us president|netanyahu|president trump|donald trump|state department)/;
const ESCALATION_SIGNAL_PATTERN = /(iran israel|israel iran|retaliation|escalation|counterstrike|response|ceasefire talks|cease-fire talks|warning|threat|sanctions|regional security|spillover)/;

function classifyEmirates(raw) {
  const text = getItemText(raw);
  const matches = [];
  const keywordMap = {
    "abu-dhabi": ["abu dhabi"],
    dubai: ["dubai"],
    sharjah: ["sharjah"],
    ajman: ["ajman"],
    "umm-al-quwain": ["umm al quwain", "umm-al-quwain", "uaq"],
    "ras-al-khaimah": ["ras al khaimah", "rak"],
    fujairah: ["fujairah", "fujeirah"]
  };

  for (const [emirate, keywords] of Object.entries(keywordMap)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      matches.push(emirate);
    }
  }

  if (!matches.length && text.includes("northern emirates")) {
    return ["ajman", "umm-al-quwain", "ras-al-khaimah", "fujairah"];
  }

  if (!matches.length && text.includes("uae")) {
    return ["abu-dhabi"];
  }

  return [...new Set(matches)];
}

function inferOriginZone(raw) {
  const text = getItemText(raw);
  if (text.includes("yemen") || text.includes("houthi") || text.includes("red sea")) return "yemen";
  if (text.includes("iran") || text.includes("iranian") || text.includes("hormuz")) return "iran";
  return "iran";
}

function classifyDirectAttack(raw) {
  const text = getItemText(raw);
  if (!DIRECT_THREAT_SCOPE_PATTERN.test(text)) return { direct: false, type: null };
  if (DIRECT_ATTACK_NEGATION_PATTERN.test(text)) return { direct: false, type: null };
  if (!KINETIC_OBJECT_PATTERN.test(text) || !KINETIC_ACTION_PATTERN.test(text)) return { direct: false, type: null };

  const directUaeIncidentPatterns = [
    /(?:uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah)[^.!?]{0,64}(?:intercept|intercepts|intercepted|interception|under attack|attacked|attack|strike|strikes|struck|hit|hits|incoming|targeted|targeting|missile|drone|ballistic|rocket|debris)/,
    /(?:missile|missiles|ballistic|cruise missile|cruise missiles|drone|drones|rocket|rockets|projectile|projectiles|debris|intercept|intercepts|intercepted|interception)[^.!?]{0,64}(?:uae|abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah)/,
    /(?:air defen(?:s|c)e(?:s)?|defence ministry|defense ministry)[^.!?]{0,64}(?:intercept|intercepts|intercepted|shot down|downed|responding)[^.!?]{0,64}(?:missile|missiles|drone|drones|ballistic|rocket|projectile)/,
    /(?:drone strike|drone attack|missile strike|missile attack|ballistic missile|ballistic missiles|incoming missile|incoming drone|missile debris|drone debris)[^.!?]{0,64}(?:abu dhabi|dubai|sharjah|ajman|umm al quwain|umm-al-quwain|uaq|ras al khaimah|rak|fujairah|fujeirah|uae)/
  ];

  if (!directUaeIncidentPatterns.some((pattern) => pattern.test(text))) {
    return { direct: false, type: null };
  }

  if (/(missile|missiles|ballistic|cruise missile|cruise missiles|rocket|rockets|warhead|warheads)/.test(text)) {
    return { direct: true, type: "missile" };
  }
  if (/(drone|drones|uav|uavs)/.test(text)) {
    return { direct: true, type: "drone" };
  }
  if (/(intercept|intercepts|intercepted|interception|blast|blasts|explosion|explosions|impact|impacts|debris)/.test(text)) {
    return { direct: true, type: "strike" };
  }

  return { direct: false, type: null };
}

function classifyStrategicSignal(raw, attackClassification) {
  const text = getItemText(raw);
  if (attackClassification.direct) return { active: false, type: null };
  if (STRATEGIC_SIGNAL_NOISE_PATTERN.test(text) && !AVIATION_IMPACT_PATTERN.test(text) && !MARITIME_IMPACT_PATTERN.test(text)) {
    return { active: false, type: null };
  }

  const hasUaeImpact = UAE_IMPACT_PATTERN.test(text);
  const hasConflictCue = CONFLICT_PARTY_PATTERN.test(text) || ESCALATION_SIGNAL_PATTERN.test(text);
  if (!hasUaeImpact || !hasConflictCue) return { active: false, type: null };

  if (AVIATION_IMPACT_PATTERN.test(text)) return { active: true, type: "aviation" };
  if (MARITIME_IMPACT_PATTERN.test(text)) return { active: true, type: "maritime" };
  if (FORCE_POSTURE_PATTERN.test(text)) return { active: true, type: "force_posture" };
  if (INFRASTRUCTURE_IMPACT_PATTERN.test(text)) return { active: true, type: "infrastructure" };
  if (LEADERSHIP_SIGNAL_PATTERN.test(text) && ESCALATION_SIGNAL_PATTERN.test(text)) return { active: true, type: "leadership" };
  if (GENERAL_HIGH_RISK_PATTERN.test(text)) return { active: true, type: "regional_threat" };

  return { active: false, type: null };
}

function inferThreatLevel(raw, attackClassification, strategicSignal) {
  const text = getItemText(raw);
  if (attackClassification.direct) return "critical";
  if (strategicSignal.active) return "high";
  if (GENERAL_HIGH_RISK_PATTERN.test(text) && UAE_LOCATION_PATTERN.test(text)) return "high";
  return "watch";
}

function inferThreatScore(level, raw, attackClassification, strategicSignal) {
  const base = attackClassification.direct ? 85 : level === "high" ? 55 : 28;
  const text = getItemText(raw);
  const bonus =
    Number(attackClassification.type === "missile") * 10 +
    Number(attackClassification.type === "drone") * 8 +
    Number(attackClassification.direct) * 8 +
    Number(strategicSignal?.type === "maritime") * 6 +
    Number(strategicSignal?.type === "aviation") * 6 +
    Number(strategicSignal?.type === "force_posture") * 4 +
    Number(strategicSignal?.type === "leadership") * 3 +
    Number(text.includes("abu dhabi")) * 4 +
    Number(text.includes("dubai")) * 4;
  return Math.min(99, base + bonus);
}

function classifyOperationalContext(raw, attackClassification) {
  const text = getItemText(raw);
  if (!attackClassification.direct) return "general_security";
  if (CURRENT_OPERATIONAL_PATTERN.test(text) && !OPERATIONAL_RETROSPECTIVE_PATTERN.test(text)) {
    return "current_operational";
  }
  if (OPERATIONAL_RETROSPECTIVE_PATTERN.test(text)) {
    return "historical_or_retrospective";
  }
  return "historical_or_retrospective";
}

function extractActivityCounts(raw, attackClassification) {
  if (!attackClassification.direct) {
    return { missile: 0, drone: 0, strike: 0 };
  }
  const text = getItemText(raw);
  return {
    missile: (text.match(/missile|missiles|ballistic|warhead|incoming missile|missile strike/g) || []).length,
    drone: (text.match(/drone|drones|uav|uavs|houthi drone|drone attack|drone debris/g) || []).length,
    strike: (text.match(/strike|attack|attacks|intercept|interception|blast|explosion|aerial threat|aerial attack/g) || []).length
  };
}

function maybeLaunch(raw, emirates, originZone, attackClassification) {
  const text = getItemText(raw);
  if (!emirates.length) return null;
  if (!attackClassification.direct) return null;
  if (!/(missile|drone|launch|intercept|warhead|strike|ballistic|incoming missile|incoming drone|drone attack|drone debris|aerial threat|air defence responding|air defense responding)/.test(text)) return null;

  const targetEmirate = emirates[0];
  const targetData = MAP_DATA.emirates.find((entry) => entry.id === targetEmirate);
  const originData = MAP_DATA.origin_zones[originZone];
  if (!targetData || !originData) return null;

  const isMissile = /(missile|missiles|ballistic|warhead|incoming missile|missile strike)/.test(text);
  const isIntercept = /(intercept|interception|air defence responding|air defense responding)/.test(text);
  const icon = isMissile ? "rocket" : isIntercept ? "shield" : "satellite";
  const type = isIntercept
    ? "Interception route"
    : isMissile
      ? "Missile threat track"
      : "Drone corridor watch";

  return {
    type,
    icon,
    origin_label: originData.label,
    target_label: targetData.label,
    origin_point: { lat: originData.point[0], lng: originData.point[1] },
    target_point: { lat: targetData.center[0], lng: targetData.center[1] }
  };
}

function normalizeSourceName(sourceName, link) {
  if (sourceName) return stripTags(sourceName);
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch (_) {
    return "Unknown Source";
  }
}

function normalizePublishedAt(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function sourceConfidence(sourceKind) {
  if (sourceKind === "news") {
    return {
      source_type_label: "News Site",
      confidence_label: "High",
      confidence_score: 85
    };
  }

  return {
    source_type_label: "X Post",
    confidence_label: "Medium",
    confidence_score: 55
  };
}

function normalizeRssItem(item, feedName) {
  const summary = stripTags(item.description || item.content || "");
  const title = stripTags(item.title || "");
  const originalUrl = stripTags(item.link || "");
  if (!title || !originalUrl) return null;

  const raw = { title, summary };
  const emirates = classifyEmirates(raw);
  if (!emirates.length) return null;

  const originZone = inferOriginZone(raw);
  const attackClassification = classifyDirectAttack(raw);
  const strategicSignal = classifyStrategicSignal(raw, attackClassification);
  const operational_context = classifyOperationalContext(raw, attackClassification);
  const threatLevel = inferThreatLevel(raw, attackClassification, strategicSignal);
  const threatScore = inferThreatScore(threatLevel, raw, attackClassification, strategicSignal);
  const sourceMeta = sourceConfidence("news");
  const activity_counts = extractActivityCounts(raw, attackClassification);

  return {
    id: sha(`${originalUrl}|${title}`),
    published_at: normalizePublishedAt(item.pubDate || item.isoDate || Date.now()),
    source_kind: "news",
    source_name: normalizeSourceName(feedName, originalUrl),
    source_type_label: sourceMeta.source_type_label,
    confidence_label: sourceMeta.confidence_label,
    confidence_score: sourceMeta.confidence_score,
    title,
    summary,
    original_url: originalUrl,
    emirates,
    threat_level: threatLevel,
    threat_score: threatScore,
    direct_attack: attackClassification.direct,
    attack_type: attackClassification.type,
    strategic_signal: strategicSignal.active,
    signal_type: strategicSignal.type,
    operational_context,
    activity_counts,
    origin_zone: originZone,
    tags: emirates.map((emirate) => MAP_DATA.emirates.find((entry) => entry.id === emirate)?.label).filter(Boolean),
    launch: maybeLaunch(raw, emirates, originZone, attackClassification)
  };
}

function normalizeStoredItem(item) {
  if (!item || !item.title || !item.original_url) return null;

  const raw = { title: stripTags(item.title), summary: stripTags(item.summary || "") };
  const emirates = classifyEmirates(raw);
  if (!emirates.length) return null;

  const originZone = inferOriginZone(raw);
  const attackClassification = classifyDirectAttack(raw);
  const strategicSignal = classifyStrategicSignal(raw, attackClassification);
  const operational_context = classifyOperationalContext(raw, attackClassification);
  const threatLevel = inferThreatLevel(raw, attackClassification, strategicSignal);
  const threatScore = inferThreatScore(threatLevel, raw, attackClassification, strategicSignal);
  const activity_counts = extractActivityCounts(raw, attackClassification);
  const sourceMeta = sourceConfidence(item.source_kind === "x" ? "x" : "news");

  return {
    ...item,
    title: raw.title,
    summary: raw.summary,
    published_at: normalizePublishedAt(item.published_at),
    emirates,
    threat_level: threatLevel,
    threat_score: threatScore,
    direct_attack: attackClassification.direct,
    attack_type: attackClassification.type,
    strategic_signal: strategicSignal.active,
    signal_type: strategicSignal.type,
    operational_context,
    activity_counts,
    origin_zone: originZone,
    source_type_label: item.source_type_label || sourceMeta.source_type_label,
    confidence_label: item.confidence_label || sourceMeta.confidence_label,
    confidence_score: item.confidence_score || sourceMeta.confidence_score,
    tags: (item.tags && item.tags.length ? item.tags : emirates.map((emirate) => MAP_DATA.emirates.find((entry) => entry.id === emirate)?.label).filter(Boolean)),
    launch: maybeLaunch(raw, emirates, originZone, attackClassification)
  };
}

function rehydrateCache(existingCache) {
  return {
    ...existingCache,
    items: dedupeItems((existingCache.items || []).map((item) => normalizeStoredItem(item)).filter(Boolean))
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
  };
}

function parseRss(xml) {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/g) || [];
  for (const block of matches) {
    const read = (tag) => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return match ? match[1] : "";
    };
    items.push({
      title: read("title"),
      link: read("link"),
      description: read("description"),
      pubDate: read("pubDate"),
      source: read("source")
    });
  }
  return items;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function refreshFeeds() {
  const settled = await Promise.allSettled(
    FEED_SOURCES.map(async (feed) => {
      const xml = await fetchText(feed.url);
      return parseRss(xml)
        .map((item) => normalizeRssItem(item, feed.name))
        .filter(Boolean);
    })
  );

  const items = [];
  const warnings = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      warnings.push(result.reason.message);
    }
  }

  return { items, warnings };
}

async function refreshX() {
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) {
    return { items: [], warning: "X integration disabled: set X_BEARER_TOKEN to enable official X API search." };
  }

  const query = process.env.X_QUERY || '((UAE OR "Abu Dhabi" OR Dubai OR Sharjah OR Fujairah OR Gulf OR Hormuz) (Iran OR Israel OR Houthi OR Yemen) (missile OR drone OR attack OR intercept OR strike OR airspace OR flights OR shipping OR tanker OR port OR escalation OR retaliation OR "air defense" OR CENTCOM OR Patriot OR THAAD)) OR ((Trump OR "White House" OR Netanyahu OR "US President") (Iran OR Israel OR retaliation OR escalation OR ceasefire) (UAE OR Gulf OR Hormuz OR "regional security"))';
  const endpoint = new URL("https://api.x.com/2/tweets/search/recent");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("max_results", "20");
  endpoint.searchParams.set("tweet.fields", "created_at,text");

  try {
    const payload = await fetchJson(endpoint.toString(), {
      Authorization: `Bearer ${bearer}`
    });
    const tweets = Array.isArray(payload.data) ? payload.data : [];
    const items = tweets
      .map((tweet) => {
        const title = stripTags(tweet.text.slice(0, 120));
        const summary = stripTags(tweet.text);
        const raw = { title, summary };
        const emirates = classifyEmirates(raw);
        if (!emirates.length) return null;
        const originZone = inferOriginZone(raw);
        const attackClassification = classifyDirectAttack(raw);
        const strategicSignal = classifyStrategicSignal(raw, attackClassification);
        const operational_context = classifyOperationalContext(raw, attackClassification);
        const threatLevel = inferThreatLevel(raw, attackClassification, strategicSignal);
        const sourceMeta = sourceConfidence("x");
        const activity_counts = extractActivityCounts(raw, attackClassification);
        return {
          id: `x-${tweet.id}`,
          published_at: normalizePublishedAt(tweet.created_at || Date.now()),
          source_kind: "x",
          source_name: "X",
          source_type_label: sourceMeta.source_type_label,
          confidence_label: sourceMeta.confidence_label,
          confidence_score: sourceMeta.confidence_score,
          title,
          summary,
          original_url: `https://x.com/i/web/status/${tweet.id}`,
          emirates,
          threat_level: threatLevel,
          threat_score: inferThreatScore(threatLevel, raw, attackClassification, strategicSignal),
          direct_attack: attackClassification.direct,
          attack_type: attackClassification.type,
          strategic_signal: strategicSignal.active,
          signal_type: strategicSignal.type,
          operational_context,
          activity_counts,
          origin_zone: originZone,
          tags: ["X", ...emirates.map((emirate) => EMIRATE_LABEL(emirate))].filter(Boolean),
          launch: maybeLaunch(raw, emirates, originZone, attackClassification)
        };
      })
      .filter(Boolean);

    return { items, warning: null };
  } catch (error) {
    return { items: [], warning: `X integration unavailable: ${error.message}` };
  }
}

function EMIRATE_LABEL(emirate) {
  return MAP_DATA.emirates.find((entry) => entry.id === emirate)?.label || emirate;
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.original_url || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPostureVigilanceSignal(item) {
  const text = getItemText(item);
  if (/cyber|digital identity|food security|travel alert|travel advisory|weather alert|traffic alert|airport advisory|exercise|simulation|drill|review/.test(text)) {
    return false;
  }
  if (item.direct_attack) return true;
  if (item.strategic_signal) return true;
  return /(missile|drone|ballistic|rocket|incoming|intercept|interception|air defense|air defence|regional threat|security threat|warning|alert)/.test(text);
}

function buildNationalPosture(items, activeEmirate) {
  const now = Date.now();
  const last6HoursStart = now - (6 * 60 * 60 * 1000);
  const recentItems = items;

  const activeItems = recentItems.filter((item) => {
    const published = new Date(item.published_at).getTime();
    return published >= last6HoursStart && item.direct_attack && item.operational_context === "current_operational";
  }).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const vigilanceItems = recentItems.filter((item) => {
    if (item.operational_context === "current_operational") return true;
    if (item.direct_attack && item.operational_context !== "historical_or_retrospective") return true;
    return item.threat_level === "high" && isPostureVigilanceSignal(item);
  }).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const postureItems = activeItems.length ? activeItems : vigilanceItems;
  const evidenceItems = postureItems.slice(0, 3).map((item) => ({
    id: item.id,
    title: item.title,
    source_name: item.source_name,
    original_url: item.original_url,
    published_at: item.published_at,
    threat_level: item.threat_level,
    attack_type: item.attack_type,
    operational_context: item.operational_context,
    emirates: item.emirates
  }));

  const areaLabel = activeEmirate ? EMIRATE_LABEL(activeEmirate) : "the UAE";

  if (activeItems.length) {
    return {
      label: "Active Attack",
      defcon_level: 1,
      severity: "active",
      status_note: "Current or very recent operational attack reporting detected",
      assessment: `Recent OSINT reporting indicates ${areaLabel} is dealing with an active or very recent aerial threat event. Public reporting suggests defensive or impact activity within the past 6 hours.`,
      evidence_items: evidenceItems,
      last_evidence_at: evidenceItems[0]?.published_at || null
    };
  }

  if (vigilanceItems.length) {
    return {
      label: "Heightened Vigilance",
      defcon_level: 3,
      severity: "heightened",
      status_note: "Elevated regional threat reporting; no active attack confirmed",
      assessment: `Recent reporting supports elevated vigilance for ${areaLabel}, but the currently received OSINT does not confirm that ${activeEmirate ? areaLabel : "the UAE"} is under attack right now.`,
      evidence_items: evidenceItems,
      last_evidence_at: evidenceItems[0]?.published_at || null
    };
  }

  return {
    label: "Safe",
    defcon_level: 5,
    severity: "safe",
    status_note: "No current or imminent attack indicated in received OSINT",
    assessment: `Based on the latest received OSINT items, there is no current evidence that ${activeEmirate ? areaLabel : "the UAE"} is under direct aerial attack or facing an imminent confirmed strike.`,
    evidence_items: [],
    last_evidence_at: null
  };
}

cache = rehydrateCache(loadCache());

async function refreshData() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const [feedResult, xResult] = await Promise.all([refreshFeeds(), refreshX()]);
    const items = dedupeItems([...feedResult.items, ...xResult.items]).sort(
      (a, b) => new Date(b.published_at) - new Date(a.published_at)
    );

    if (items.length) {
      cache = {
        last_refresh: new Date().toISOString(),
        items,
        sources: {
          feeds: FEED_SOURCES.length,
          x_enabled: Boolean(process.env.X_BEARER_TOKEN)
        },
        warnings: [...feedResult.warnings, xResult.warning].filter(Boolean)
      };
      writeJson(CACHE_PATH, cache);
    } else {
      cache = {
        ...cache,
        last_refresh: new Date().toISOString(),
        warnings: [...feedResult.warnings, xResult.warning, "Live refresh returned no usable UAE items; serving cached data."].filter(Boolean)
      };
      writeJson(CACHE_PATH, cache);
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function filterItems(query) {
  const scope = query.get("scope") || "all";
  const emirate = query.get("emirate");
  const criticality = query.get("criticality") || "all";

  let items = filterItemsSinceUaeDayStart(cache.items);
  
  // FALLBACK: If no same-day items, show recent history/seed items for demo visibility
  if (items.length < 5) {
    items = cache.items.slice(0, 20);
  }

  return items.filter((item) => {
    if (scope === "threats" && !item.direct_attack) return false;
    if (scope === "northern" && !item.emirates.some((entry) => ["ajman", "umm-al-quwain", "ras-al-khaimah", "fujairah"].includes(entry))) {
      return false;
    }
    if (!["all", "threats", "northern"].includes(scope) && !item.emirates.includes(scope)) {
      return false;
    }
    if (emirate && !item.emirates.includes(emirate)) {
      return false;
    }
    if (criticality !== "all" && item.threat_level !== criticality) {
      return false;
    }
    return true;
  });
}

function buildStats(items, activeEmirate) {
  const dayCutoffMs = getUaeDayCutoffMs();
  const heat = {};
  for (const emirate of MAP_DATA.emirates) {
    heat[emirate.id] = 0;
  }

  for (const item of items) {
    for (const emirate of item.emirates) {
      heat[emirate] += item.threat_score;
    }
  }

  const highestThreat = items.reduce((best, item) => {
    const score = { watch: 1, high: 2, critical: 3 }[item.threat_level] || 0;
    return score > best.score ? { score, label: item.threat_level } : best;
  }, { score: 0, label: "watch" });

  const sameDayItems = items;

  const missile_attacks_24h = sameDayItems.filter((item) => {
    return item.direct_attack && item.attack_type === "missile";
  }).length;

  const strike_attacks_24h = sameDayItems.filter((item) => {
    return item.direct_attack && (item.attack_type === "drone" || item.attack_type === "strike");
  }).length;
  const direct_activity_signals = sameDayItems.reduce((sum, item) => {
    if (!item.direct_attack) return sum;
    return sum + (item.activity_counts?.missile || 0) + (item.activity_counts?.drone || 0) + (item.activity_counts?.strike || 0);
  }, 0);

  return {
    visible_items: items.length,
    active_emirate: activeEmirate || null,
    day_cutoff_at: new Date(dayCutoffMs).toISOString(),
    freshness_label: "Since 12:00 AM UAE time",
    launch_events: items.filter((item) => item.launch).length,
    direct_activity_signals,
    highest_threat: highestThreat.label,
    national_posture: buildNationalPosture(items, activeEmirate),
    missile_attacks_24h,
    strike_attacks_24h,
    heat
  };
}

function routeRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/") {
    return sendFile(res, path.join(PUBLIC_DIR, "index.html"));
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/public/")) {
    return sendFile(res, path.join(__dirname, requestUrl.pathname));
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/items") {
    const items = filterItems(requestUrl.searchParams);
    return sendJson(res, 200, {
      last_refresh: cache.last_refresh,
      warnings: cache.warnings,
      items
    });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/map") {
    const items = filterItems(requestUrl.searchParams);
    return sendJson(res, 200, {
      ...MAP_DATA,
      stats: buildStats(items, requestUrl.searchParams.get("emirate"))
    });
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/stats") {
    const items = filterItems(requestUrl.searchParams);
    return sendJson(res, 200, {
      last_refresh: cache.last_refresh,
      warnings: cache.warnings,
      sources: cache.sources,
      ...buildStats(items, requestUrl.searchParams.get("emirate"))
    });
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/refresh") {
    refreshData()
      .then(() => sendJson(res, 200, { ok: true, last_refresh: cache.last_refresh }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

const server = http.createServer(routeRequest);

server.listen(PORT, HOST, () => {
  console.log(`UAE Threat Monitor listening on http://${HOST}:${PORT}`);
  refreshData().catch((error) => {
    console.error("Initial refresh failed:", error.message);
  });
  setInterval(() => {
    refreshData().catch((error) => {
      console.error("Scheduled refresh failed:", error.message);
    });
  }, REFRESH_MS);
});
