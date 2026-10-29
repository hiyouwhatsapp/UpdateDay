# UpdateDay guide

The full reference. New here? Start with the [README](../README.md).

Free, open-source update-day automation for Roblox games. You give it an Open
Cloud API key and an update time. It runs the countdown icons, sale, game page
text, event, place publish and server restarts on schedule.

- **Your key stays with you.** It's read from an environment variable and only
  ever sent to `apis.roblox.com`. There's no UpdateDay server.
- **No cookies, no logins.** Everything goes through official Open Cloud
  endpoints. See [docs/COVERAGE.md](COVERAGE.md).
- **Safe sales.** Original prices are written to a state file *before* anything
  is discounted, every write is read back, and `restore` puts everything back
  at any time.
- **Runs anywhere.** Use your own PC (`watch`), or a free GitHub Actions cron
  so it keeps going with your PC off.
- **Nothing is forced.** Every feature is optional and off until you turn it on.

## What it does

| Step | When |
|---|---|
| Creates a Roblox event for the update | Right away |
| Saves your current game icon | Right away |
| Countdown icons, built automatically from your icon + hourglass + time badge | At each mark (24h … 5m, NOW) |
| Game name / description changes | Any offset, e.g. `24h`, `0`, `+7d` |
| In-game warnings via MessagingService | e.g. 10m, 5m, 1m before |
| Publishes your place file | At update time |
| Restarts old servers, with optional bleed-off | At update time |
| Sale: X% off passes and products | At update time, for N hours |
| Original icon back, or your new update image if `newIcon` is set | After the admin-abuse window |

If it starts late, it catches up. Stale countdown icons and late warnings are
skipped, not spammed.

## The setup page

```bash
npx updateday ui updateday.json
```

Opens a page on `http://127.0.0.1:4747` (only reachable from your own PC), with light and dark themes and a phone layout:

- **Countdown**: a live preview of the icon players see, every stage (click to switch one off), the full schedule, the icon look, your own hourglass art, and a .zip of every icon
- **Sale**: discount, when it runs (or the admin-abuse hour in one click), name tags like `[30% OFF]`, and which passes and products
- **Events**: create, edit and delete Roblox events, or have one made for every update
- **Game page**: your page as players see it, with a checklist before the update
- **Player data**: look up a player, edit their save as fields or JSON, with a backup before every change
- **Gifts**: send a player something through your game's gift box
- **History**: everything UpdateDay did, searchable, with a CSV download
- **Settings**: games, update time and repeats, alerts, server restarts and in-game warnings

The bar at the bottom shows what happens next, with **Check plan**, **Start**, **Stop**, **Dry run** and **Undo all**.

Everything it saves is the same `updateday.json` the commands below use, so you can switch
between the page and the terminal freely. Keys pasted into the page stay in memory and
are never written to disk.

## Quick start

1. Install Node.js 22.18 or newer. (From a clone of this repo, use `node src/cli.ts` wherever this says `npx updateday`.)
2. Create an API key in Creator Hub → **Open Cloud → API Keys**, add your
   experience, and give it the scopes for the features you use:
   `legacy-universe:manage`, `game-pass:read/write`,
   `developer-product:read/write`, `universe.event:write`,
   `universe-messaging-service:publish`, `universe:write`,
   `universe-places:write`.
3. Copy `example/updateday.json` and edit it. The minimum is `universeId` and
   `updateAt`. You don't need any images: run `preview` to see the countdown
   icons it will build from your live game icon.
4. Run:

```bash
export UPDATEDAY_API_KEY=your-key
npx updateday plan updateday.json
npx updateday preview updateday.json
npx updateday check updateday.json
npx updateday watch updateday.json
```

Use `tick --dry-run` to see what would run right now without touching anything.

### Countdown icon options

All optional, under `countdown` in the config:

| Key | Default | What it does |
|---|---|---|
| `marks` | `24h 12h 6h 5h 4h 3h 2h 1h 45m 30m 15m 10m 5m` | When icons change (a NOW icon is always added) |
| `style` | `original` | `original` (the hand-drawn set with the time drawn in), or a text-free style: `classic`, `pixel`, `rounded`, `glow`, `blocky`, `outline`. Styles draw the time text in code |
| `hourglassSize`, `hourglassY` | `0.66`, `0.4` | With a style: hourglass size, and the height of its centre (0 = top, 1 = bottom) |
| `textSize`, `textY` | `0.15`, `0.85` | With a style: text size, and the height of its centre |
| `labels` | none | Your own text for any stage, e.g. `{ "6h": "6 HRS!", "now": "LIVE!" }` |
| `anchor` | `center` | Where the hourglass goes: `top-right`, `top-left`, `bottom-right`, `bottom-left`, `center`, or `full` for art drawn to cover the whole icon |
| `scale` | `0.88` | Hourglass size as a fraction of the icon |
| `dim` | `0.45` | Opacity of the dark layer over the game icon, `0` for none |
| `overlayDir` | bundled hourglasses | Your own art: `24h.png`, `5m.png`, … (with the time text drawn in), plus an optional `default.png` without text |
| `label` | `true` | For marks with no art of their own, draw the time text under `default.png` |
| `labelColor`, `labelOutline` | white, black | Colours of that drawn text |
| `customDir` | none | Fully hand-made icons per mark (`24h.png` …), used instead of generating |
| `skip` | `[]` (every stage on) | Stages to leave out, e.g. `["5h", "4h", "10m"]`; `"now"` works too |
| `newIcon` | none | Your new update image; it replaces the original at the end |
| `newIconAt` | `end` | `now` shows the NOW hourglass over the new image at update time, then the clean new image after the admin-abuse hour |

The bundled set covers every default mark plus NOW. Any other mark, such as
`10m`, uses the plain hourglass with the time drawn underneath in the same style.

Set `"countdown": false` to leave the icon alone.

#### How the icon changes on Roblox

Roblox doesn't let API keys change a game's main icon, so there are two modes:

- **`"iconMethod": "reminder"`** (default): at each stage UpdateDay saves the finished icon to
  `updateday-icons/` and the setup page shows it with a Download button, so you can upload it in Creator Hub.
- **`"iconMethod": "languageSwap"`**: fully automatic. UpdateDay briefly makes another language the
  game's source language (the least-used one, or `swapLanguage`), then sets the countdown as every other
  language's icon. Each stage goes up `uploadLeadSeconds` early (default 90) because Roblox reviews
  every icon upload, which takes about 30 seconds. At the end it removes the countdown icons, puts back any
  translated icons you already had, and restores the source language. Players whose Roblox language is the
  temporary one see your normal icon. A *new* update icon still has to be uploaded in Creator Hub at the end;
  you get a reminder.

In swap mode every language gets its own label ("24 STUNDEN", "24 ЧАСА", "24時間" and so on), with
correct plurals. English keeps the hand-drawn art. Set `"localizeLabels": false` to use English everywhere.
Run `doctor` (or **Check key** in the page) first: it lists any permission the key is missing.

#### Picking stages

Every stage is on by default. List the ones you don't want in `skip`, and the
rest of the schedule stays the same. If you skip `now`, the final icon goes up
right at update time instead of waiting out the admin-abuse hour.

#### A new icon for the update

```json
"countdown": {
	"newIcon": "update-5-icon.png",
	"newIconAt": "now"
}
```

With `newIconAt: "end"`, the default, the countdown runs on your old icon and the
new one replaces it after the admin-abuse hour. With `"now"`, the NOW hourglass
appears on top of the new image the moment the update goes live, so players see
both at once, and the clean new image follows after the admin-abuse hour.

### Title countdown

```json
"title": { "format": "[{time}] {name}", "nowFormat": "[LIVE] {name}", "afterFormat": "{name}" }
```

Puts the time left in the game's title at every stage: "[6H] Your Game", "[45M] Your Game", then "[LIVE] Your Game"
at update time. After the admin-abuse hour, `afterFormat` is used: `{name}` puts the original title back, or name the
update, e.g. `"{name} [UPDATE 5]"`. `{time}` becomes `6H`, `45M` and so on, and `{name}` is the title the game had
when the run started. The real title is saved first, **Undo all** puts it back, and titles are kept to 50 characters.
It follows the countdown's stages (or its own `marks`) and works with the icon countdown switched off too.
Needs the `universe.place:write` permission.

The countdown title shows to players whose Roblox language is your game's main (source) language. Players in other
languages keep seeing Roblox's translation of your normal title, which isn't touched and is never left stale.

### Moderation check

**Countdown → Stages → Check with moderation** uploads each stage's icon to your Roblox inventory as a private image,
so Roblox reviews it days before the update instead of at the moment it goes up. Each stage then shows Approved,
In review or Rejected, and **Check plan** flags a rejected icon. Only icons that changed since the last check are sent
again. Needs the `asset:read` and `asset:write` permissions.

### Your own hourglass art

In the page: **Countdown → Hourglass art → My own art**, then click any stage to upload its art.
Stages you don't upload use your default art with the time drawn on it, or the built-in hourglass.
In the config this is `countdown.overlayDir` (see the table above).

### Check before you go

`npx updateday check` (or **Check plan** in the page) runs a pre-flight: the key's permissions, the update
time, missing files, every countdown icon rendering, which items will go on sale, the event's timing and
your alerts. **Start** runs the same check and tells you if something needs fixing, but you can start anyway.

### Repeating updates

```json
"repeat": { "every": "week", "until": "2027-01-01T00:00:00Z" }
```

`every` is `day`, `week`, `2weeks` or `month`. Once an update day is over (countdown, admin-abuse hour, sale
and event all done), the plan moves to the next one by itself, and fixed sale times move with it. `watch`
and the page keep running between them.

### Alerts

```json
"notify": { "events": ["reminders", "failures", "live", "finished"], "mention": "@here" }
```

Posts to a Discord channel through a webhook: when an icon needs uploading (with the icon attached), when
something fails, when the update goes live and when everything is done. Add `"steps"` for every single step.
The webhook link is read from `UPDATEDAY_DISCORD_WEBHOOK` (or `notify.discordWebhookEnv`), or pasted into the
page for the session. Like the key, it's never written to disk. The page can also show desktop alerts while it's open.

### History

Everything UpdateDay does (each step, every price it changes and puts back, reminders and problems) is
appended to `updateday-history.jsonl` next to your plan. The **History** tab shows it.

### AI agents (MCP)

`npx updateday mcp updateday.json` runs UpdateDay as an MCP server, so Claude, Cursor and other agents can read
and change the plan, run the pre-flight check, preview icons, list sale items and read the history. Anything that
changes the live game (`run_due_steps`, `restore_everything`) needs `confirm: true`, and runs default to a dry run.

```json
{
	"mcpServers": {
		"updateday": {
			"command": "npx",
			"args": ["updateday", "mcp", "/path/to/updateday.json"],
			"env": { "UPDATEDAY_API_KEY": "your-key" }
		}
	}
}
```

### Several games at once

Put shared settings at the top and list the games under `games`. Each game can
override anything: its own `updateAt`, `"sale": false`, a different
`countdown` look, and so on. Sections like `countdown` and `sale` merge, so a game only
lists what's different. Games owned by a different user or group can name their
own key variable with `apiKeyEnv`. See `example/multi-game.json`.

Every command runs for all games; add `--game "Main Game"` (or the universe ID)
to pick one. Each game keeps its own state file, `updateday.<universeId>.state.json`,
so a problem in one game never blocks the others.

### With your PC off (GitHub Actions)

Put `updateday.json` and your icons in a private repo, add the key as the
repository secret `UPDATEDAY_API_KEY` (and `UPDATEDAY_DISCORD_WEBHOOK` for alerts), and copy
`templates/github-actions/updateday.yml` into `.github/workflows/`. It ticks
every 5 minutes and commits its progress file back. GitHub cron can run a few
minutes late.

### In-game countdown

Turn on **Warn players in live servers**, then download the Roblox kit (**Settings → Download kit**, or the
`roblox/` folder):

| File | Goes in | What it does |
|---|---|---|
| `UpdateDayListener.luau` | ServerScriptService (ModuleScript) | Receives UpdateDay's warnings |
| `UpdateDayCountdown.server.luau` | ServerScriptService (Script) | Shares the update time with every player |
| `UpdateDayBanner.client.luau` | StarterPlayerScripts (LocalScript) | An "UPDATE IN 04:59" banner players can close, warning toasts, and "THE UPDATE IS LIVE!" |
| `UpdateDayGifts.luau` | ServerScriptService (ModuleScript) | Optional: the gift box behind the Gifts tab |

Colours, text, and how early the banner shows are constants at the top of each file. To use the banner
without warnings, set `MANUAL_UPDATE_AT` in `UpdateDayCountdown.server.luau`.

Or use the listener directly:

```lua
local UpdateDayListener = require(path.to.UpdateDayListener)

UpdateDayListener.OnWarning(function(updateUnix, mark)
	-- show "Update in 5 minutes!"
end)
UpdateDayListener.Start()
```

## Tests

```bash
npm test          # unit tests, a full update day against a fake Roblox with rate limits,
                  # server errors and a crash mid-sale, edge cases and the local server's security
npm run test:ui   # every tab at desktop and phone width in both themes (needs Chrome; set CHROME_PATH)
```

## Status

Tested live on a real game: sales with exact restore, name tags, events, warnings, server restarts, name
changes, the key check and the fully automatic language-swap countdown. Player data and gifts are tested
against a fake Roblox but still need a live run.

MIT licensed.
