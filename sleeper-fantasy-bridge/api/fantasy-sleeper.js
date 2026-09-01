const BASE = "https://api.sleeper.app/v1";

let playerCache = {
  fetchedAt: 0,
  data: null,
};

const PLAYER_CACHE_MS = 24 * 60 * 60 * 1000;

async function sleeper(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "sleeper-fantasy-bridge/1.2",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      `Sleeper API ${response.status} for ${path}${
        body ? `: ${body.slice(0, 200)}` : ""
      }`
    );
  }

  return response.json();
}

async function getActivePlayers() {
  const now = Date.now();

  if (
    playerCache.data &&
    now - playerCache.fetchedAt < PLAYER_CACHE_MS
  ) {
    return playerCache.data;
  }

  const players = await sleeper("/players/nfl?active=true");

  playerCache = {
    fetchedAt: now,
    data: players,
  };

  return players;
}

function isRealPlayerId(playerId) {
  return playerId && String(playerId) !== "0";
}

function slimPlayer(playerId, players) {
  if (!isRealPlayerId(playerId)) return null;

  const p = players?.[playerId];

  if (!p) {
    return {
      player_id: playerId,
      full_name: playerId,
      team: String(playerId)?.length <= 4 ? playerId : null,
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

function compactPlayers(ids = [], players) {
  return ids
    .filter(isRealPlayerId)
    .map((id) => slimPlayer(id, players))
    .filter(Boolean);
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
      ? Object.entries(obj)
          .filter(([playerId]) => isRealPlayerId(playerId))
          .map(([playerId, rosterId]) => ({
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
  const starterIds = (entry?.starters ?? []).filter(isRealPlayerId);
  const allIds = (entry?.players ?? []).filter(isRealPlayerId);

  const starterSet = new Set(starterIds.map(String));

  return {
    roster_id: entry?.roster_id ?? null,
    matchup_id: entry?.matchup_id ?? null,
    points: entry?.points ?? 0,
    custom_points: entry?.custom_points ?? null,

    starters: compactPlayers(starterIds, players),

    bench: allIds
      .filter((id) => !starterSet.has(String(id)))
      .map((id) => slimPlayer(id, players))
      .filter(Boolean),
  };
}

function cleanDraftPick(pick, players, usersById) {
  const user = pick.picked_by
    ? usersById[String(pick.picked_by)]
    : null;

  const player =
    slimPlayer(pick.player_id, players) ||
    {
      player_id: pick.player_id,

      full_name:
        [pick.metadata?.first_name, pick.metadata?.last_name]
          .filter(Boolean)
          .join(" ") || pick.player_id,

      team: pick.metadata?.team ?? null,
      position: pick.metadata?.position ?? null,

      fantasy_positions: pick.metadata?.position
        ? [pick.metadata.position]
        : [],

      injury_status: pick.metadata?.injury_status ?? null,
    };

  return {
    pick_no: pick.pick_no,
    round: pick.round,
    draft_slot: pick.draft_slot,
    roster_id: pick.roster_id ?? null,
    picked_by_user_id: pick.picked_by || null,
    picked_by_team: teamNameForUser(user),
    is_keeper: Boolean(pick.is_keeper),
    player,
  };
}

function resolveMyDraftSlot(draft, myRosterId, myUserId) {
  if (!draft) return null;

  if (draft.slot_to_roster_id) {
    const hit = Object.entries(draft.slot_to_roster_id).find(
      ([, rosterId]) =>
        String(rosterId) === String(myRosterId)
    );

    if (hit) {
      return Number(hit[0]);
    }
  }

  if (draft.draft_order?.[myUserId] != null) {
    return Number(draft.draft_order[myUserId]);
  }

  return null;
}

function buildDraftOrder(draft, rosters, usersById) {
  if (!draft) return [];

  if (draft.slot_to_roster_id) {
    return Object.entries(draft.slot_to_roster_id)
      .map(([slot, rosterId]) => {
        const roster = rosters.find(
          (r) => String(r.roster_id) === String(rosterId)
        );

        const owner = roster?.owner_id
          ? usersById[String(roster.owner_id)]
          : null;

        return {
          slot: Number(slot),
          roster_id: Number(rosterId),
          owner_id: roster?.owner_id ?? null,
          team_name: teamNameForUser(owner),
        };
      })
      .sort((a, b) => a.slot - b.slot);
  }

  if (draft.draft_order) {
    return Object.entries(draft.draft_order)
      .map(([userId, slot]) => {
        const roster = rosters.find(
          (r) => String(r.owner_id) === String(userId)
        );

        return {
          slot: Number(slot),
          roster_id: roster?.roster_id ?? null,
          owner_id: userId,

          team_name: teamNameForUser(
            usersById[String(userId)]
          ),
        };
      })
      .sort((a, b) => a.slot - b.slot);
  }

  return [];
}

/*
 * =========================================================
 * DRAFT INTELLIGENCE
 * =========================================================
 */

function overallPickForSnakeRound(round, slot, teams) {
  if (!round || !slot || !teams) return null;

  const roundStart = (round - 1) * teams;

  const positionInRound =
    round % 2 === 1
      ? slot
      : teams - slot + 1;

  return roundStart + positionInRound;
}

function buildMyScheduledPicks(rounds, teams, slot) {
  if (!rounds || !teams || !slot) return [];

  const picks = [];

  for (let round = 1; round <= rounds; round++) {
    const pickNo = overallPickForSnakeRound(
      round,
      slot,
      teams
    );

    picks.push({
      round,
      slot_in_round:
        round % 2 === 1
          ? slot
          : teams - slot + 1,

      overall_pick: pickNo,
    });
  }

  return picks;
}

function emptyPositionCounts() {
  return {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
    K: 0,
    DEF: 0,
    DL: 0,
    LB: 0,
    DB: 0,
    OTHER: 0,
  };
}

function normalizeDraftPosition(player) {
  const position = player?.position;

  if (!position) return "OTHER";

  const known = [
    "QB",
    "RB",
    "WR",
    "TE",
    "K",
    "DEF",
    "DL",
    "LB",
    "DB",
  ];

  if (known.includes(position)) {
    return position;
  }

  /*
   * Sleeper sometimes uses more specific defensive
   * designations. Collapse them into our league buckets.
   */
  if (
    ["DE", "DT", "NT", "EDGE"].includes(position)
  ) {
    return "DL";
  }

  if (
    ["CB", "S", "FS", "SS"].includes(position)
  ) {
    return "DB";
  }

  return "OTHER";
}

function countPositions(picks = []) {
  const counts = emptyPositionCounts();

  for (const pick of picks) {
    const position = normalizeDraftPosition(
      pick.player
    );

    counts[position] =
      (counts[position] || 0) + 1;
  }

  return counts;
}

function detectRecentPositionRun(picks = []) {
  if (picks.length < 3) return null;

  const recent = picks.slice(-8);
  const counts = countPositions(recent);

  const candidates = Object.entries(counts)
    .filter(([position]) => position !== "OTHER")
    .sort((a, b) => b[1] - a[1]);

  const [topPosition, topCount] =
    candidates[0] || [];

  if (!topPosition || topCount < 3) {
    return null;
  }

  return {
    position: topPosition,
    picks_in_last_8: topCount,
    sample_size: recent.length,
  };
}

function buildDraftIntelligence({
  draft,
  cleanedDraftPicks,
  myDraftPicks,
  myDraftSlot,
  myRosterId,
}) {
  if (!draft) return null;

  const teams =
    Number(draft.settings?.teams || 0);

  const rounds =
    Number(draft.settings?.rounds || 0);

  const picksMade =
    cleanedDraftPicks.length;

  const totalExpected =
    teams * rounds;

  const nextOverallPick =
    picksMade < totalExpected
      ? picksMade + 1
      : null;

  const scheduledPicks =
    buildMyScheduledPicks(
      rounds,
      teams,
      myDraftSlot
    );

  const futurePicks =
    scheduledPicks.filter(
      (pick) =>
        pick.overall_pick > picksMade
    );

  const myNextPick =
    futurePicks[0] || null;

  const picksUntilMyTurn =
    myNextPick && nextOverallPick
      ? Math.max(
          0,
          myNextPick.overall_pick -
            nextOverallPick
        )
      : null;

  const isMyTurn =
    myNextPick &&
    nextOverallPick != null
      ? myNextPick.overall_pick ===
        nextOverallPick
      : false;

  const lastMyPick =
    myDraftPicks.length
      ? myDraftPicks[
          myDraftPicks.length - 1
        ]
      : null;

  const playersTakenSinceMyLastPick =
    lastMyPick
      ? cleanedDraftPicks.filter(
          (pick) =>
            pick.pick_no >
            lastMyPick.pick_no
        )
      : cleanedDraftPicks;

  const recentPicks =
    cleanedDraftPicks.slice(-10);

  const myRosterSoFar =
    myDraftPicks.map((pick) => ({
      round: pick.round,
      pick_no: pick.pick_no,
      player: pick.player,
    }));

  return {
    draft_status:
      draft.status ?? null,

    draft_complete:
      totalExpected > 0 &&
      picksMade >= totalExpected,

    next_overall_pick:
      nextOverallPick,

    is_my_turn:
      Boolean(isMyTurn),

    my_next_pick:
      myNextPick,

    picks_until_my_turn:
      picksUntilMyTurn,

    my_future_picks:
      futurePicks,

    my_roster_so_far:
      myRosterSoFar,

    position_counts:
      countPositions(myDraftPicks),

    league_position_counts:
      countPositions(
        cleanedDraftPicks
      ),

    last_10_picks:
      recentPicks,

    recent_position_counts:
      countPositions(recentPicks),

    recent_position_run:
      detectRecentPositionRun(
        cleanedDraftPicks
      ),

    players_taken_since_my_last_pick:
      playersTakenSinceMyLastPick,

    picks_made:
      picksMade,

    total_expected_picks:
      totalExpected || null,

    my_roster_id:
      myRosterId,
  };
}

/*
 * =========================================================
 * MAIN HANDLER
 * =========================================================
 */

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res.status(405).json({
        error: "Method not allowed",
      });
    }

    const username =
      process.env.SLEEPER_USERNAME ||
      req.query.username ||
      "jdavidcrawshaw";

    const requestedLeagueId =
      process.env.SLEEPER_LEAGUE_ID ||
      req.query.league_id ||
      "1391739874570170368";

    const user = await sleeper(
      `/user/${encodeURIComponent(username)}`
    );

    if (!user?.user_id) {
      return res.status(404).json({
        error: `Sleeper user '${username}' was not found.`,
      });
    }

    const nflState =
      await sleeper("/state/nfl");

    const season = String(
      req.query.season ||
        nflState?.league_season ||
        nflState?.season ||
        "2026"
    );

    const week = Math.max(
      1,
      Number(
        req.query.week ||
          nflState?.display_week ||
          nflState?.week ||
          1
      )
    );

    const leagues = await sleeper(
      `/user/${user.user_id}/leagues/nfl/${encodeURIComponent(
        season
      )}`
    );

    if (
      !Array.isArray(leagues) ||
      leagues.length === 0
    ) {
      return res.status(404).json({
        error: `No Sleeper NFL leagues found for ${username} in ${season}.`,
      });
    }

    let league = leagues.find(
      (l) =>
        String(l.league_id) ===
        String(requestedLeagueId)
    );

    if (!league && leagues.length === 1) {
      league = leagues[0];
    }

    if (!league) {
      return res.status(300).json({
        error:
          "Could not uniquely identify the league.",

        available_leagues:
          leagues.map((l) => ({
            league_id: l.league_id,
            name: l.name,
            status: l.status,
          })),
      });
    }

    const [
      rosters,
      leagueUsers,
      matchups,
      transactions,
      trendingAdds,
      trendingDrops,
      players,
      drafts,
    ] = await Promise.all([
      sleeper(
        `/league/${league.league_id}/rosters`
      ),

      sleeper(
        `/league/${league.league_id}/users`
      ),

      sleeper(
        `/league/${league.league_id}/matchups/${week}`
      ),

      sleeper(
        `/league/${league.league_id}/transactions/${week}`
      ),

      sleeper(
        "/players/nfl/trending/add?lookback_hours=24&limit=25"
      ),

      sleeper(
        "/players/nfl/trending/drop?lookback_hours=24&limit=25"
      ),

      getActivePlayers(),

      sleeper(
        `/league/${league.league_id}/drafts`
      ),
    ]);

    const usersById =
      Object.fromEntries(
        (leagueUsers || []).map((u) => [
          String(u.user_id),
          u,
        ])
      );

    const myRoster =
      (rosters || []).find(
        (r) =>
          String(r.owner_id) ===
          String(user.user_id)
      );

    if (!myRoster) {
      return res.status(404).json({
        error:
          "Your user exists in the league, but no owned roster was found.",

        league_id:
          league.league_id,

        league_name:
          league.name,
      });
    }

    const currentDraft =
      (drafts || []).find(
        (d) =>
          String(d.season) ===
          String(season)
      ) ||
      (drafts || [])[0] ||
      null;

    let draftDetails = null;
    let draftPicks = [];

    if (currentDraft?.draft_id) {
      [draftDetails, draftPicks] =
        await Promise.all([
          sleeper(
            `/draft/${currentDraft.draft_id}`
          ),

          sleeper(
            `/draft/${currentDraft.draft_id}/picks`
          ),
        ]);
    }

    const myMatchup =
      (matchups || []).find(
        (m) =>
          Number(m.roster_id) ===
          Number(myRoster.roster_id)
      );

    const opponentMatchup =
      myMatchup?.matchup_id == null
        ? null
        : (matchups || []).find(
            (m) =>
              Number(m.matchup_id) ===
                Number(
                  myMatchup.matchup_id
                ) &&
              Number(m.roster_id) !==
                Number(
                  myRoster.roster_id
                )
          );

    const opponentRoster =
      opponentMatchup
        ? (rosters || []).find(
            (r) =>
              Number(r.roster_id) ===
              Number(
                opponentMatchup.roster_id
              )
          )
        : null;

    const ownedIds =
      new Set(
        (rosters || [])
          .flatMap(
            (r) => r.players || []
          )
          .filter(isRealPlayerId)
          .map(String)
      );

    const freeAgentTrending =
      (items = []) =>
        items
          .filter(
            (item) =>
              !ownedIds.has(
                String(
                  item.player_id
                )
              )
          )
          .map((item) => ({
            count: item.count,

            player: slimPlayer(
              item.player_id,
              players
            ),
          }));

    const myPlayerIds =
      (myRoster.players || [])
        .filter(isRealPlayerId);

    const myPlayers =
      compactPlayers(
        myPlayerIds,
        players
      );

    const starterIds =
      (myRoster.starters || [])
        .filter(isRealPlayerId);

    const starterSet =
      new Set(
        starterIds.map(String)
      );

    const draft =
      draftDetails ||
      currentDraft;

    const myDraftSlot =
      resolveMyDraftSlot(
        draft,
        myRoster.roster_id,
        user.user_id
      );

    const cleanedDraftPicks =
      (draftPicks || [])
        .map((pick) =>
          cleanDraftPick(
            pick,
            players,
            usersById
          )
        )
        .sort(
          (a, b) =>
            a.pick_no - b.pick_no
        );

    const myDraftPicks =
      cleanedDraftPicks.filter(
        (pick) =>
          String(
            pick.roster_id
          ) ===
            String(
              myRoster.roster_id
            ) ||
          String(
            pick.picked_by_user_id
          ) ===
            String(
              user.user_id
            )
      );

    const totalDraftPicksExpected =
      Number(
        draft?.settings?.rounds || 0
      ) *
      Number(
        draft?.settings?.teams ||
          league.total_rosters ||
          0
      );

    const draftIntelligence =
      buildDraftIntelligence({
        draft,
        cleanedDraftPicks,
        myDraftPicks,
        myDraftSlot,

        myRosterId:
          myRoster.roster_id,
      });

    const payload = {
      bridge_version: "1.2.0",

      generated_at:
        new Date().toISOString(),

      sleeper: {
        user: {
          user_id:
            user.user_id,

          username:
            user.username,

          display_name:
            user.display_name,
        },

        nfl_state:
          nflState,
      },

      league: {
        league_id:
          league.league_id,

        name:
          league.name,

        season:
          league.season,

        status:
          league.status,

        total_rosters:
          league.total_rosters,

        roster_positions:
          league.roster_positions,

        scoring_settings:
          league.scoring_settings,

        settings:
          league.settings,
      },

      my_team: {
        roster_id:
          myRoster.roster_id,

        team_name:
          teamNameForUser(
            usersById[
              String(user.user_id)
            ]
          ),

        record: {
          wins:
            myRoster.settings?.wins ??
            0,

          losses:
            myRoster.settings?.losses ??
            0,

          ties:
            myRoster.settings?.ties ??
            0,

          points_for:
            pointsFromRosterSettings(
              myRoster.settings
            ),

          points_against:
            pointsAgainstFromRosterSettings(
              myRoster.settings
            ),
        },

        waiver: {
          position:
            myRoster.settings
              ?.waiver_position ??
            null,

          budget_used:
            myRoster.settings
              ?.waiver_budget_used ??
            null,
        },

        starters:
          compactPlayers(
            starterIds,
            players
          ),

        bench:
          myPlayers.filter(
            (p) =>
              !starterSet.has(
                String(
                  p.player_id
                )
              )
          ),

        reserve:
          compactPlayers(
            myRoster.reserve || [],
            players
          ),
      },

      draft: draft
        ? {
            draft_id:
              draft.draft_id,

            status:
              draft.status,

            type:
              draft.type,

            season:
              draft.season,

            season_type:
              draft.season_type,

            start_time:
              draft.start_time
                ? new Date(
                    Number(
                      draft.start_time
                    )
                  ).toISOString()
                : null,

            created:
              draft.created
                ? new Date(
                    Number(
                      draft.created
                    )
                  ).toISOString()
                : null,

            last_picked:
              draft.last_picked
                ? new Date(
                    Number(
                      draft.last_picked
                    )
                  ).toISOString()
                : null,

            settings: {
              teams:
                draft.settings?.teams ??
                null,

              rounds:
                draft.settings?.rounds ??
                null,

              pick_timer_seconds:
                draft.settings
                  ?.pick_timer ??
                null,

              reversal_round:
                draft.settings
                  ?.reversal_round ??
                null,
            },

            expected_total_picks:
              totalDraftPicksExpected ||
              null,

            my_draft_slot:
              myDraftSlot,

            draft_order:
              buildDraftOrder(
                draft,
                rosters || [],
                usersById
              ),

            picks_made:
              cleanedDraftPicks.length,

            picks_remaining:
              totalDraftPicksExpected >
              0
                ? Math.max(
                    0,
                    totalDraftPicksExpected -
                      cleanedDraftPicks.length
                  )
                : null,

            picks:
              cleanedDraftPicks,

            my_picks:
              myDraftPicks,
          }
        : null,

      /*
       * NEW IN v1.2
       */
      draft_intelligence:
        draftIntelligence,

      current_week: {
        week,

        my_matchup:
          myMatchup
            ? cleanMatchup(
                myMatchup,
                players
              )
            : null,

        opponent:
          opponentMatchup
            ? {
                ...cleanMatchup(
                  opponentMatchup,
                  players
                ),

                roster_id:
                  opponentRoster
                    ?.roster_id ??
                  opponentMatchup
                    .roster_id,

                owner:
                  opponentRoster
                    ? teamNameForUser(
                        usersById[
                          String(
                            opponentRoster
                              .owner_id
                          )
                        ]
                      )
                    : null,
              }
            : null,
      },

      transactions:
        (transactions || [])
          .filter(
            (tx) =>
              tx.status ===
              "complete"
          )
          .map((tx) =>
            cleanTransaction(
              tx,
              players
            )
          ),

      trending_free_agents: {
        adds_24h:
          freeAgentTrending(
            trendingAdds
          ),

        drops_24h:
          freeAgentTrending(
            trendingDrops
          ),
      },

      league_teams:
        (rosters || []).map(
          (r) => ({
            roster_id:
              r.roster_id,

            owner_id:
              r.owner_id,

            team_name:
              teamNameForUser(
                usersById[
                  String(
                    r.owner_id
                  )
                ]
              ),

            wins:
              r.settings?.wins ??
              0,

            losses:
              r.settings
                ?.losses ??
              0,

            ties:
              r.settings?.ties ??
              0,

            points_for:
              pointsFromRosterSettings(
                r.settings
              ),
          })
        ),
    };

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=15, stale-while-revalidate=30"
    );

    return res
      .status(200)
      .json(payload);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Failed to build Sleeper fantasy summary.",

      detail:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
