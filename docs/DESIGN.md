# CADBot — Design Document

CADBot is a single-server Discord bot for a League of Legends community/organization
that runs multiple teams sharing one Discord server. It handles account linking,
player availability, team management, scrim scheduling between teams, scrim result
tracking, tryouts, and op.gg lookups.

- **Library:** Discord.js v14
- **Interface:** Slash commands only (buttons / modals / select menus for multi-step flows)
- **Persistence:** Local JSON files (no database, no external API beyond Riot)
- **Scope:** Single Discord guild (set via `GUILD_ID`)

---

## 1. Architecture

```
cadbot.js                      Entry point: TZ setup, client, wiring, scheduler boot
core/js/
  module_handler.js            Discovers modules/commands, registers slash commands,
                               routes interactions, enforces permission tiers
  event_registry.js            Discovers per-module event handlers; shares core singletons
  interaction_adapter.js       Adapts a slash interaction to a message-like API
  data_manager.js              Cached read/write for all local JSON files
  permission_handler.js        Permission tier checks (role-based + owner override)
  log_handler.js               Winston logger (console + timestamped file)
  text_utils.js                Long-message splitter
modules/
  core/                        /ping /help /reload
  admin/                       Team/role/channel management (ADMIN tier)
  league/                      Player-facing features + events.js (all components)
    lib/
      availability_utils.js    Time parsing, overlap matcher, timezone conversion
      riot_api.js              Riot Account-V1 / Summoner-V4 / League-V4 calls
data/                          config, players, teams, availability, scrims, sessions (JSON)
docs/                          This document + validation report
```

### Module system

Each module folder has a `bot_module.json`:

```json
{ "name": "league", "display_name": "League of Legends", "enabled": true,
  "commands_directory": "commands", "is_core": false, "event_handler": "events.js" }
```

- `ModuleHandler.discover_modules()` loads enabled modules.
- `discover_commands()` `require()`s every `.js` in the commands directory and attaches the logger.
- `EventRegistry.discover_event_handlers()` calls each module's `event_handler` file, passing the registry.

### Command contract

Every command exports:

```js
module.exports = {
  name: 'create_team',
  description: 'Create a new team.',
  permission: 'ADMIN',          // tier required (see §2)
  no_defer: false,              // true => command handles its own first reply (modals)
  ephemeral: false,             // true => deferred reply is ephemeral
  options: [ { name, description, type, required, choices?, autocomplete?, min_value?, max_value? } ],
  async autocomplete(interaction) { ... },   // optional
  async execute(message, args, extra) { ... }
};
```

`extra` always provides `{ data, permissions, interaction }`, plus `module_handler` for core-module commands.
`message` is an `InteractionAdapter` so `message.channel.send(...)` maps to `interaction.editReply/followUp`.

### Interaction routing

- **Slash commands** → `module_handler.handle_slash_command()` (permission check → defer → execute).
- **Autocomplete** → `module_handler.handle_autocomplete()`.
- **Buttons / modals / selects** → `league/events.js` via a single `interactionCreate` listener, dispatched by `customId` prefix.

### Shared singletons (important)

`cadbot.js` constructs exactly one `DataManager` and one `PermissionHandler`.
`EventRegistry.discover_event_handlers()` copies those references onto itself
(`data_manager`, `permissions`) and `events.js` reads them in `register_handlers()`.
This guarantees the command handlers and the event handlers share **one** in-memory
cache — preventing stale reads after writes.

---

## 2. Permission tiers

Defined in `core/js/permission_handler.js`. Lower number = higher authority.

| Tier | Who satisfies it |
|------|------------------|
| `OWNER` (0) | Hardcoded Discord ID `185223223892377611` — bypasses all checks |
| `ADMIN` (1) | Members with the configured admin role |
| `CAPTAIN` (2) | Members with the captain role, **or** the admin role |
| `MEMBER` (3) | Players assigned to any team, **or** captain/admin |
| `TRYOUT` (4) | Players with the tryout role, **or** captain/admin |
| `EVERYONE` (5) | Anyone |

- A command declares its required tier with `permission: 'TIER'`.
- The check runs in `handle_slash_command()` **before** the command executes.
- `_hasRole()` accepts both `GuildMember.roles.cache` and raw API `roles` arrays.
- Role IDs are stored in `data/config.json` and set at runtime via `/set_role`.

> The owner override is unconditional, satisfying "as the creator I should have all perms."

---

## 3. Data model (`data/*.json`)

### config.json
```json
{ "admin_role_id": "", "captain_role_id": "", "tryout_role_id": "",
  "scrim_channel_id": "", "log_channel_id": "",
  "timezone": "America/New_York", "region": "na1" }
```

### players.json — keyed by Discord user ID
```json
{ "<discordId>": {
    "discord_id", "riot_id": "Name#TAG", "puuid", "summoner_id", "account_id",
    "summoner_level", "team_id", "team_role": "Top|Jungle|Mid|Bot|Support",
    "team_type": "Main|Substitute", "is_tryout": false, "linked_at" } }
```

### teams.json — keyed by team UUID
```json
{ "<uuid>": { "id", "name", "discord_role_id", "captain_id", "created_at" } }
```

### availability.json — keyed by Discord user ID
```json
{ "<discordId>": {
    "discord_id",
    "weekly": { "monday": [ {"start":"19:00","end":"22:00"} ], ... "sunday": [] },
    "overrides": { "2025-07-04": [ {"start":"14:00","end":"18:00"} ],
                   "2025-07-05": null } } }   // null = explicitly unavailable
```

### scrims.json — keyed by scrim UUID
```json
{ "<uuid>": {
    "id", "team1_id", "team2_id",
    "status": "pending|confirmed|declined|completed|disputed",
    "scheduled_time", "scheduled_end", "discord_event_id",
    "requested_by", "include_subs", "allow_fill", "fill_interests": [],
    "result_embed_posted": false, "result_message_id": "",
    "players_team1": [], "players_team2": [],
    "result": null | {
        "winner": "<teamId>", "submitted_by", "submitted_at",
        "roster_submitter", "players_team1", "players_team2",
        "notes", "disputed", "disputed_by", "disputed_at" },
    "created_at" } }
```

### sessions.json — tryout / custom-game sessions, keyed by UUID
```json
{ "<uuid>": { "id", "type", "name", "date", "time", "spots",
    "open_to": "tryout|member|everyone", "created_by", "created_at",
    "channel_id", "message_id", "status": "open|closed", "interested": [] } }
```

---

## 4. Feature designs

### 4.1 Account linking — `/link`, `/unlink`
- `/link` posts an ephemeral embed with a **Link Riot Account** button.
- The button opens a modal collecting the Riot ID (`Name#TAG`).
- On submit: `riot_api.lookupRiotId()` calls Account-V1 (by-riot-id) → PUUID → Summoner-V4 (by-puuid).
- The player record is created/updated (preserving any existing team assignment).
- `/unlink` removes your record; admins may unlink another user.
- **Region:** `RIOT_REGION` (platform, default `na1`) and `RIOT_REGIONAL_ROUTING` (default `americas`).

### 4.2 Availability — `/availability`
- Weekly recurring baseline **plus** date-specific overrides (per the chosen design).
- `/availability` shows an ephemeral embed of your current schedule with buttons:
  - **Set Weekdays** → modal with 5 inputs (Mon–Fri)
  - **Set Weekend** → modal with 2 inputs (Sat–Sun)
  - **Add Date Override** → modal (date + times, or `none` = unavailable)
  - **View Overrides**, **Clear All**
- Time entry accepts `7pm-10pm`, `19:00-22:00`, comma-separated for multiple ranges.
- Stored as `HH:MM` 24-hour strings, interpreted in the league timezone.
- Viewing another player's availability is read-only.

### 4.3 Teams & roster — admin commands + `/roster`, `/teams`, `/profile`
- `/create_team name [role]`, `/delete_team team` (unassigns all members).
- `/assign_player player team position type` — position ∈ {Top,Jungle,Mid,Bot,Support}, type ∈ {Main,Substitute}; assigns the team role if configured. Requires the player to have linked.
- `/unassign_player player`, `/set_captain player team`, `/mark_tryout player status`.
- `/roster [team]`, `/teams`, `/profile [player]` (profile pulls live ranked stats from League-V4).

### 4.4 Roles & channels — `/create_role`, `/set_role`, `/set_channel`
- `/create_role name [color] [hoist] [mentionable]` creates a Discord role.
- `/set_role type:(admin|captain|tryout) role` stores the role ID used by the tier system.
- `/set_channel type:(scrim|log) channel` stores destination channels.

### 4.5 Scrims — `/scrim`
Request flow:
1. Captain runs `/scrim vs:<team> [include_subs] [allow_fill]` (ephemeral).
2. The matcher (`availability_utils.findScrimSlots`) scans the next 14 days for windows
   where **≥5 players are free per team simultaneously for ≥60 minutes**.
   - Eligible pool: starters only by default; `include_subs:true` adds substitutes
     to widen the range. (30-minute slot granularity.)
3. Up to 5 candidate slots are shown in a select menu (cached in memory for 15 min).
4. On selection, a scrim record is created and a request is posted to the **scrim channel**,
   pinging the opposing captain, with **Accept / Decline** (+ optional **fill interest** button
   if `allow_fill`, for members *outside* either team).
5. **Accept** → status `confirmed`, a Discord **scheduled event** is created, the requester is DM'd.
   **Decline** → status `declined`, requester notified.

> **Manual override:** if a team can't field 5, captains can still proceed and substitute
> players via the result tracker's **Edit Players** modal and/or the `allow_fill` interest list.

### 4.6 Scrim result tracking (button-driven, with `/record` fallback)
- A 60-second **poller** (started in `events.js`, uses the client from the event registry)
  watches for `confirmed` scrims whose `scheduled_time` has arrived and whose result embed
  hasn't been posted.
- At start time it posts a **result tracker** to the scrim channel, **pings both captains**,
  shows both starting rosters, and offers **[Team 1 Win] [Team 2 Win] [Edit Players]**.
- **First click wins:** any captain (or admin) records the winner; the embed updates and the
  opposing captain gets a **Dispute** button (flags admins / posts to the log channel).
- **Edit Players** opens a modal so a captain can set who actually played for their team
  (subs / fills). Admins may edit too.
- **Restart-safe:** scrims whose start passed while the bot was offline are posted on the next poll.
- **`/record`** remains as a manual fallback (select a confirmed scrim → modal Win/Loss + roster).
  It refuses to double-record a scrim that already has a result.

Agreement model = "first submission wins, opposing captain may dispute" (admin resolves disputes).

### 4.7 Tryouts & custom games — `/tryout`
- `/tryout create name date time [spots] [type] [open_to]` (ADMIN) posts an embed with an
  **I'm Interested** button.
- `open_to` gates who may express interest: `tryout` (tryout role), `member` (any team member),
  or `everyone`.
- `/tryout list`, `/tryout view session` (interested list), `/tryout close session` (ADMIN).
- Mechanic = "express interest / sign up"; admins pick from the interest list manually.

### 4.8 op.gg — `/opgg`
- `/opgg [player] [team]` — individual profile or full-team multi-search link.
- Permission tier `MEMBER` ("everyone on a team, or an admin").
- op.gg region slug derived from `RIOT_REGION` (`na1` → `na`). See §6 limitations for non-NA regions.

---

## 5. Timezone handling

- `cadbot.js` sets `process.env.TZ` from `config.timezone` **before** any `Date` is created,
  so day-of-week / calendar-date logic in the matcher is consistent regardless of the host's TZ.
- `availability_utils.toUnixTimestamp()` converts a league-local wall-clock time to a correct
  UTC Unix timestamp using a DST-aware `Intl.DateTimeFormat` offset calculation
  (validated: 7:00 PM EDT on 2025-07-04 → `1751670000`).
- Discord renders all `<t:unix>` stamps and scheduled events in each viewer's local time.

---

## 6. Known limitations / future work

- **op.gg region mapping** is exact for NA (`na1`→`na`). EUNE/LAN/LAS/OCE use op.gg-specific
  slugs (`eune`, `lan`, `las`, `oce`) that the simple `\d+$` strip doesn't produce; revisit if
  the org expands beyond NA.
- **Deleting a team** unassigns players in data but does not strip their team Discord role; the
  same applies when reassigning a captain (the previous captain keeps the captain role). These are
  intentional to avoid accidental mass role changes; can be automated later.
- **Scrim result viewing** (team W/L history / standings) was deferred by request — only result
  *submission* is implemented for now.
- **Ranked stats** use League-V4 `by-summoner`; if Riot fully deprecates summoner IDs, switch to
  the `by-puuid` entries endpoint.
- **In-memory scrim-slot cache** (15-min TTL) is lost on restart; an in-flight `/scrim` selection
  would need to be re-run after a restart.
