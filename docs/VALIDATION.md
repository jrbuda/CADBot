# CADBot — Validation Report

This document records how the implementation was validated against the original
request, the issues found and fixed during validation, and a manual test checklist
for the interaction-driven flows that require a live Discord connection.

---

## 1. Validation methods

| Method | What it covered | Result |
|--------|-----------------|--------|
| `node --check` on all 33 `.js` files | Syntax of every source file | All pass |
| Load-test harness | Module/command discovery, command shape (`name`+`execute`), permission tiers valid, slash-name resolution ≤32, event-handler registration, availability math | All pass |
| Targeted audit harness | Shared-instance identity, write→read cache coherency, modal label/title length ≤45, `_hasRole` for cache + array members | All pass |
| Scheduler integration test | `checkDueScrims` posts at start time, pings both captains, populates rosters, ignores future scrims, idempotent, recorded embed exposes Dispute | All pass |
| `npm install` | Dependency resolution | OK (4 advisories inherited from discord.js deps) |

Test harnesses live outside the repo (run during validation); the production data
files in `data/` were never mutated (verified via `git diff -- data/`).

### Key numeric proof (timezone)
`toUnixTimestamp(2025-07-04, 19:00, America/New_York)` must equal `1751670000`
(7 PM EDT = 23:00 UTC). Pre-fix it returned `1751666400` (off by one hour); post-fix
it returns `1751670000`.

---

## 2. Requirements traceability

### Base parameters
| Requirement | Status | Where |
|-------------|--------|-------|
| Discord.js v14 | Met | `package.json` (`^14.26.4`) |
| Slash commands | Met | `module_handler.register_slash_commands()` |
| Permission tiers in `module.exports` | Met | `permission:` field + `permission_handler.js` |
| Owner `185223223892377611` has all perms | Met | `OWNER_ID` override in `permission_handler.js` |
| Runs on Linux as a service, Node installed | Met | `README.md` systemd unit; no Windows-only code |
| Riot prod key from `.env` | Met | `riot_api.js` reads `RIOT_API_KEY` |
| Local files, no DB | Met | `data_manager.js` + `data/*.json` |

### Features
| # | Requirement | Status | Where |
|---|-------------|--------|-------|
| 1 | `/link` pulls Riot account data | Met | `commands/link.js`, `events.js` link modal, `lib/riot_api.js` |
| 2 | Involved availability (modals), not full calendar | Met | `commands/availability.js`, availability modals in `events.js`, `lib/availability_utils.js` |
| 3 | Admins create teams; assign players Main/Sub + Top/Jungle/Mid/Bot/Support | Met | `admin/create_team.js`, `assign_player.js`, `set_captain.js` |
| 4 | Captains `/scrim` vs other teams using both availabilities | Met | `commands/scrim.js`, `findScrimSlots` |
| 4a | Optional flag to include subs (widen range) | Met | `include_subs` option |
| 4b | Optional flag to let outside members fill (button) | Met | `allow_fill` → fill-interest button (guards non-team members) |
| 4c | Approved scrim creates a Discord event | Met | `handleScrimAccept` → `guild.scheduledEvents.create` |
| 5 | Admins mark tryouts; link tryout role; tryouts bid/sign up | Met | `admin/mark_tryout.js`, `set_role.js`, `commands/tryout.js` (express interest) |
| 6 | Admins create roles for teams/tryouts/captains via slash | Met | `admin/create_role.js`, `set_role.js` |
| 7 | Team members or admins pull op.gg (team + individual) | Met | `commands/opgg.js` (tier `MEMBER`) |
| 8 | Captains record scrim results; manual who-played + win/loss | Met | Result tracker buttons in `events.js` + `/record` fallback |
| 8a | Internal scrims need agreement (first-submit + dispute) | Met | Win button first-click + `SCRIM_DISPUTE` flow |

### Clarified design decisions (from follow-up Q&A)
| Decision | Choice | Status |
|----------|--------|--------|
| Permission tiers | Owner>Admin>Captain>Member>Tryout>Everyone | Implemented |
| Availability format | Weekly baseline + date overrides | Implemented |
| Scrim result agreement | First-submit wins + dispute | Implemented |
| Tryout mechanic | Express interest / sign up | Implemented |
| Server scope | Single server | Implemented |
| Riot region | NA (`na1`/`americas`), configurable | Implemented |
| Scrim request destination | Designated scrim channel | Implemented |
| Result entry UX | Auto embed at event start, ping captains, Win/Edit buttons | Implemented |
| Result trigger | Auto-post at start time (60s poller) | Implemented |
| Winner finalization | First click + dispute | Implemented |
| `/record` | Kept as fallback | Implemented |
| Matcher subs | `include_subs` stays optional; 5 per team | Implemented |
| Record viewing command | Deferred (submission only for now) | Not implemented (by request) |

---

## 3. Issues found and fixed during validation

| # | Severity | Issue | Resolution |
|---|----------|-------|-----------|
| 1 | High | `toUnixTimestamp` produced the wrong UTC time (off by one hour; parsed wall-clock as host-local) | Rewrote with DST-aware `Intl` offset algorithm; proven `=1751670000` |
| 2 | High | `events.js` created a second `DataManager` → separate cache → stale reads after writes | Share the single core instance via `EventRegistry.data_manager/permissions` |
| 3 | High | Two `TextInput` labels exceeded Discord's 45-char limit → modal rejected at runtime | Shortened; audited all labels ≤45 |
| 4 | Med | `availability.js` used `target.displayName` (undefined on `User`) | Use `globalName ?? username` |
| 5 | Med | `/opgg` was `EVERYONE`; spec restricts to team members/admins | Changed to `MEMBER` tier |
| 6 | Med | `_hasRole` assumed `roles.cache`; raw API members expose an array | Handle both shapes |
| 7 | Med | Host TZ could skew availability day-matching | Force `process.env.TZ` from config at startup |
| 8 | Med | Fill button lacked guards | Block on-team members and closed scrims |
| 9 | Low | `profile.js` raw avatar URL 404s without a custom avatar | Use `displayAvatarURL()` |
| 10 | Low | `/record` could theoretically double-record | Guard: refuse if `scrim.result` exists |

---

## 4. Manual test checklist (requires live Discord + Riot key)

These flows depend on Discord interactions and the Riot API and must be verified on a
live bot in a test guild. Suggested order:

**Setup**
- [ ] `.env` populated; bot invited with `applications.commands`, **Manage Events**, **Manage Roles**, Send Messages.
- [ ] "Server Members Intent" enabled in the Developer Portal.
- [ ] Bot starts cleanly; 22 slash commands register; `/ping` replies.
- [ ] `/create_role` → `/set_role admin` → confirm only that role + owner can run admin commands.
- [ ] `/set_role captain`, `/set_role tryout`, `/set_channel scrim`, `/set_channel log`.

**Linking & availability**
- [ ] `/link` → button → modal with a real Riot ID → account stored; `/profile` shows rank.
- [ ] `/link` with a bogus Riot ID → friendly "not found" error.
- [ ] `/availability` → Set Weekdays/Weekend → values persist and redisplay.
- [ ] Add a date override (times and `none`) → View Overrides reflects both.

**Teams**
- [ ] `/create_team` (with and without a role), `/assign_player` (Main + Sub, each position).
- [ ] Assigning an unlinked user is rejected. `/roster`, `/teams` render correctly.
- [ ] `/set_captain` grants captain role; `/mark_tryout` toggles tryout role.

**Scrims**
- [ ] Two teams with overlapping availability → `/scrim vs:` shows slots; pick one → request in scrim channel pings opposing captain.
- [ ] `include_subs:true` surfaces additional slots vs. starters-only.
- [ ] `allow_fill:true` shows a fill button; a non-team member can express interest; a team member is blocked.
- [ ] **Accept** → Discord event created, requester DM'd. **Decline** → requester notified.
- [ ] No-overlap case → clear "no availability" message.

**Result tracking**
- [ ] Set a scrim's start time to ~1 min out → within 60 s the result tracker auto-posts and pings both captains.
- [ ] A captain clicks a Win → embed updates to winner + Dispute button; opposing captain DM'd.
- [ ] Opposing captain clicks **Dispute** → status disputed, log channel notified.
- [ ] **Edit Players** modal updates the shown roster for that captain's team.
- [ ] Restart the bot before a past-start scrim is posted → it posts on the next poll (not duplicated).
- [ ] `/record` fallback records a confirmed scrim and refuses an already-recorded one.

**Tryouts**
- [ ] `/tryout create` posts the embed; `open_to` gating works (tryout/member/everyone).
- [ ] `I'm Interested` toggles membership; `/tryout view` lists the interested; `/tryout close` stops new interest.

**Permissions**
- [ ] Owner can run every command. A non-admin is denied admin commands. A non-captain is denied `/scrim` and `/record`.
