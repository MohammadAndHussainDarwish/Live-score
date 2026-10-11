const dateInput = document.querySelector("#match-date");
const previousDayButton = document.querySelector("#previous-day");
const nextDayButton = document.querySelector("#next-day");
const competitionFilter = document.querySelector("#competition-filter");
const refreshButton = document.querySelector("#refresh-matches");
const selectedDayLabel = document.querySelector("#selected-day-label");
const matchCount = document.querySelector("#match-count");
const matchList = document.querySelector("#match-list");
const notice = document.querySelector("#notice");

const liveStatuses = new Set(["LIVE", "IN_PLAY", "PAUSED", "EXTRA_TIME", "PENALTY_SHOOTOUT"]);
const finishedStatuses = new Set(["FINISHED", "AWARDED"]);
let matches = [];

function localDateValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 10);
}

function moveDate(days) {
  const date = new Date(`${dateInput.value}T12:00:00`);
  date.setDate(date.getDate() + days);
  dateInput.value = localDateValue(date);
  loadMatches();
}

function formatSelectedDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("ar", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function statusLabel(status) {
  if (liveStatuses.has(status)) return "مباشر";
  if (finishedStatuses.has(status)) return "انتهت";
  if (status === "POSTPONED") return "مؤجلة";
  if (status === "CANCELED") return "أُلغيت";
  if (status === "SUSPENDED") return "متوقفة";
  return "لم تبدأ";
}

function matchClock(match) {
  return new Intl.DateTimeFormat("ar", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(match.utcDate));
}

function createTeam(name, crest) {
  const team = document.createElement("div");
  team.className = "team";

  if (crest) {
    const image = document.createElement("img");
    image.src = crest;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    team.append(image);
  }

  const teamName = document.createElement("span");
  teamName.className = "team-name";
  teamName.textContent = name || "فريق غير معروف";
  team.append(teamName);
  return team;
}

function createMatchCard(match) {
  const card = document.createElement("article");
  card.className = "match-card";

  const homeTeam = createTeam(match.homeTeam?.name, match.homeTeam?.crest);
  const awayTeam = createTeam(match.awayTeam?.name, match.awayTeam?.crest);

  const center = document.createElement("div");
  center.className = "match-center";

  const competition = document.createElement("span");
  competition.className = "competition-name";
  competition.textContent = match.competition?.name || "مباراة";

  const status = document.createElement("span");
  const isLive = liveStatuses.has(match.status);
  const isFinished = finishedStatuses.has(match.status);
  status.className = `match-status${isLive ? " is-live" : ""}${isFinished ? " is-finished" : ""}`;
  status.textContent = statusLabel(match.status);

  const score = document.createElement("strong");
  const hasScore = isLive || isFinished;
  if (hasScore) {
    const homeGoals = match.score?.fullTime?.home ?? match.score?.regularTime?.home;
    const awayGoals = match.score?.fullTime?.away ?? match.score?.regularTime?.away;
    score.className = "match-score";
    score.textContent = `${homeGoals ?? 0} - ${awayGoals ?? 0}`;
  } else {
    score.className = "match-time";
    score.textContent = matchClock(match);
  }

  center.append(competition, score, status);
  card.append(homeTeam, center, awayTeam);
  return card;
}

function updateCompetitions() {
  const selectedValue = competitionFilter.value;
  const competitions = new Map();

  for (const match of matches) {
    if (match.competition?.id != null && match.competition.name) {
      competitions.set(String(match.competition.id), match.competition.name);
    }
  }

  competitionFilter.replaceChildren(new Option("كل البطولات", "all"));
  for (const [id, name] of [...competitions].sort((left, right) => left[1].localeCompare(right[1], "ar"))) {
    competitionFilter.add(new Option(name, id));
  }

  if (competitions.has(selectedValue)) competitionFilter.value = selectedValue;
}

function renderMatches() {
  const selectedCompetition = competitionFilter.value;
  const visibleMatches = matches
    .filter((match) => selectedCompetition === "all" || String(match.competition?.id) === selectedCompetition)
    .sort((left, right) => new Date(left.utcDate) - new Date(right.utcDate));

  matchCount.textContent = `${new Intl.NumberFormat("ar").format(visibleMatches.length)} مباراة`;
  matchList.replaceChildren();

  if (visibleMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚽";

    const title = document.createElement("strong");
    title.textContent = selectedCompetition === "all" ? "لا توجد مباريات في هذا اليوم" : "لا توجد مباريات لهذه البطولة";

    const hint = document.createElement("span");
    hint.textContent = "جرّب اختيار تاريخ آخر أو بطولة مختلفة.";
    empty.append(icon, title, hint);
    matchList.append(empty);
    return;
  }

  matchList.append(...visibleMatches.map(createMatchCard));
}

function showError(message) {
  notice.textContent = message;
  notice.hidden = false;
}

async function loadMatches() {
  if (!dateInput.value) return;

  selectedDayLabel.textContent = formatSelectedDate(dateInput.value);
  notice.hidden = true;
  matchList.replaceChildren(...Array.from({ length: 3 }, () => {
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton";
    return skeleton;
  }));
  matchList.setAttribute("aria-busy", "true");
  refreshButton.disabled = true;
  matchCount.textContent = "جارٍ التحميل";

  try {
    const response = await fetch(`/api/matches?date=${encodeURIComponent(dateInput.value)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "تعذّر تحميل المباريات. حاول مرة أخرى.");
    }
    if (!Array.isArray(data.matches)) {
      throw new Error("وصلت استجابة غير متوقعة من خدمة المباريات.");
    }

    matches = data.matches;
    updateCompetitions();
    renderMatches();
  } catch (error) {
    matches = [];
    matchCount.textContent = "— مباراة";
    matchList.replaceChildren();
    showError(error instanceof TypeError
      ? "تعذّر الاتصال بالخادم. تأكد من تشغيل الموقع واتصال الإنترنت."
      : error.message);
  } finally {
    matchList.setAttribute("aria-busy", "false");
    refreshButton.disabled = false;
  }
}

dateInput.value = localDateValue();
previousDayButton.addEventListener("click", () => moveDate(-1));
nextDayButton.addEventListener("click", () => moveDate(1));
dateInput.addEventListener("change", loadMatches);
competitionFilter.addEventListener("change", renderMatches);
refreshButton.addEventListener("click", loadMatches);
loadMatches();
