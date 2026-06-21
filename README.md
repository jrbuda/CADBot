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
   - Manage Roles (create/assign team, captain, tryout roles)
   - Manage Events (create scrim scheduled events)
   - Send Messages, Embed Links, Read Message History
3. Make sure the bot's role is **above** any roles it needs to assign.

## Run (development)

```bash
node cadbot.js
```

On first boot the bot registers all slash commands to your `GUILD_ID` and logs in.

## First-run configuration (in Discord)

Run these once, as the owner or an admin:

```
/set_role type:admin   role:@Admins
/set_role type:captain role:@Captains
/set_role type:tryout  role:@Tryouts
/set_channel type:scrim channel:#scrims
/set_channel type:log   channel:#staff-log
```

Then build out teams:

```
/create_team name:"Team Alpha" [role:@TeamAlpha]
/assign_player player:@User team:Team Alpha position:Mid type:Main [captain:true]
```

Players onboard themselves:

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

**Core**
- `/ping`, `/help`, `/reload` (owner)

**Admin** (admin tier)
- `/create_team`, `/delete_team`, `/assign_player` (with optional `captain` flag), `/unassign_player`
- `/mark_tryout`, `/set_role`, `/set_channel`, `/team_channel`

**League**
- `/link`, `/unlink`, `/availability`, `/profile`, `/roster`, `/opgg`
- `/scrim` (captain), `/record` (captain, fallback), `/game` (create/list/view/close sessions)

---

## Data & backups

All state lives in `data/*.json` (`config`, `players`, `teams`, `availability`,
`scrims`, `sessions`). Back up the `data/` folder to preserve everything. `logs/` and
`.env` are git-ignored.

## Security

- Never commit `.env`. Rotate the Riot key if it leaks.
- The owner ID is hardcoded in `core/js/permission_handler.js`; change it there if ownership changes.
