const MODES = {
  coming_up: `
The user's next draft pick is approaching.

Give:
- One clear preferred target.
- 3 realistic alternatives.
- A very short reason for each.
- A contingency note about what could happen before their pick.

Prioritise decision usefulness over exhaustive analysis.
`,

  on_clock: `
THE USER IS ON THE CLOCK.

Be extremely concise.

Give:
1. PICK: your preferred player.
2. BACKUPS: up to three alternatives in order.
3. WHY: no more than three short sentences.

Do not waste time explaining basic fantasy concepts.
`,

  what_happened: `
Analyse the selections since the user's previous pick.

Explain:
- What changed materially.
- Any genuine positional run.
- Whether the market changed the user's priorities.
- Any value that may now be falling.

Do not recommend reacting to a run merely because it exists.
`,

  best_value: `
Give a compact view of the best currently available value by position.

Cover:
QB, RB, WR, TE, DL, LB and DB where useful.

Focus particularly on positions relevant to the user's roster construction and league scoring.
Do not imply the user must draft a position simply because it is empty.
`,
};

function getOrigin(req) {
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  const protocol =
    req.headers["x-forwarded-proto"] ||
    "https";

  return `${protocol}://${host}`;
}

function extractOutputText(data) {
  const pieces = [];

  for (const item of data.output || []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content || []) {
      if (
        content.type === "output_text" &&
        content.text
      ) {
        pieces.push(content.text);
      }
    }
  }

  return pieces.join("\n").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const {
      mode,
      pin,
      question,
    } = req.body || {};

    /*
     * Protect the API route.
     * The OpenAI key NEVER goes to the browser.
     */
    if (
      !process.env.WAR_ROOM_PIN ||
      !pin ||
      String(pin) !==
        String(process.env.WAR_ROOM_PIN)
    ) {
      return res.status(401).json({
        error: "War Room authorisation failed.",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY is not configured.",
      });
    }

    const validMode =
      MODES[mode]
        ? mode
        : question
          ? "custom"
          : null;

    if (!validMode) {
      return res.status(400).json({
        error: "Unknown coaching mode.",
      });
    }

    /*
     * Get a FRESH copy of the board.
     * The browser does not provide draft facts.
     */
    const origin = getOrigin(req);

    const roomResponse =
      await fetch(
        `${origin}/api/draft-room?t=${Date.now()}`,
        {
          cache: "no-store",

          headers: {
            Accept: "application/json",
          },
        }
      );

    if (!roomResponse.ok) {
      throw new Error(
        `Draft Room returned ${roomResponse.status}`
      );
    }

    const room =
      await roomResponse.json();

    if (!room.draft) {
      throw new Error(
        "Draft state is unavailable."
      );
    }

    const modeInstruction =
      validMode === "custom"
        ? `
Answer the user's specific fantasy football question:

${String(question).slice(0, 1000)}
`
        : MODES[validMode];

    const systemPrompt = `
You are the Draft Captain inside the Basingstoke Doughnuts fantasy football War Room.

Your job is ADVISORY ONLY.

The human manager always makes the final selection.

You give options, context, probabilities, roster implications and a preferred recommendation where appropriate.

Never claim you have drafted, added, dropped, benched or started a player.

CURRENT DATE:
${new Date().toISOString()}

LEAGUE CONTEXT:

This is a 10-team Sleeper redraft league.

Starting offensive lineup:
QB
RB
RB
WR
WR
TE
FLEX
FLEX
K
DEF

Starting IDP:
DL
DL
LB
LB
DB
DB

Bench:
5 players

Important scoring characteristics:

FULL PPR.

Offensive:
Receiving reception = 1
Passing TD = 4
Passing yard = 0.04
Rushing/receiving yard = 0.1
Rushing/receiving TD = 6
Interception thrown = -1
Fumble lost = -2

IDP:
Solo tackle = 2
Assist = 1
TFL = 2
Sack = 6
INT = 6
Pass defended = 3
Forced fumble = 3
Fumble recovery = 3
QB hit = 1
Defensive TD = 6
Safety = 3
Blocked kick = 3

These IDP settings mean defensive players matter substantially more than in casual IDP formats.

IMPORTANT DECISION RULES:

Use the supplied Sleeper draft state as authoritative for:
- players already selected
- current roster
- draft order
- pick number
- position counts
- recent selections

Never recommend a player who has already been drafted.

Use web search when current information matters.

For player evaluation, prioritise CURRENT 2026 information including:
- injuries
- practice status
- roster status
- depth chart
- suspensions
- role changes
- current fantasy rankings
- ADP where useful
- credible beat/reporting information

Do not blindly copy generic rankings.

Adjust recommendations for THIS league's:
- full PPR scoring
- ten-team replacement value
- two FLEX positions
- one starting QB
- six IDP starters
- unusually valuable IDP big-play scoring

Consider the fact that the user's draft slot creates nine selections between consecutive picks.

Do not manufacture injuries, rankings or news.

If web information conflicts or is unclear, say so briefly.

STYLE:

You are a calm, experienced coach in a draft operations room.

Be decisive without pretending certainty.

Plain English.

Short paragraphs.

Some personality is welcome.

No giant essays during the draft.

Do not refer to yourself as an AI.
`;

    const userPrompt = `
COACHING REQUEST:

${modeInstruction}

LIVE DRAFT ROOM STATE:

${JSON.stringify(room, null, 2)}
`;

    /*
     * OpenAI Responses API.
     *
     * Terra gives us a good balance between
     * intelligence, latency and cost.
     */
    const openAIResponse =
      await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            model: "gpt-5.6-terra",

            reasoning: {
              effort:
                validMode === "on_clock"
                  ? "low"
                  : "medium",
            },

            tools: [
              {
                type: "web_search",

                search_context_size:
                  validMode === "on_clock"
                    ? "low"
                    : "medium",
              },
            ],

            instructions:
              systemPrompt,

            input:
              userPrompt,

            max_output_tokens:
              validMode === "on_clock"
                ? 650
                : 1200,
          }),
        }
      );

    const openAIData =
      await openAIResponse.json();

    if (!openAIResponse.ok) {
      console.error(
        "OpenAI error:",
        openAIData
      );

      return res.status(502).json({
        error:
          "Draft Captain could not contact OpenAI.",

        detail:
          openAIData?.error?.message ||
          `OpenAI returned ${openAIResponse.status}`,
      });
    }

    const text =
      extractOutputText(
        openAIData
      );

    if (!text) {
      throw new Error(
        "OpenAI returned no coaching text."
      );
    }

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.status(200).json({
      mode: validMode,

      response: text,

      generated_at:
        new Date().toISOString(),

      draft_snapshot: {
        status:
          room.draft.status,

        next_overall_pick:
          room.draft.next_overall_pick,

        my_next_pick:
          room.draft.my_next_pick,

        picks_until_my_turn:
          room.draft.picks_until_my_turn,

        picks_made:
          room.draft.picks_made,
      },
    });
  } catch (error) {
    console.error(
      "Draft Captain error:",
      error
    );

    return res.status(500).json({
      error:
        "Draft Captain suffered a headset malfunction.",

      detail:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
