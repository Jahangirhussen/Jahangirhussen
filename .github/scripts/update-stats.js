// Fetches real data from public/official APIs and writes shields.io "endpoint" badge
// JSON files under .github/badges/. Never fabricates numbers — on fetch failure it
// keeps the previous committed value and flags the badge as stale via color.
const fs = require("fs");
const path = require("path");

const BADGES_DIR = path.join(__dirname, "..", "badges");
fs.mkdirSync(BADGES_DIR, { recursive: true });

function readPrevious(file) {
  const p = path.join(BADGES_DIR, file);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
  }
  return null;
}

function writeBadge(file, label, message, color) {
  fs.writeFileSync(
    path.join(BADGES_DIR, file),
    JSON.stringify({ schemaVersion: 1, label, message: String(message), color }, null, 2) + "\n"
  );
}

async function safeFetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Renders a chart via QuickChart.io (reliable, no free-tier rate limiting like the
// vercel stat-card mirrors) and saves it as a static PNG. The Action overwrites this
// file with fresh data on every run, so the image auto-updates without the README
// text itself ever needing to change.
async function saveChartImage(filename, chartConfig, bgColor) {
  const url = `https://quickchart.io/chart?width=600&height=260&backgroundColor=${encodeURIComponent(bgColor)}&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QuickChart failed for ${filename}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(BADGES_DIR, filename), buf);
}

async function updateOrcid() {
  const file = "orcid-works.json";
  try {
    const data = await safeFetchJson("https://pub.orcid.org/v3.0/0009-0007-1024-6644/works", {
      headers: { Accept: "application/json" },
    });
    const count = (data.group || []).length;
    writeBadge(file, "ORCID Works", count, "a6ce39");
    return count;
  } catch (err) {
    console.error("ORCID fetch failed:", err.message);
    const prev = readPrevious(file);
    writeBadge(file, "ORCID Works", prev ? `${prev.message} (stale)` : "unavailable", "lightgrey");
    return null;
  }
}

async function updateCodeforces() {
  const file = "codeforces-rating.json";
  try {
    const data = await safeFetchJson("https://codeforces.com/api/user.info?handles=jahangirhussen5011");
    const u = data.result[0];
    writeBadge(file, "Codeforces", `${u.rating} (${u.rank})`, "1F8ACB");
    writeBadge("codeforces-max.json", "CF Max Rating", `${u.maxRating} (${u.maxRank})`, "1F8ACB");
    return u;
  } catch (err) {
    console.error("Codeforces fetch failed:", err.message);
    const prev = readPrevious(file);
    writeBadge(file, "Codeforces", prev ? `${prev.message} (stale)` : "unavailable", "lightgrey");
    return null;
  }
}

async function updateLeetCode() {
  const file = "leetcode-solved.json";
  try {
    const body = {
      query: `query getUserProfile($username: String!) {
        matchedUser(username: $username) {
          submitStatsGlobal { acSubmissionNum { difficulty count } }
        }
        userContestRanking(username: $username) { rating globalRanking }
      }`,
      variables: { username: "jahangirhussen" },
    };
    const data = await safeFetchJson("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
      body: JSON.stringify(body),
    });
    const nums = data.data.matchedUser.submitStatsGlobal.acSubmissionNum;
    const all = nums.find(s => s.difficulty === "All").count;
    const easy = nums.find(s => s.difficulty === "Easy").count;
    const medium = nums.find(s => s.difficulty === "Medium").count;
    const hard = nums.find(s => s.difficulty === "Hard").count;
    const rating = data.data.userContestRanking ? Math.round(data.data.userContestRanking.rating) : null;
    writeBadge(file, "LeetCode Solved", all, "FFA116");
    if (rating) writeBadge("leetcode-rating.json", "LeetCode Rating", rating, "FFA116");
    await saveChartImage("leetcode-difficulty.png", {
      type: "horizontalBar",
      data: {
        labels: ["Easy", "Medium", "Hard"],
        datasets: [{ data: [easy, medium, hard], backgroundColor: ["#3fb950", "#d29922", "#f85149"] }],
      },
      options: {
        title: { display: true, text: "LeetCode — Problems Solved by Difficulty", fontColor: "#F0F2F5" },
        legend: { display: false },
        scales: {
          xAxes: [{ ticks: { fontColor: "#8B949E", beginAtZero: true }, gridLines: { color: "#30363D" } }],
          yAxes: [{ ticks: { fontColor: "#F0F2F5" }, gridLines: { color: "#30363D" } }],
        },
      },
    }, "0D1117");
    return { all, easy, medium, hard, rating };
  } catch (err) {
    console.error("LeetCode fetch failed:", err.message);
    const prev = readPrevious(file);
    writeBadge(file, "LeetCode Solved", prev ? `${prev.message} (stale)` : "unavailable", "lightgrey");
    return null;
  }
}

// DOIs for every published work — used to pull live citation counts from Crossref
// (free, no key, no auth). Works without a DOI (e.g. university-journal PDFs without
// one) are simply skipped rather than guessed at.
const PUBLICATION_DOIS = [
  "10.65136/jati.v10i1.11",
  "10.65136/jati.v10i1.325",
  "10.4018/979-8-3373-7694-3.ch003",
  "10.14445/23488387/ijcse-v11i10p104",
];

function doiToFilename(doi) {
  return "cite-" + doi.replace(/[^a-zA-Z0-9]/g, "-") + ".json";
}

async function updateCitations() {
  const file = "citations.json";
  const perDoi = {};
  let total = 0;
  let anyFailed = false;
  for (const doi of PUBLICATION_DOIS) {
    const rowFile = doiToFilename(doi);
    try {
      const data = await safeFetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      const count = data.message["is-referenced-by-count"] ?? 0;
      perDoi[doi] = count;
      total += count;
      writeBadge(rowFile, "cited by", count, count > 0 ? "6a11cb" : "lightgrey");
    } catch (err) {
      console.error(`Crossref fetch failed for ${doi}:`, err.message);
      anyFailed = true;
      const prev = readPrevious(rowFile);
      writeBadge(rowFile, "cited by", prev ? `${prev.message} (stale)` : "n/a", "lightgrey");
    }
  }
  fs.writeFileSync(path.join(BADGES_DIR, "citations-per-doi.json"), JSON.stringify(perDoi, null, 2) + "\n");
  if (anyFailed) {
    const prev = readPrevious(file);
    writeBadge(file, "Total Citations", prev ? `${prev.message} (stale)` : "unavailable", "lightgrey");
  } else {
    writeBadge(file, "Total Citations", total, "6a11cb");
  }
  return perDoi;
}

async function updateGitHub() {
  const file = "github-repos.json";
  try {
    const data = await safeFetchJson("https://api.github.com/users/jahangirhussen", {
      headers: { Accept: "application/vnd.github+json" },
    });
    writeBadge(file, "Public Repos", data.public_repos, "0e75b6");
    writeBadge("github-followers.json", "Followers", data.followers, "0e75b6");

    const repos = await safeFetchJson("https://api.github.com/users/jahangirhussen/repos?per_page=100", {
      headers: { Accept: "application/vnd.github+json" },
    });
    const langCount = {};
    for (const r of repos) {
      if (r.fork || !r.language) continue;
      langCount[r.language] = (langCount[r.language] || 0) + 1;
    }
    const entries = Object.entries(langCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (entries.length) {
      const palette = ["#58A6FF", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#8B949E", "#39c5cf", "#f778ba"];
      await saveChartImage("github-languages.png", {
        type: "pie",
        data: {
          labels: entries.map(e => e[0]),
          datasets: [{ data: entries.map(e => e[1]), backgroundColor: palette }],
        },
        options: {
          title: { display: true, text: "Repository Languages", fontColor: "#F0F2F5" },
          legend: { position: "right", labels: { fontColor: "#8B949E" } },
        },
      }, "0D1117");
    }

    return data;
  } catch (err) {
    console.error("GitHub fetch failed:", err.message);
    const prev = readPrevious(file);
    writeBadge(file, "Public Repos", prev ? `${prev.message} (stale)` : "unavailable", "lightgrey");
    return null;
  }
}

(async () => {
  await updateOrcid();
  await updateCodeforces();
  await updateLeetCode();
  await updateGitHub();
  await updateCitations();

  const timestamp = new Date().toISOString();
  fs.writeFileSync(
    path.join(BADGES_DIR, "last-updated.json"),
    JSON.stringify({ schemaVersion: 1, label: "Live Stats Updated", message: timestamp.slice(0, 16).replace("T", " ") + " UTC", color: "success" }, null, 2) + "\n"
  );
  console.log("Stats updated at", timestamp);
})();
