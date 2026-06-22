# CADBot

A single-server Discord bot for a League of Legends community that runs multiple
teams in one shared server. It links Riot accounts, tracks player availability,
manages teams and rosters, schedules and records scrims between teams, runs tryout
sign-ups, and produces op.gg links.

- **Discord.js v14**, slash commands only
- **Local JSON storage** (no database)
- **Riot API** for account linking and ranked stats
- Designed to run on a Linux server as a `systemd` service

See [`docs/DESIGN.md`](docs/DESIGN.md) for architecture and feature design, and
[`docs/VALIDATION.md`](docs/VALIDATION.md) for the validation report and test checklist.

---

## Requirements

- Node.js 18+
- A Discord application + bot token
- A Riot Games API key (production)

## Install

```bash
git clone git@github.com:jrbuda/CADBot.git
cd CADBot
npm install
cp .env.example .env      # then edit .env
```

## Configure `.env`

```
DISCORD_TOKEN=...            # Bot token (Developer Portal → Bot)
APPLICATION_ID=...          # Application (client) ID
GUILD_ID=...                # Your server ID (slash commands register here instantly)
STARTUP_CHANNEL_ID=         # Optional: channel for the "online" message
RIOT_API_KEY=...            # Riot production key
RIOT_REGION=na1             # Platform routing (na1, euw1, eun1, kr, ...)
RIOT_REGIONAL_ROUTING=americas   # americas | europe | asia | sea
```

## Discord Developer Portal setup

1. **Bot → Privileged Gateway Intents:** enable **Server Members Intent**.
2. **Invite the bot** with the `applications.commands` scope and a `bot` scope including:
   - Manage Roles (create/assign team, captain, tryout, and position roles)
   - Manage Events (create scrim scheduled events)
   - Send Messages, Embed Links, Read Message History
3. Make sure the bot's role is **above** any roles it needs to assign.

## Run (development)

```bash
node cadbot.js
```

On first boot the bot registers all slash commands to your `GUILD_ID` and logs in.

## First-run configuration (in Discord)

Run these as the bot owner. **Two commands** to get the entire league set up:

**Step 1 — Server config:**
```
/setup server admin_role:@Admins captain_role:@Captains tryout_role:@Tryouts scrim_channel:#scrims log_channel:#staff-log
```

**Step 2 — Create teams (repeat for each team):**
```
/setup team name:"Team Alpha" short_name:"ALS" captain:@Player1
         top:@Player1 jungle:@Player2 mid:@Player3 bot:@Player4 support:@Player5
         sub1:@Player6 sub2:@Player7
```

That's it. The bot auto-creates all Discord roles and assigns players with the correct permissions.

### What gets auto-created per team

| Role | Who gets it |
|------|-------------|
| `{Team} Captain` (gold) | The captain |
| `{Team}` | All 5 starters |
| `{Team} Sub` (gray) | All substitutes |

Plus **server-wide position roles** (`@Top`, `@Jungle`, `@Mid`, `@Bot`, `@Support`) — auto-created on first use for pinging entire roles across teams.

### Players onboard themselves

```
/link            # connect Riot account
/availability    # set weekly schedule + date overrides
```

---

## Deploy as a systemd service (Linux)

Create `/etc/systemd/system/cadbot.service`:

```ini
[Unit]
Description=CADBot Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bots
WorkingDirectory=/home/bots/CADBot
ExecStart=/usr/bin/node cadbot.js
Restart=on-failure
RestartSec=5
# Environment is read from the project's .env via dotenv; no EnvironmentFile needed.

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cadbot
sudo systemctl status cadbot
journalctl -u cadbot -f          # live logs (also written to ./logs)
```

To deploy an update:

```bash
git pull
npm install
sudo systemctl restart cadbot
```

> Tip: create an empty `updated.txt` in the project root before restarting to make the
> bot post the "updated" startup message instead of the normal "online" message.

---

## Command reference

### Core
| Command | Tier | Description |
|---------|------|-------------|
| `/ping` | Everyone | Health check |
| `/help` | Everyone | Paginated command browser by permission tier |
| `/reload` | Owner | Hot-reload all commands, libraries, events, and slash definitions |
| `/setup server` | Owner | Configure admin/captain/tryout roles, scrim/log channels in one command |
| `/setup team` | Admin | Create a team with full roster (5 starters + 2 subs + captain) in one command |

### Admin
| Command | Tier | Description |
|---------|------|-------------|
| `/create_team` | Admin | Create a team (auto-creates Captain, Main, and Sub Discord roles) |
| `/delete_team` | Admin | Delete a team and unassign all players |
| `/assign_player` | Admin | Assign a player to a team with position, type, and optional captain promotion |
| `/unassign_player` | Admin | Remove a player from their team |
| `/mark_tryout` | Admin | Mark/unmark a player as a tryout |
| `/set_role` | Admin | Link a Discord role to an admin, captain, or tryout tier |
| `/set_channel` | Admin | Set the scrim, log, or tryout announcements channel |
| `/team_channel` | Captain | Set the game session channel for your team |

### League
| Command | Tier | Description |
|---------|------|-------------|
| `/link` | Everyone | Link your Riot ID (GameName#TAG) to your Discord |
| `/unlink` | Everyone | Unlink your Riot account |
| `/availability` | Everyone | View/set weekly schedule and date overrides; compare with another player or team |
| `/profile` | Everyone | View a player's linked account, team info, and ranked stats |
| `/roster` | Everyone | View a team's roster or list all teams |
| `/opgg` | Everyone | Generate op.gg profile or multi-search links |
| `/scrim internal` | Captain | Challenge another team via availability matching or manual date/time |
| `/scrim external` | Captain | Schedule a scrim against an external team |
| `/record` | Captain | Manually submit a scrim result (fallback for the auto-posted result embed) |
| `/game create` | Captain | Create a tryout, custom game, or practice session |
| `/game list` | Everyone | List all active sessions |
| `/game view` | Everyone | View who signed up for a session |
| `/game close` | Captain | Close a session you created |

### Scrim options

`/scrim internal` and `/scrim external` accept these optional parameters:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `date` | String | — | Specific date (YYYY-MM-DD), skips availability matching |
| `time` | String | — | Start time (e.g. `7pm`, `19:00`), requires `date` |
| `include_subs` | Boolean | false | Count substitutes toward the 5-player minimum |
| `allow_fill` | Boolean | false | Let non-team members click to show fill interest |
| `expires_in` | Integer | 24 | Hours until the slot selection or proposal expires (1–72) |

---

## Data & backups

All state lives in `data/*.json` (`config`, `players`, `teams`, `availability`,
`scrims`, `sessions`, `captain_prefs`). Back up the `data/` folder to preserve everything.
`logs/` and `.env` are git-ignored.

## Security

- Never commit `.env`. Rotate the Riot key if it leaks.
- The owner ID is hardcoded in `core/js/permission_handler.js`; change it there if ownership changes.
