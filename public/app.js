const EMIRATE_LABELS = {
  "abu-dhabi": "Abu Dhabi",
  dubai: "Dubai",
  sharjah: "Sharjah",
  ajman: "Ajman",
  "umm-al-quwain": "Umm Al Quwain",
  "ras-al-khaimah": "Ras Al Khaimah",
  fujairah: "Fujairah"
};

const THREAT_LABELS = {
  watch: "Watch",
  high: "High",
  critical: "Critical"
};

const UAE_TIMEZONE = "Asia/Dubai";

const state = {
  scope: "all",
  criticality: "all",
  emirate: null,
  items: [],
  cloudItems: [],
  timelineItems: [],
  selectedCloudWord: null,
  mapData: null,
  stats: null,
  activeItemId: null,
  warnings: [],
  map: null,
  emirateLayers: new Map(),
  emirateLabelMarkers: [],
  launchLayer: null,
  originMarkers: [],
  targetLocationLayer: null,
  targetLocationMarkers: []
};

function qs(scope, emirate) {
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  if (emirate) params.set("emirate", emirate);
  if (state.criticality) params.set("criticality", state.criticality);
  return params.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadMapData() {
  state.mapData = await fetchJson("/api/map");
}

function formatDate(dateString) {
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return parsed.toLocaleString([], {
    timeZone: UAE_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRelativeTime(dateString) {
  const published = getPublishedTime(dateString);
  if (!published) return "Unknown";
  const diffMs = Date.now() - published;
  const diffMinutes = Math.max(1, Math.round(diffMs / (60 * 1000)));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function getPublishedTime(dateString) {
  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function isRecentItem(item) {
  const published = getPublishedTime(item.published_at);
  return published > 0 && (Date.now() - published) <= (4 * 60 * 60 * 1000);
}

function isFreshItem(item) {
  const published = getPublishedTime(item.published_at);
  return published > 0 && (Date.now() - published) <= (60 * 60 * 1000);
}

function formatEmirates(emirates) {
  return emirates.map((emirate) => EMIRATE_LABELS[emirate] || emirate).join(", ");
}

const STOPWORDS = new Set([
  "a", "about", "above", "across", "after", "again", "against", "all", "almost", "also", "am", "an", "and", "any",
  "are", "article", "articles", "as", "at", "be", "because", "been", "before", "being", "between", "both", "but",
  "by", "can", "click", "could", "defense", "defence", "did", "do", "does", "during", "each", "for", "from",
  "further", "had", "has", "have", "he", "her", "here", "hers", "him", "his", "how", "if", "in", "including",
  "into", "is", "it", "its", "itself", "latest", "may", "monitor", "monitoring", "more", "most", "new", "news",
  "no", "nor", "not", "of", "on", "once", "only", "or", "other", "our", "out", "over", "read", "regional",
  "report", "reported", "reporting", "reports", "review", "same", "says", "said", "say", "security", "she",
  "should", "site", "sites", "some", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "those", "through", "to", "too", "uae", "under", "update", "updates", "very", "was", "watch", "we", "were",
  "what", "when", "where", "which", "while", "who", "with", "within", "would", "you", "your"
]);

const EMIRATE_WORDS = new Set([
  "abu", "dhabi", "dubai", "sharjah", "ajman", "umm", "quwain", "ras", "khaimah", "fujairah", "northern", "emirates"
]);

const JUNK_WORDS = new Set([
  "amp", "blank", "cbmi", "cbsa", "ceid", "click", "color", "com", "content", "font", "gl", "google", "headline",
  "hl", "href", "html", "http", "https", "india", "link", "links", "oc", "px", "ref", "rel", "rss", "source",
  "sources", "tag", "target", "today", "www", "xml"
]);

const WORD_CLOUD_MIN_COUNT = 2;

function buildThreatClass(level) {
  return level === "critical" ? "critical" : level === "high" ? "high" : "watch";
}

function hasDirectActivity(item) {
  return Boolean(item?.direct_attack);
}

function heatColor(value, maxValue) {
  if (!value) return "rgba(79, 136, 170, 0.34)";
  const ratio = maxValue ? value / maxValue : 0;
  if (ratio > 0.7) return "rgba(255, 90, 90, 0.82)";
  if (ratio > 0.38) return "rgba(255, 184, 92, 0.8)";
  return "rgba(79, 136, 170, 0.82)";
}

function emirateStyle(emirateId, heat, maxHeat) {
  return {
    fillColor: heatColor(heat[emirateId], maxHeat),
    fillOpacity: state.emirate === emirateId ? 0.52 : 0.32,
    color: state.emirate === emirateId ? "rgba(255,245,240,1)" : "rgba(255,255,255,0.24)",
    weight: state.emirate === emirateId ? 2.2 : 1.1
  };
}

function targetCategoryMeta(category) {
  const categories = {
    airport: { emoji: "🛫", className: "target-airport", label: "Airport" },
    port: { emoji: "⚓", className: "target-port", label: "Port" },
    energy: { emoji: "⚡", className: "target-energy", label: "Energy" },
    "water-power": { emoji: "💧", className: "target-water-power", label: "Water / Desal" },
    nuclear: { emoji: "☢️", className: "target-nuclear", label: "Nuclear" },
    "ai-tech": { emoji: "🧠", className: "target-ai-tech", label: "AI / Tech" },
    "data-center": { emoji: "🖥️", className: "target-data-center", label: "Data Center" },
    "us-tech": { emoji: "📡", className: "target-us-tech", label: "Tech / Systems" },
    solar: { emoji: "☀️", className: "target-solar", label: "Solar" },
    landmark: { emoji: "🏙️", className: "target-landmark", label: "Landmark" },
    infrastructure: { emoji: "🏗️", className: "target-infrastructure", label: "Infrastructure" },
    bridge: { emoji: "🌉", className: "target-bridge", label: "Bridge" },
    aluminum: { emoji: "🏭", className: "target-aluminum", label: "Industrial" },
    desalination: { emoji: "💧", className: "target-water-power", label: "Desalination" }
  };
  return categories[category] || { emoji: "📍", className: "target-infrastructure", label: "Site" };
}

function stableOffset(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = 0.015 + ((hash % 7) * 0.003);
  return {
    lat: Math.cos(angle) * radius,
    lng: Math.sin(angle) * radius
  };
}

function buildTargetTooltip(location, category) {
  const parts = [
    `<strong>${escapeHtml(location.label)}</strong>`,
    `<span>${escapeHtml(category.label)}</span>`
  ];
  if (location.description) parts.push(`<span>${escapeHtml(location.description)}</span>`);
  return `<div class="pin-tooltip">${parts.join("")}</div>`;
}


function showWarnings(warnings) {
  const warningBar = document.getElementById("warningBar");
  const visibleWarnings = (warnings || []).filter((warning) => !/X integration/i.test(String(warning)));
  if (!visibleWarnings.length) {
    warningBar.classList.remove("visible");
    warningBar.textContent = "";
    return;
  }

  warningBar.classList.add("visible");
  warningBar.textContent = visibleWarnings.join(" ");
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(text) {
  return decodeEntities(String(text || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeText(text, limit = 145) {
  const cleaned = stripHtml(text);
  if (!cleaned) return "";
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 3).trimEnd()}...`;
}

function timelineSummary(item) {
  const title = stripHtml(item.title);
  const summary = stripHtml(item.summary);
  if (!summary) return "";
  if (title && summary.toLowerCase().startsWith(title.toLowerCase())) {
    const remainder = summary.slice(title.length).replace(/^[\s\-–—:]+/, "");
    return summarizeText(remainder || summary);
  }
  return summarizeText(summary);
}

function sanitizeWordCloudText(text) {
  return decodeEntities(String(text || ""))
    .replace(/<font\b[\s\S]*?<\/font>/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b[a-z0-9.-]+\.(com|net|org|ae|co|jp|tv|fm|gov|edu)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemWord(word) {
  if (word.length <= 4) return word;
  if (word.endsWith("ies") && word.length > 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}

function isMeaningfulWord(word) {
  if (word.length < 3) return false;
  if (STOPWORDS.has(word) || EMIRATE_WORDS.has(word) || JUNK_WORDS.has(word)) return false;
  if (/\d/.test(word)) return false;
  if (/^(?:http|https|www|href|rss|font|color|target|blank|google|com)$/.test(word)) return false;
  if (/(html|https?|google|news|rss|href|font|color|target|blank|com)$/.test(word)) return false;
  return true;
}

function tokenizeWords(text) {
  return sanitizeWordCloudText(text)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => isMeaningfulWord(word))
    .map((word) => ({ stem: stemWord(word), label: word }))
    .filter((entry) => isMeaningfulWord(entry.stem));
}

function bestDisplayLabel(labels) {
  const ranked = [...labels.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] || "";
}

function buildCloudCard(id, label, items, options = {}) {
  const counts = new Map();

  for (const item of items) {
    const words = tokenizeWords(`${item.title || ""} ${item.summary || ""}`);
    const seenStems = new Set();
    for (const entry of words) {
      if (!counts.has(entry.stem)) {
        counts.set(entry.stem, { count: 0, labels: new Map(), items: [] });
      }
      const bucket = counts.get(entry.stem);
      bucket.count += 1;
      bucket.labels.set(entry.label, (bucket.labels.get(entry.label) || 0) + 1);
      if (!seenStems.has(entry.stem)) {
        bucket.items.push({
          id: item.id,
          title: item.title,
          url: item.original_url,
          publishedAt: item.published_at,
          sourceName: item.source_name
        });
        seenStems.add(entry.stem);
      }
    }
  }

  const topWords = [...counts.entries()]
    .filter(([, meta]) => meta.count >= WORD_CLOUD_MIN_COUNT)
    .sort((a, b) => b[1].count - a[1].count || bestDisplayLabel(a[1].labels).localeCompare(bestDisplayLabel(b[1].labels)))
    .slice(0, options.limit || 16);

  const maxCount = topWords[0]?.[1].count || 1;
  return {
    id,
    label,
    articleCount: items.length,
    tone: options.tone || "default",
    topWords: topWords.map(([stem, meta], index) => ({
      stem,
      label: bestDisplayLabel(meta.labels),
      count: meta.count,
      items: meta.items
        .sort((a, b) => getPublishedTime(b.publishedAt) - getPublishedTime(a.publishedAt))
        .slice(0, 5),
      size: 0.84 + ((meta.count / maxCount) * (options.scale || 1.38)),
      drift: ((index % 4) * 0.45) + 0.4
    }))
  };
}

function buildWordCloudData(items) {
  const emirates = (state.mapData?.emirates || []).map((entry) => ({
    id: entry.id,
    label: entry.label
  }));

  return emirates.map((emirate) => buildCloudCard(
    emirate.id,
    emirate.label,
    items.filter((item) => item.emirates.includes(emirate.id))
  )).sort((a, b) => b.articleCount - a.articleCount || a.label.localeCompare(b.label));
}

function incidentTypeLabel(item) {
  const counts = item.activity_counts || {};
  const parts = [];
  if (counts.missile > 0) parts.push(`Missile ${counts.missile}`);
  if (counts.drone > 0) parts.push(`Drone ${counts.drone}`);
  if ((counts.strike || 0) > 0) parts.push(`Strike ${counts.strike}`);
  if (item.direct_attack && !parts.length) return "Confirmed incident";
  return parts.length ? parts.join(" / ") : "Confirmed incident";
}

function isKineticMention(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  return /(?:missile|missiles|drone|drones|uav|uavs|rocket|rockets|ballistic|projectile|projectiles|warhead|warheads|intercept|intercepts|intercepted|interception|air defense|air defence|debris)/.test(text);
}

function buildIncidentItems(items) {
  return items
    .filter((item) => {
      const counts = item.activity_counts || {};
      return (
        counts.missile > 0 ||
        counts.drone > 0 ||
        item.attack_type === "missile" ||
        item.attack_type === "drone" ||
        isKineticMention(item)
      );
    })
    .slice()
    .sort((a, b) => getPublishedTime(b.published_at) - getPublishedTime(a.published_at))
    .slice(0, 5);
}

function renderCloudCard(card, isActive = false) {
  return `
    <article class="cloud-card${isActive ? " active" : ""}${card.tone === "summary" ? " cloud-card-summary" : ""}">
      <div class="cloud-card-head">
        <div>
          <h3>${escapeHtml(card.label)}</h3>
          <p>${card.articleCount} article${card.articleCount === 1 ? "" : "s"}</p>
        </div>
        <span class="cloud-count">${card.articleCount}</span>
      </div>
      <div class="cloud-words" aria-label="${escapeHtml(card.label)} repeated words">
        ${card.topWords.length ? card.topWords.map((entry) => `
          <button
            class="cloud-word${state.selectedCloudWord?.groupId === card.id && state.selectedCloudWord?.stem === entry.stem ? " active" : ""}"
            style="font-size:${entry.size.toFixed(2)}rem;animation-delay:${entry.drift.toFixed(2)}s"
            title="${escapeHtml(entry.label)} (${entry.count})"
            type="button"
            data-group="${card.id}"
            data-stem="${entry.stem}"
          >${escapeHtml(entry.label)}</button>
        `).join("") : '<div class="cloud-empty">No repeated words after filtering.</div>'}
      </div>
      ${(() => {
        const activeWord = card.topWords.find((entry) => state.selectedCloudWord?.groupId === card.id && state.selectedCloudWord?.stem === entry.stem);
        if (!activeWord) return "";
        return `
          <div class="cloud-links">
            <div class="cloud-links-head">
              <strong>${escapeHtml(activeWord.label)}</strong>
              <span>${activeWord.items.length} related link${activeWord.items.length === 1 ? "" : "s"}</span>
            </div>
            ${activeWord.items.map((item) => `
              <a class="cloud-link-item" href="${item.url}" target="_blank" rel="noopener noreferrer">
                <strong>${escapeHtml(stripHtml(item.title))}</strong>
                <span>${escapeHtml(item.sourceName)} · ${formatDate(item.publishedAt)}</span>
              </a>
            `).join("")}
          </div>
        `;
      })()}
    </article>
  `;
}

function operationalPriority(item) {
  if (item?.direct_attack) return 3;
  if (item?.threat_level === "high") return 2;
  return 1;
}

function updateStats() {
  const stats = state.stats || {
    visible_items: 0,
    launch_events: 0,
    highest_threat: "watch",
    direct_activity_signals: 0,
    national_posture: { label: "Safe", defcon_level: 5 }
  };
  const missileCounter = document.getElementById("missile24h");
  const strikeCounter = document.getElementById("strike24h");
  const selectedRegion = document.getElementById("selectedRegionLabel");

  if (missileCounter) missileCounter.textContent = String(stats.missile_attacks_24h || 0);
  if (strikeCounter) strikeCounter.textContent = String(stats.strike_attacks_24h || 0);
  if (selectedRegion) {
    selectedRegion.textContent = state.emirate ? (EMIRATE_LABELS[state.emirate] || state.emirate) : "All Emirates";
  }
}

function activityBadge(item) {
  if (!hasDirectActivity(item)) {
    return `
      <div class="activity-badge">
        <span class="signal-dot ${buildThreatClass(item.threat_level)}"></span>
        <span class="activity-chip-small">• monitor</span>
      </div>
    `;
  }
  const counts = item.activity_counts || {};
  const parts = [];
  if (counts.missile > 0) parts.push(`<span class="activity-chip-small">🚀 ${counts.missile}</span>`);
  if (counts.drone > 0) parts.push(`<span class="activity-chip-small">🛰️ ${counts.drone}</span>`);
  if ((counts.strike || 0) > 0) parts.push(`<span class="activity-chip-small">💥 ${counts.strike}</span>`);
  if (!parts.length) parts.push('<span class="activity-chip-small">• monitor</span>');
  return `
    <div class="activity-badge">
      <span class="signal-dot ${buildThreatClass(item.threat_level)}"></span>
      ${parts.join("")}
    </div>
  `;
}

function inlineActivityPills(item) {
  if (!hasDirectActivity(item)) return "";
  const counts = item.activity_counts || {};
  const parts = [];
  if (counts.missile > 0) parts.push(`<span class="pill launch">🚀 ${counts.missile}</span>`);
  if (counts.drone > 0) parts.push(`<span class="pill launch">🛰️ ${counts.drone}</span>`);
  if (counts.strike > 0) parts.push(`<span class="pill launch">💥 ${counts.strike}</span>`);
  return parts.join("");
}

function threatMeta(item) {
  const labels = {
    critical: { icon: '<i class="fa-solid fa-circle-exclamation"></i>', text: "Critical threat" },
    high: { icon: '<i class="fa-solid fa-triangle-exclamation"></i>', text: "High threat" },
    watch: { icon: '<i class="fa-solid fa-eye"></i>', text: "Watch threat" }
  };
  return labels[item.threat_level] || labels.watch;
}

function sourceMeta(item) {
  if (item.source_kind === "x") return { icon: '<i class="fa-brands fa-x-twitter"></i>', text: "Alert source" };
  return { icon: '<i class="fa-solid fa-newspaper"></i>', text: "News source" };
}

function timelineActivityMeta(item) {
  if (!hasDirectActivity(item)) return "";
  const counts = item.activity_counts || {};
  const chips = [];
  if (counts.missile > 0) chips.push(`<span class="timeline-chip timeline-chip-activity missile" title="Missile signals: ${counts.missile}"><i class="fa-solid fa-rocket"></i> ${counts.missile}</span>`);
  if (counts.drone > 0) chips.push(`<span class="timeline-chip timeline-chip-activity drone" title="Drone signals: ${counts.drone}"><i class="fa-solid fa-satellite-dish"></i> ${counts.drone}</span>`);
  if (counts.strike > 0) chips.push(`<span class="timeline-chip timeline-chip-activity strike" title="Strike signals: ${counts.strike}"><i class="fa-solid fa-burst"></i> ${counts.strike}</span>`);
  return chips.join("");
}



function formatTimelineTime(dateString) {
  const parsed = new Date(dateString);
  if (Number.isNaN(parsed.getTime())) return "00:00";
  return parsed.toLocaleTimeString([], {
    timeZone: UAE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function renderTimeline() {
  const timeline = document.getElementById("timeline");
  if (!timeline) return;
  if (!state.timelineItems.length) {
    timeline.innerHTML = '<div class="empty-box">NO_MATCHING_DATA</div>';
    return;
  }

  // Sort by date descending (latest first)
  const sortedItems = [...state.timelineItems].sort((a, b) => 
    new Date(b.published_at) - new Date(a.published_at)
  );

  timeline.innerHTML = sortedItems.map((item, index) => {
    const levelClass = buildThreatClass(item.threat_level);
    const threatClass = `threat-${levelClass}`;
    const isLatest = index === 0;
    const isFresh = isFreshItem(item);
    const timeStr = formatTimelineTime(item.published_at);
    const originStr = (item.emirates[0] || "UAE").substring(0, 3).toUpperCase();
    const statusStr = THREAT_LABELS[item.threat_level] || item.threat_level || "watch";
    const sourceName = stripHtml(item.source_name || "Source");
    const regionLabel = item.emirates.length ? formatEmirates(item.emirates) : "UAE-wide";
    const metaLine = [sourceName, regionLabel, formatRelativeTime(item.published_at)]
      .filter(Boolean)
      .map(escapeHtml)
      .join(" · ");
    const activityLine = hasDirectActivity(item) ? timelineActivityMeta(item) : "";

    return `
      <article class="timeline-item ${item.id === state.activeItemId ? "active" : ""} ${isLatest ? "recent" : ""} ${isFresh ? "fresh" : ""} ${threatClass}" data-id="${item.id}" data-url="${escapeHtml(item.original_url || item.url || "")}">
        <div class="timeline-head">
          <div class="timeline-meta">
            <span class="timeline-time">${timeStr}</span>
            <span class="timeline-origin">${originStr}</span>
            ${isFresh ? '<span class="timeline-fresh-indicator" aria-label="Fresh item"></span>' : ''}
          </div>
          <span class="timeline-status ${levelClass}">${statusStr}</span>
        </div>
        <div class="timeline-title">
          ${escapeHtml(stripHtml(item.title))}
        </div>
        <div class="timeline-tags">
          <span class="timeline-inline-meta">${metaLine}</span>
          ${activityLine ? `<span class="timeline-activity-row">${activityLine}</span>` : ""}
        </div>
      </article>
    `;
  }).join("");

  timeline.querySelectorAll(".timeline-item").forEach((itemEl) => {
    itemEl.addEventListener("click", () => {
      selectItem(itemEl.dataset.id);
      const url = itemEl.dataset.url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  });
}

function renderWordClouds() {
  const wordCloudEl = document.getElementById("wordCloud");
  const cloudGrid = document.getElementById("cloudGrid");
  if (!wordCloudEl || !cloudGrid) return;

  // Build high-frequency cloud
  const cloudData = buildCloudCard("all-visible", "Operational Themes", state.items, { limit: 15, scale: 1.2 });
  const activeWord = state.selectedCloudWord?.groupId === "all-visible"
    ? cloudData.topWords.find((word) => word.stem === state.selectedCloudWord.stem)
    : null;
  
  if (!cloudData.topWords.length) {
    wordCloudEl.innerHTML = '<div class="empty-box">NO_PULSE_DETECTED</div>';
  } else {
    wordCloudEl.innerHTML = `
      <div class="word-cloud-words" role="list" aria-label="Operational themes">
        ${cloudData.topWords.map((word) => {
          const size = Math.min(1.12, Math.max(0.7, word.size));
          const isActive = activeWord?.stem === word.stem;
          return `
            <button
              class="cloud-item${isActive ? " active" : ""}"
              style="font-size:${size.toFixed(2)}rem"
              type="button"
              data-word-stem="${word.stem}"
              title="${escapeHtml(`${word.label} (${word.count})`)}"
            >
              ${escapeHtml(word.label.toUpperCase())}
              <span class="cloud-item-count">${word.count}</span>
            </button>
          `;
        }).join("")}
      </div>
      <div class="word-cloud-results">
        <div class="word-cloud-results-head">
          <strong>${activeWord ? escapeHtml(activeWord.label.toUpperCase()) : "Select a word"}</strong>
          <span>${activeWord ? `${activeWord.items.length} source item${activeWord.items.length === 1 ? "" : "s"}` : "Tap a word to open related news items"}</span>
        </div>
        ${
          activeWord
            ? `<div class="word-cloud-result-list">
                ${activeWord.items.map((item) => `
                  <a class="word-cloud-result-card" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
                    <strong>${escapeHtml(stripHtml(item.title))}</strong>
                    <span>${escapeHtml(item.sourceName)} · ${formatDate(item.publishedAt)}</span>
                  </a>
                `).join("")}
              </div>`
            : `<div class="cloud-empty">Click a word to reveal sources.</div>`
        }
      </div>
    `;

    wordCloudEl.querySelectorAll("[data-word-stem]").forEach((button) => {
      button.addEventListener("click", () => {
        const stem = button.dataset.wordStem;
        state.selectedCloudWord = state.selectedCloudWord?.groupId === "all-visible" && state.selectedCloudWord?.stem === stem
          ? null
          : { groupId: "all-visible", stem };
        renderWordClouds();
      });
    });
  }

  const incidents = buildIncidentItems(state.items);

  cloudGrid.innerHTML = incidents.length ? incidents.map((item) => {
    const levelClass = buildThreatClass(item.threat_level);
    const status = THREAT_LABELS[item.threat_level] || "Watch";
    const time = formatTimelineTime(item.published_at);
    const region = item.emirates.length ? formatEmirates(item.emirates) : "UAE-wide";
    const source = stripHtml(item.source_name || "Source");
    return `
      <a class="incident-card threat-${levelClass}" href="${escapeHtml(item.original_url || item.url || "#")}" target="_blank" rel="noopener noreferrer">
        <div class="incident-head">
          <strong>${escapeHtml(stripHtml(item.title))}</strong>
          <span class="timeline-status ${levelClass}">${status}</span>
        </div>
        <div class="incident-meta">
          <span>${escapeHtml(time)}</span>
          <span>${escapeHtml(region)}</span>
          <span>${escapeHtml(source)}</span>
        </div>
        <div class="incident-type">${escapeHtml(incidentTypeLabel(item))}</div>
      </a>
    `;
  }).join("") : '<div class="empty-box">NO_CONFIRMED_INCIDENTS</div>';
}

function hasLeaflet() {
  return typeof window !== "undefined" && typeof window.L !== "undefined";
}

function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl || !state.mapData || !hasLeaflet()) return false;

  state.map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true
  }).setView(state.mapData.center || [24.35, 54.9], state.mapData.zoom || 7);

  if (state.mapData.tile_url) {
    L.tileLayer(state.mapData.tile_url, {
      attribution: state.mapData.attribution || "",
      maxZoom: state.mapData.max_zoom || 18
    }).addTo(state.map);
  }

  if (state.mapData.bounds) {
    state.map.setMaxBounds(state.mapData.bounds);
  }

  state.launchLayer = L.layerGroup().addTo(state.map);
  return true;
}

function renderEmirates() {
  if (!state.map || !state.mapData?.emirates?.length || !hasLeaflet()) return;

  const heat = state.stats?.heat || {};
  const maxHeat = Math.max(1, ...Object.values(heat));

  for (const emirate of state.mapData.emirates) {
    const style = emirateStyle(emirate.id, heat, maxHeat);
    let layer = state.emirateLayers.get(emirate.id);

    if (!layer) {
      layer = L.polygon(emirate.geometry, style)
        .bindTooltip(emirate.label, { sticky: true })
        .on("click", () => {
          state.emirate = emirate.id;
          state.scope = emirate.id;
          state.activeItemId = null;
          state.selectedCloudWord = null;
          refreshView();
        })
        .addTo(state.map);
      state.emirateLayers.set(emirate.id, layer);
    } else {
      layer.setStyle(style);
    }
  }

  if (!state.emirateLabelMarkers.length) {
    for (const emirate of state.mapData.emirates) {
      const labelMarker = L.marker(emirate.center, {
        interactive: false,
        icon: L.divIcon({
          className: "",
          html: `<div class="emirate-label">${escapeHtml(emirate.label.toUpperCase())}</div>`,
          iconSize: [160, 24],
          iconAnchor: [80, 12]
        })
      }).addTo(state.map);
      state.emirateLabelMarkers.push({ emirate: emirate.id, marker: labelMarker });
    }
  }

  for (const { emirate, marker } of state.emirateLabelMarkers) {
    marker.setOpacity(!state.emirate || state.emirate === emirate ? 1 : 0.35);
  }
}

function renderTargetLocations() {
  if (!state.map || !state.mapData || !hasLeaflet()) return;
  if (!state.targetLocationLayer) {
    state.targetLocationLayer = L.layerGroup().addTo(state.map);
    for (const location of state.mapData.target_locations || []) {
      const category = targetCategoryMeta(location.category);
      const capacity = location.capacity || 0;
      const finalSize = Math.min(34, 20 + (capacity > 0 ? Math.sqrt(capacity) * 0.06 : 0));
      const offset = stableOffset(location.id || location.label || `${location.point.join(",")}`);
      const shiftedPoint = [location.point[0] + offset.lat, location.point[1] + offset.lng];

      const marker = L.marker(shiftedPoint, {
        icon: L.divIcon({
          className: "",
          html: `<div class="target-marker ${category.className}" style="font-size: ${finalSize}px; width: ${finalSize + 10}px; height: ${finalSize + 10}px; line-height: ${finalSize + 10}px;">${category.emoji}</div>`,
          iconSize: [finalSize + 8, finalSize + 8],
          iconAnchor: [(finalSize + 8) / 2, (finalSize + 8) / 2]
        })
      });

      marker.bindTooltip(buildTargetTooltip(location, category), {
        sticky: true,
        direction: "top",
        opacity: 0.98,
        className: "pin-tooltip-wrap"
      });
      marker.addTo(state.targetLocationLayer);
      state.targetLocationMarkers.push({ emirate: location.emirate, marker });
    }
  }

  for (const { emirate, marker } of state.targetLocationMarkers) {
    marker.setOpacity(!state.emirate || state.emirate === emirate ? 1 : 0.28);
  }
}


function renderOriginZones() {
  if (!state.map || !state.mapData?.origin_zones || !hasLeaflet()) return;
  if (state.originMarkers.length) return;

  return;
}

function clearLaunchVisuals() {
  if (!state.launchLayer) return;
  state.launchLayer.clearLayers();
}

function bezierPoints(start, end, steps = 40) {
  const midLat = (start.lat + end.lat) / 2 + 1.2;
  const midLng = (start.lng + end.lng) / 2;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const lat = (1 - t) * (1 - t) * start.lat + 2 * (1 - t) * t * midLat + t * t * end.lat;
    const lng = (1 - t) * (1 - t) * start.lng + 2 * (1 - t) * t * midLng + t * t * end.lng;
    points.push([lat, lng]);
  }
  return points;
}

function animateLaunches(items) {
  if (!state.map || !state.launchLayer || !hasLeaflet()) return;
  clearLaunchVisuals();
  const launchItems = items.filter((item) => item?.launch);
  
  // Add some ambient trajectory lines for 'tactical feel' if fewer than 2 active launches
  if (launchItems.length < 2) {
    launchItems.push({
      id: "ambient-01",
      launch: {
        origin_point: { lat: 26.5, lng: 55.0 },
        target_point: { lat: 25.1288, lng: 56.3265 },
        icon: "rocket"
      }
    });
  }

  for (const item of launchItems) {
    const start = item.launch.origin_point;
    const end = item.launch.target_point;
    const points = bezierPoints(start, end);

    // Background trajectory glow
    L.polyline(points, {
      color: "rgba(0, 255, 255, 0.15)",
      weight: 12,
      lineCap: "round"
    }).addTo(state.launchLayer);

    // Animated trajectory path
    L.polyline(points, {
      color: item.id === state.activeItemId ? "#00ffff" : "rgba(0, 255, 255, 0.6)",
      weight: 3,
      className: "trajectory-line",
      dashArray: "10, 10"
    }).addTo(state.launchLayer);

    // Origin point glowing marker
    L.circleMarker([start.lat, start.lng], {
      radius: 6,
      color: "var(--cyan)",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2
    }).addTo(state.launchLayer);

    // Destination 'Hit' signature (radar ping style)
    const pulse = L.circle([end.lat, end.lng], {
      radius: 15000,
      color: "var(--red)",
      fillColor: "var(--red)",
      fillOpacity: 0.2,
      weight: 2
    }).addTo(state.launchLayer);

    const missileIcon = L.divIcon({
      className: "",
      html: `<div style="font-size:24px;filter:drop-shadow(0 0 10px var(--cyan-glow));">${iconFor(item.launch.icon)}</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const marker = L.marker(points[0], { icon: missileIcon }).addTo(state.launchLayer);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      if (index >= points.length) {
        window.clearInterval(timer);
        marker.setLatLng(points[points.length - 1]);
        
        // Final 'Hit' Explosion Icon
        L.marker([end.lat, end.lng], {
          icon: L.divIcon({
            className: "target-marker target-nuclear",
            html: '<div style="font-size:24px;">💥</div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          })
        }).addTo(state.launchLayer);
        return;
      }
      marker.setLatLng(points[index]);
    }, 35);

    // Pulse animation for the hit signature
    pulse._pulseTimer = window.setInterval(() => {
      const current = pulse.getRadius();
      pulse.setRadius(current > 30000 ? 10000 : current + 2000);
    }, 100);
  }
}

function selectItem(id) {
  state.activeItemId = id;
  const item = state.timelineItems.find((entry) => entry.id === id) || state.items.find((entry) => entry.id === id);
  if (item && item.emirates.length) {
    state.emirate = item.emirates[0];
  }
  refreshView();
}

async function fetchViewData() {
  const query = qs(state.scope, state.emirate);
  const [itemsResponse, mapResponse, statsResponse] = await Promise.all([
    fetchJson(`/api/items?${query}`),
    fetchJson(`/api/map?${query}`),
    fetchJson(`/api/stats?${query}`)
  ]);

  state.items = [...itemsResponse.items].sort((a, b) => getPublishedTime(b.published_at) - getPublishedTime(a.published_at));
  state.cloudItems = state.items;
  state.timelineItems = state.items.slice(0, 10);
  state.warnings = itemsResponse.warnings || [];
  state.mapData = mapResponse;
  state.stats = statsResponse;
}

function syncBadgeAndStatus() {
  const lb = document.getElementById("liveBadge");
  if (lb) lb.textContent = state.stats?.sources?.x_enabled ? "LIVE + X READY" : "LIVE CACHE";
  
  const criticalityLabel = state.criticality === "all" ? "all levels" : `${state.criticality} only`;
  const freshnessLabel = state.stats?.freshness_label || "Since 12:00 AM UAE time";
  
  const st = document.getElementById("statusText");
  if (st) st.textContent = `${state.items.length} UAE items ${freshnessLabel.toLowerCase()}, filtered to ${criticalityLabel}`;
  
  const lu = document.getElementById("lastUpdated");
  if (lu) lu.textContent = state.stats?.last_refresh
    ? `Updated: ${new Date(state.stats.last_refresh).toLocaleTimeString([], { timeZone: UAE_TIMEZONE, hour: "2-digit", minute: "2-digit" })} UAE`
    : "Updated: pending";
    
  const mh = document.getElementById("mapHint");
  if (mh) mh.textContent = state.emirate
    ? `Sector lock is active on ${EMIRATE_LABELS[state.emirate] || state.emirate}. Strategic sites outside the selected emirate are dimmed.`
    : "Operational map showing same-day UAE reporting, strategic sites, and direct-attack traces for confirmed missile or drone incidents since 12:00 AM UAE time.";
}

function ensureActiveItem() {
  if (state.activeItemId && state.items.some((item) => item.id === state.activeItemId)) return;
  state.activeItemId = state.timelineItems[0]?.id || null;
}

async function refreshView(options = {}) {
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    if (options.forceRefresh) {
      await fetch("/api/refresh", { method: "POST" });
    }
    await fetchViewData();
    ensureActiveItem();
    renderTimeline();
    renderWordClouds();
    updateStats();
    if (!state.map) initMap();
    renderEmirates();
    renderOriginZones();
    renderTargetLocations();
    showWarnings(state.warnings);
    syncBadgeAndStatus();
    animateLaunches(state.items);
  } catch (error) {
    showWarnings([`Failed to load live data: ${error.message}`]);
    const statusText = document.getElementById("statusText");
    if (statusText) statusText.textContent = "Failed to load sources";
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function bindControls() {
  document.querySelectorAll(".scope-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".scope-btn").forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      state.scope = button.dataset.scope;
      state.emirate = null;
      state.activeItemId = null;
      state.selectedCloudWord = null;
      refreshView();
    });
  });

  document.querySelectorAll(".criticality-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".criticality-btn").forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      state.criticality = button.dataset.criticality;
      state.activeItemId = null;
      state.selectedCloudWord = null;
      refreshView();
    });
  });

  document.getElementById("clearEmirateBtn").addEventListener("click", () => {
    state.emirate = null;
    state.activeItemId = null;
    state.selectedCloudWord = null;
    refreshView();
  });

  document.getElementById("refreshBtn").addEventListener("click", () => {
    state.selectedCloudWord = null;
    refreshView({ forceRefresh: true });
  });
}

bindControls();
refreshView();
window.setInterval(() => refreshView(), 5 * 60 * 1000);
