# UpdateDay for AI agents

This page is written for AI agents (and the people setting them up). UpdateDay runs a Roblox game's update day:
countdown icons and titles, a sale, an event, in-game warnings and server restarts. Its MCP server lets you read
and change the plan, check it, preview icons and run it, all with the user's own API key.

## Setup

Run it from the folder that holds the plan (`updateday.json`):

```bash
npx updateday mcp updateday.json
```

Claude Code:

```bash
claude mcp add updateday -e UPDATEDAY_API_KEY=your-key -- npx updateday mcp /path/to/updateday.json
```

Claude Desktop, Cursor and other clients (`mcpServers` in their config file):

```json
{
	"mcpServers": {
		"updateday": {
			"command": "npx",
			"args": ["updateday", "mcp", "/path/to/updateday.json"],
			"env": {
				"UPDATEDAY_API_KEY": "the Open Cloud API key",
				"UPDATEDAY_DISCORD_WEBHOOK": "optional Discord webhook link for alerts"
			}
		}
	}
}
```

If `updateday.json` doesn't exist yet, create it with at least `universeId` and `updateAt` (see the example below).

## Tools

| Tool | What it does | Changes the live game? |
|---|---|---|
| `get_plan` | The raw plan file plus a summary of every game: update time, countdown, sale, event, alerts | No |
| `change_plan` | Changes the plan with a JSON merge patch. The result is checked before it's saved | No (the plan file only) |
| `get_schedule` | Every step of the update day in order, with its time and whether it already ran | No |
| `check_plan` | Pre-flight: key permissions, times, files, icons, sale items, moderation, alerts | No |
| `preview_icon` | Renders one countdown icon as an image (stage: `24h`, `1h`, `5m`, `now`, `final` …) | No |
| `list_sale_items` | The game's passes and developer products with prices | No |
| `get_history` | What UpdateDay did and when, newest first | No |
| `run_due_steps` | Runs every step that is due now. Defaults to a dry run | **Yes**, with `dry_run: false` and `confirm: true` |
| `restore_everything` | Undo: every price, name, title and icon back to normal | **Yes**, needs `confirm: true` |

Every tool takes an optional `game` (name or universe ID). Leave it out to cover every game in the plan.

## How to work with it

1. **Read first.** Call `get_plan`, then `check_plan`. Lines with level `bad` must be fixed. `warn` is worth telling
   the user about; `info` is just information.
2. **Change the plan with small patches.** `change_plan` takes an [RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)
   merge patch: objects merge, arrays and plain values replace, and `null` removes a key.
3. **Show before you act.** Use `preview_icon` and `get_schedule` to show the user what will happen, and confirm the
   update time *with its time zone* before saving it.
4. **Ask before anything live.** Only call `run_due_steps` with `dry_run: false` or `restore_everything` once the user
   has said yes in this conversation. Pass `confirm: true` only then.
5. **Times are ISO 8601 with a time zone**, e.g. `2026-11-07T18:00:00Z`. Turn "Saturday 6pm my time" into UTC and say
   which time you used.

The plan is a file, so changes made through MCP also show up in the setup page (`npx updateday ui`), and the other
way round.

## Plan examples

A minimal plan:

```json
{ "universeId": 1234567890, "name": "My Game", "updateAt": "2026-11-07T18:00:00Z" }
```

Patches for common requests:

```jsonc
// "Move the update to Saturday 6 PM UTC"
{ "updateAt": "2026-11-07T18:00:00Z" }

// "30% off everything for 48 hours, with a tag on the names"
{ "sale": { "percentOff": 30, "durationHours": 48, "gamePasses": "all", "developerProducts": "all", "nameTag": "[{percent}% OFF]" } }

// "Only put game passes 111 and 222 on sale"
{ "sale": { "gamePasses": [111, 222], "developerProducts": [] } }

// "Countdown in the title too, and call it Update 5 afterwards"
{ "title": { "afterFormat": "{name} [UPDATE 5]" } }

// "Pixel hourglass, a bit bigger, and say LIVE! at NOW"
{ "countdown": { "style": "pixel", "hourglassSize": 0.74, "labels": { "now": "LIVE!" } } }

// "Skip the 5 and 4 hour stages"
{ "countdown": { "skip": ["5h", "4h"] } }

// "Warn players 10, 5 and 1 minutes before, and restart old servers"
{ "broadcast": { "topic": "UpdateDay", "marks": ["10m", "5m", "1m"] }, "restartServers": { "bleedOffMinutes": 5 } }

// "Do this every week"
{ "repeat": { "every": "week" } }

// "Turn the sale off"
{ "sale": null }
```

Every setting is described in the [guide](GUIDE.md).

## Things to know

- **The main game icon can't be set with an API key.** With `"iconMethod": "reminder"` (the default) the user uploads
  each finished icon themselves when reminded. With `"languageSwap"` it's automatic. Explain this if the user expects
  the icon to change by itself.
- **Sales and titles are always undone.** Originals are saved before anything changes. `restore_everything` puts them
  back at any time, and running it twice is safe.
- **Nothing runs on its own from MCP.** `run_due_steps` does one check, like a single tick. To run a whole update day,
  the user starts it in the setup page, with `npx updateday watch`, or with GitHub Actions.
- **Keys never go in the plan file.** They come from environment variables (`UPDATEDAY_API_KEY`, or the variable a
  game names in `apiKeyEnv`).
