const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT) || 5000;
const footballApiBaseUrl = "https://worldcup26.ir/get/soccer";
const publicDirectory = __dirname;
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 12_000 }, (upstreamResponse) => {
      let body = "";
      upstreamResponse.setEncoding("utf8");
      upstreamResponse.on("data", (chunk) => {
        body += chunk;
      });
      upstreamResponse.on("end", () => {
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          reject(new Error("أرسلت خدمة المباريات استجابة غير صالحة."));
          return;
        }

        if (upstreamResponse.statusCode < 200 || upstreamResponse.statusCode >= 300) {
          reject(new Error(data.error || data.message || "رفضت خدمة المباريات الطلب."));
          return;
        }

        resolve(data);
      });
    });

    request.on("timeout", () => request.destroy(new Error("انتهت مهلة الاتصال بخدمة المباريات.")));
    request.on("error", reject);
  });
}

function mapMatchStatus(statusType) {
  const name = statusType?.name || "";
  if (name.includes("POSTPONED")) return "POSTPONED";
  if (name.includes("CANCEL")) return "CANCELED";
  if (name.includes("SUSPEND")) return "SUSPENDED";
  if (statusType?.state === "in") return "IN_PLAY";
  if (statusType?.state === "post") return "FINISHED";
  if (statusType?.state === "pre") return "SCHEDULED";
  return name.replace(/^STATUS_/, "") || "SCHEDULED";
}

function normalizeMatch(event, league) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const home = competitors.find((team) => team.homeAway === "home");
  const away = competitors.find((team) => team.homeAway === "away");
  if (!event.date || !home?.team || !away?.team) return null;

  const homeGoals = Number.isFinite(Number(home.score)) ? Number(home.score) : null;
  const awayGoals = Number.isFinite(Number(away.score)) ? Number(away.score) : null;
  const matchStatus = mapMatchStatus(competition.status?.type);
  const score = { fullTime: { home: homeGoals, away: awayGoals } };

  return {
    id: event.id,
    utcDate: event.date,
    status: matchStatus,
    competition: { id: league.slug, name: league.name },
    homeTeam: { name: home.team.displayName || home.team.name, crest: home.team.logo },
    awayTeam: { name: away.team.displayName || away.team.name, crest: away.team.logo },
    score,
  };
}

async function getMatches(date, response) {
  try {
    const leaguesUrl = new URL(`${footballApiBaseUrl}/leagues`);
    leaguesUrl.searchParams.set("kind", "club");
    leaguesUrl.searchParams.set("available", "true");
    const catalog = await requestJson(leaguesUrl);

    if (!Array.isArray(catalog.leagues)) {
      throw new Error("وصلت قائمة بطولات غير متوقعة من خدمة المباريات.");
    }

    const dateLeagues = catalog.leagues.filter((league) =>
      /^[a-z0-9._-]+$/i.test(league.slug || "")
      && Array.isArray(league.calendar)
      && league.calendar.some((matchDate) => String(matchDate).slice(0, 10) === date));
    const allMatches = [];
    const batchSize = 6;

    for (let index = 0; index < dateLeagues.length; index += batchSize) {
      const batch = dateLeagues.slice(index, index + batchSize);
      const scoreboards = await Promise.all(batch.map(async (league) => {
        const scoreboardUrl = new URL(`${footballApiBaseUrl}/${encodeURIComponent(league.slug)}/scoreboard`);
        scoreboardUrl.searchParams.set("dates", date.replace(/-/g, ""));
        const scoreboard = await requestJson(scoreboardUrl);
        if (!Array.isArray(scoreboard.events)) {
          throw new Error(`وصلت استجابة غير متوقعة لبطولة ${league.name}.`);
        }
        return scoreboard.events
          .map((event) => normalizeMatch(event, league))
          .filter(Boolean);
      }));
      allMatches.push(...scoreboards.flat());
    }

    sendJson(response, 200, { matches: allMatches, count: allMatches.length });
  } catch (error) {
    sendJson(response, 502, {
      error: error.message || "تعذّر الاتصال بخدمة المباريات.",
    });
  }
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "هذه الطريقة غير مدعومة." });
    return;
  }

  if (requestUrl.pathname === "/api/matches") {
    const date = requestUrl.searchParams.get("date");
    if (!isValidDate(date)) {
      sendJson(response, 400, { error: "التاريخ غير صالح. اختر تاريخًا بصيغة صحيحة." });
      return;
    }
    void getMatches(date, response);
    return;
  }

  const file = staticFiles.get(requestUrl.pathname);
  if (!file) {
    sendJson(response, 404, { error: "الصفحة المطلوبة غير موجودة." });
    return;
  }

  const filePath = path.join(publicDirectory, file[0]);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 500, { error: "تعذّر قراءة ملفات الموقع." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' https: data:",
    });
    response.end(content);
  });
});

function listenOnAvailablePort(basePort, maxAttempts = 20) {
  let currentPort = basePort;
  let attempt = 0;

  const tryListen = () => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" && attempt < maxAttempts) {
        attempt += 1;
        currentPort += 1;
        console.warn(`المنفذ ${currentPort - 1} مشغول، جارٍ المحاولة على المنفذ ${currentPort}...`);
        tryListen();
        return;
      }

      throw error;
    });

    server.listen(currentPort, () => {
      console.log(`الموقع يعمل على http://localhost:${currentPort}`);
    });
  };

  tryListen();
}

listenOnAvailablePort(port);
