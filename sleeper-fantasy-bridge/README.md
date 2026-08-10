# Sleeper Fantasy Bridge

A tiny read-only Vercel endpoint that turns Sleeper league data into one clean JSON payload for analysis.

Configured by default for:

- Sleeper username: `jdavidcrawshaw`
- Sport: NFL
- Season: resolved from Sleeper's `/state/nfl` endpoint

## What it returns

- Sleeper user and current NFL state
- League name, roster structure and full scoring settings
- Your record, starters, bench, reserve and waiver position
- Current week's matchup and opponent
- Completed transactions for the current week
- Trending adds/drops that are currently unowned in your league
- Lightweight player metadata (name, team, position, injury status, etc.)
- League team/record summary

This is read-only. It cannot make roster moves.

## Deploy to Vercel

1. Put this folder in a GitHub repository.
2. Import the repo into Vercel.
3. Add environment variable:

   `SLEEPER_USERNAME=jdavidcrawshaw`

4. If you have more than one Sleeper NFL league in 2026, the first request will return HTTP 300 with the available league IDs. Copy the desired ID and set:

   `SLEEPER_LEAGUE_ID=<your league id>`

5. Deploy.

Your endpoint will then be:

`https://<your-project>.vercel.app/api/fantasy-sleeper`

## Useful query parameters

You can override defaults temporarily:

- `?username=jdavidcrawshaw`
- `?season=2026`
- `?week=1`
- `?league_id=123456789`

Example:

`/api/fantasy-sleeper?season=2026&week=1`

## Local development

Install the Vercel CLI if needed:

```bash
npm i -g vercel
```

Then:

```bash
vercel dev
```

Open:

`http://localhost:3000/api/fantasy-sleeper`

## Important note about player data

Sleeper documents its full NFL player map as a large response and asks consumers not to fetch it frequently. This bridge therefore:

- requests only `active=true` players;
- caches the result in module memory for 24 hours on warm Vercel instances;
- maps only the player IDs needed in the returned response.

For a personal, low-traffic bridge this is deliberately simple. If we later make scheduled analytics run frequently, the next upgrade should persist the daily player map in a proper cache/database.

## Next upgrade

The useful v2 is not "more JSON"; it is analysis-ready enrichment:

- weekly NFL statistics;
- snap share;
- targets/carries;
- tackles/sacks/pressures for IDP;
- injuries/practice participation;
- projected/actual fantasy scoring using *your league's exact scoring settings*.

That would let ChatGPT identify waiver targets and start/sit decisions rather than merely inspect the roster.
