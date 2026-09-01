function getOrigin(req) {
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  const protocol =
    req.headers["x-forwarded-proto"] ||
    "https";

  return `${protocol}://${host}`;
}

function positionFromPick(pick) {
  return (
    pick?.player?.position ||
    pick?.player?.fantasy_positions?.[0] ||
    null
  );
}

function normalizePosition(position) {
  if (!position) return "OTHER";

  if (["DE", "DT", "NT", "EDGE"].includes(position)) {
    return "DL";
  }

  if (["CB", "S", "FS", "SS"].includes(position)) {
    return "DB";
  }

  return position;
}

function createRecentPickSummary(pick) {
  return {
    pick_no: pick.pick_no,
    round: pick.round,
    draft_slot: pick.draft_slot,
    roster_id: pick.roster_id,
    team_name: pick.picked_by_team,

    player: {
      player_id: pick.player?.player_id ?? null,
      full_name: pick.player?.full_name ?? null,
      team: pick.player?.team ?? null,

      position: normalizePosition(
        positionFromPick(pick)
      ),

      raw_position:
        pick.player?.position ?? null,

      injury_status:
        pick.player?.injury_status ?? null,
    },
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res.status(405).json({
        error: "Method not allowed",
      });
    }

    const origin = getOrigin(req);

    const response = await fetch(
      `${origin}/api/fantasy-sleeper`,
      {
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const detail = await response
        .text()
        .catch(() => "");

      throw new Error(
        `Fantasy bridge returned ${response.status}${
          detail ? `: ${detail.slice(0, 200)}` : ""
        }`
      );
    }

    const source = await response.json();

    const draft = source.draft;
    const intelligence =
      source.draft_intelligence;

    if (!draft || !intelligence) {
      return res.status(200).json({
        bridge_version:
          source.bridge_version,

        room_version: "1.0.0",

        generated_at:
          new Date().toISOString(),

        league: {
          name: source.league?.name ?? null,
          status:
            source.league?.status ?? null,
        },

        my_team: {
          team_name:
            source.my_team?.team_name ?? null,
          roster_id:
            source.my_team?.roster_id ?? null,
        },

        draft: null,

        message:
          "No active draft information is available.",
      });
    }

    const teams =
      Number(draft.settings?.teams || 0);

    const rounds =
      Number(draft.settings?.rounds || 0);

    const picks =
      (draft.picks || []).map(
        createRecentPickSummary
      );

    const myRoster =
      intelligence.my_roster_so_far?.map(
        (pick) => ({
          round: pick.round,
          pick_no: pick.pick_no,

          player: {
            player_id:
              pick.player?.player_id ?? null,

            full_name:
              pick.player?.full_name ?? null,

            nfl_team:
              pick.player?.team ?? null,

            position:
              normalizePosition(
                positionFromPick(pick)
              ),

            injury_status:
              pick.player?.injury_status ??
              null,
          },
        })
      ) || [];

    const liveDraft =
      draft.status === "drafting";

    const payload = {
      bridge_version:
        source.bridge_version,

      room_version: "1.0.0",

      generated_at:
        new Date().toISOString(),

      league: {
        league_id:
          source.league?.league_id,

        name:
          source.league?.name,

        status:
          source.league?.status,

        roster_positions:
          source.league?.roster_positions,

        scoring_settings:
          source.league?.scoring_settings,
      },

      my_team: {
        roster_id:
          source.my_team?.roster_id,

        team_name:
          source.my_team?.team_name,

        starters:
          source.my_team?.starters || [],

        bench:
          source.my_team?.bench || [],

        waiver:
          source.my_team?.waiver || null,
      },

      draft: {
        draft_id:
          draft.draft_id,

        status:
          draft.status,

        type:
          draft.type,

        start_time:
          draft.start_time,

        teams,
        rounds,

        pick_timer_seconds:
          draft.settings
            ?.pick_timer_seconds ??
          null,

        expected_total_picks:
          draft.expected_total_picks,

        picks_made:
          draft.picks_made,

        picks_remaining:
          draft.picks_remaining,

        next_overall_pick:
          intelligence.next_overall_pick,

        my_draft_slot:
          draft.my_draft_slot,

        my_next_pick:
          intelligence.my_next_pick,

        picks_until_my_turn:
          intelligence.picks_until_my_turn,

        is_my_turn:
          intelligence.is_my_turn,

        draft_complete:
          intelligence.draft_complete,

        draft_order:
          draft.draft_order || [],

        picks,

        my_roster:
          myRoster,

        my_future_picks:
          intelligence.my_future_picks || [],

        position_counts:
          intelligence.position_counts,

        league_position_counts:
          intelligence.league_position_counts,

        recent_position_counts:
          intelligence.recent_position_counts,

        recent_position_run:
          intelligence.recent_position_run,

        last_10_picks:
          (
            intelligence.last_10_picks || []
          ).map(createRecentPickSummary),

        players_taken_since_my_last_pick:
          (
            intelligence.players_taken_since_my_last_pick ||
            []
          ).map(createRecentPickSummary),
      },

      trending: {
        adds:
          source.trending_free_agents
            ?.adds_24h
            ?.slice(0, 10) || [],

        drops:
          source.trending_free_agents
            ?.drops_24h
            ?.slice(0, 10) || [],
      },
    };

    /*
     * During the live draft we always want fresh state.
     * Before/after the draft, a tiny cache is fine.
     */
    res.setHeader(
      "Cache-Control",
      liveDraft
        ? "no-store"
        : "public, s-maxage=15, stale-while-revalidate=30"
    );

    return res.status(200).json(payload);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Failed to build Draft Room state.",

      detail:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
