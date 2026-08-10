const BASE = "https://api.sleeper.app/v1";

// Module-level cache survives warm Vercel invocations.
// Sleeper recommends updating the player map no more than once per day.
let playerCache = {
  fetchedAt: 0,
  data: null,
};

const PLAYER_CACHE_MS = 24 * 60 * 60 * 1000;

async function sleeper(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "sleeper-fantasy-bridge/1.0"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Sleeper API ${response.status} for ${path}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }

  return response.json();
}

async function getActivePlayers() {
  const now = Date.now();

  if (playerCache.data && now - playerCache.fetchedAt < PLAYER_CACHE_MS) {
    return playerCache.data;
  }

  // Filtered active-player response is much smaller than the full player map.
  const players = await sleeper("/players/nfl?active=true");

  playerCache = {
    fetchedAt: now,
    data: players,
  };

  return players;
}

function slimPlayer(playerId, players) {
  const p = players?.[playerId];

  // Team defences can appear as IDs such as "BUF", "PHI", etc.
  if (!p) {
    return {
      player_id: playerId,
      full_name: playerId,
      team: playerId?.length <= 4 ? playerId : null,
      position: null,
      fantasy_positions: [],
      injury_status: null,
    };
  }

  return {
    player_id: playerId,
    full_name:
      p.full_name ||
      [p.first_name, p.last_name].filter(Boolean).join(" ") ||
      playerId,
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    team: p.team ?? null,
    position: p.position ?? null,
    fantasy_positions: p.fantasy_positions ?? [],
    status: p.status ?? null,
    injury_status: p.injury_status ?? null,
    practice_participation: p.practice_participation ?? null,
    depth_chart_position: p.depth_chart_position ?? null,
    depth_chart_order: p.depth_chart_order ?? null,
    age: p.age ?? null,
    years_exp: p.years_exp ?? null,
  };
}

function pointsFromRosterSettings(settings = {}) {
  const base = Number(settings.fpts ?? 0);
  const decimal = Number(settings.fpts_decimal ?? 0);
  return base + decimal / 100;
}

function pointsAgainstFromRosterSettings(settings = {}) {
  const base = Number(settings.fpts_against ?? 0);
  const decimal = Number(settings.fpts_against_decimal ?? 0);
  return base + decimal / 100;
}

function teamNameForUser(user) {
  return (
    user?.metadata?.team_name ||
    user?.metadata?.team_name_update ||
    user?.display_name ||
    user?.username ||
    null
  );
}

function cleanTransaction(tx, players) {
  const mapPlayers = (obj) =>
    obj
      ? Object.entries(obj).map(([playerId, rosterId]) => ({
          roster_id: rosterId,
          player: slimPlayer(playerId, players),
        }))
      : [];

  return {
    transaction_id: tx.transaction_id,
    type: tx.type,
    status: tx.status,
    created: tx.created,
    status_updated: tx.status_updated,
    roster_ids: tx.roster_ids ?? [],
    adds: mapPlayers(tx.adds),
    drops: mapPlayers(tx.drops),
    waiver_bid: tx.settings?.waiver_bid ?? null,
    waiver_budget: tx.waiver_budget ?? [],
  };
}

function cleanMatchup(entry, players) {
  const starterIds = entry?.starters ?? [];
  const allIds = entry?.players ?? [];
  const starterSet = new Set(starterIds);

  return {
    roster_id: entry?.roster_id ?? null,
    matchup_id: entry?.matchup_id ?? null,
    points: entry?.points ?? 0,
    custom_points: entry?.custom_points ?? null,
    starters: starterIds.map((id) => slimPlayer(id, players)),
    bench: allIds
      .filter((id) => !starterSet.has(id))
      .map((id) => slimPlayer(id, players)),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const username =
      process.env.SLEEPER_USERNAME ||
      req.query.username ||
      "jdavidcrawshaw";

    const requestedLeagueId =
      process.env.SLEEPER_LEAGUE_ID ||
      req.query.league_id ||
      null;

    // 1) Resolve immutable Sleeper user ID.
    const user = await sleeper(`/user/${encodeURIComponent(username)}`);

    if (!user?.user_id) {
      return res.status(404).json({
        error: `Sleeper user '${username}' was not found.`,
      });
    }

    // 2) Use Sleeper's own current NFL state to resolve season/week.
    const nflState = await sleeper("/state/nfl");
    const season =
      String(req.query.season || nflState?.league_season || nflState?.season || "2026");

    const week = Math.max(
      1,
      Number(req.query.week || nflState?.display_week || nflState?.week || 1)
    );

    // 3) Find the user's leagues for that season.
    const leagues = await sleeper(
      `/user/${user.user_id}/leagues/nfl/${encodeURIComponent(season)}`
    );

    if (!Array.isArray(leagues) || leagues.length === 0) {
      return res.status(404).json({
        error: `No Sleeper NFL leagues found for ${username} in ${season}.`,
        user: {
          user_id: user.user_id,
          username: user.username,
          display_name: user.display_name,
        },
        nfl_state: nflState,
      });
    }

    let league;

    if (requestedLeagueId) {
      league = leagues.find((l) => String(l.league_id) === String(requestedLeagueId));

      if (!league) {
        return res.status(404).json({
          error: `League ${requestedLeagueId} was not found among ${username}'s ${season} NFL leagues.`,
          available_leagues: leagues.map((l) => ({
            league_id: l.league_id,
            name: l.name,
            status: l.status,
          })),
        });
      }
    } else if (leagues.length === 1) {
      league = leagues[0];
    } else {
      // Don't silently choose the wrong league.
      return res.status(300).json({
        error: "Multiple Sleeper leagues found. Set SLEEPER_LEAGUE_ID or pass ?league_id=...",
        available_leagues: leagues.map((l) => ({
          league_id: l.league_id,
          name: l.name,
          status: l.status,
          roster_positions: l.roster_positions,
        })),
      });
    }

    // 4) Pull league data concurrently.
    const [
      rosters,
      leagueUsers,
      matchups,
      transactions,
      trendingAdds,
      trendingDrops,
      players,
    ] = await Promise.all([
      sleeper(`/league/${league.league_id}/rosters`),
      sleeper(`/league/${league.league_id}/users`),
      sleeper(`/league/${league.league_id}/matchups/${week}`),
      sleeper(`/league/${league.league_id}/transactions/${week}`),
      sleeper("/players/nfl/trending/add?lookback_hours=24&limit=25"),
      sleeper("/players/nfl/trending/drop?lookback_hours=24&limit=25"),
      getActivePlayers(),
    ]);

    const usersById = Object.fromEntries(
      (leagueUsers || []).map((u) => [String(u.user_id), u])
    );

    const myRoster = (rosters || []).find(
      (r) => String(r.owner_id) === String(user.user_id)
    );

    if (!myRoster) {
      return res.status(404).json({
        error: "Your user exists in the league, but no owned roster was found.",
        league_id: league.league_id,
        league_name: league.name,
      });
    }

    const myMatchup = (matchups || []).find(
      (m) => Number(m.roster_id) === Number(myRoster.roster_id)
    );

    const opponentMatchup =
      myMatchup?.matchup_id == null
        ? null
        : (matchups || []).find(
            (m) =>
              Number(m.matchup_id) === Number(myMatchup.matchup_id) &&
              Number(m.roster_id) !== Number(myRoster.roster_id)
          );

    const opponentRoster = opponentMatchup
      ? (rosters || []).find(
          (r) => Number(r.roster_id) === Number(opponentMatchup.roster_id)
        )
      : null;

    const ownedIds = new Set(
      (rosters || []).flatMap((r) => r.players || []).map(String)
    );

    const freeAgentTrending = (items = []) =>
      items
        .filter((item) => !ownedIds.has(String(item.player_id)))
        .map((item) => ({
          count: item.count,
          player: slimPlayer(item.player_id, players),
        }));

    const myPlayers = (myRoster.players || []).map((id) =>
      slimPlayer(id, players)
    );

    const starterSet = new Set((myRoster.starters || []).map(String));

    const payload = {
      generated_at: new Date().toISOString(),

      sleeper: {
        user: {
          user_id: user.user_id,
          username: user.username,
          display_name: user.display_name,
        },
        nfl_state: nflState,
      },

      league: {
        league_id: league.league_id,
        name: league.name,
        season: league.season,
        status: league.status,
        total_rosters: league.total_rosters,
        roster_positions: league.roster_positions,
        scoring_settings: league.scoring_settings,
        settings: league.settings,
      },

      my_team: {
        roster_id: myRoster.roster_id,
        team_name: teamNameForUser(usersById[String(user.user_id)]),
        record: {
          wins: myRoster.settings?.wins ?? 0,
          losses: myRoster.settings?.losses ?? 0,
          ties: myRoster.settings?.ties ?? 0,
          points_for: pointsFromRosterSettings(myRoster.settings),
          points_against: pointsAgainstFromRosterSettings(myRoster.settings),
        },
        waiver: {
          position: myRoster.settings?.waiver_position ?? null,
          budget_used: myRoster.settings?.waiver_budget_used ?? null,
        },
        starters: (myRoster.starters || []).map((id) =>
          slimPlayer(id, players)
        ),
        bench: myPlayers.filter((p) => !starterSet.has(String(p.player_id))),
        reserve: (myRoster.reserve || []).map((id) =>
          slimPlayer(id, players)
        ),
      },

      current_week: {
        week,
        my_matchup: myMatchup ? cleanMatchup(myMatchup, players) : null,
        opponent: opponentMatchup
          ? {
              ...cleanMatchup(opponentMatchup, players),
              roster_id: opponentRoster?.roster_id ?? opponentMatchup.roster_id,
              owner: opponentRoster
                ? teamNameForUser(usersById[String(opponentRoster.owner_id)])
                : null,
            }
          : null,
      },

      transactions: (transactions || [])
        .filter((tx) => tx.status === "complete")
        .map((tx) => cleanTransaction(tx, players)),

      trending_free_agents: {
        adds_24h: freeAgentTrending(trendingAdds),
        drops_24h: freeAgentTrending(trendingDrops),
      },

      league_teams: (rosters || []).map((r) => ({
        roster_id: r.roster_id,
        owner_id: r.owner_id,
        team_name: teamNameForUser(usersById[String(r.owner_id)]),
        wins: r.settings?.wins ?? 0,
        losses: r.settings?.losses ?? 0,
        ties: r.settings?.ties ?? 0,
        points_for: pointsFromRosterSettings(r.settings),
      })),
    };

    // This endpoint itself is safe to cache briefly.
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300"
    );

    return res.status(200).json(payload);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Failed to build Sleeper fantasy summary.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
