# Wire protocol

Two hops, both localhost-only, both newline-delimited JSON (one object per
line). You only need this document if you are replacing one of the three
processes — the Node library speaks it for you.

```
 your vtuber            the bridge             minecraft
 (ws SERVER :7431) <--> (ws + tcp client) <--> (tcp SERVER :7440)
        hop 1                                    hop 2
```

The direction of hop 1 surprises people: **your VTuber is the server**, the
bridge is the client that dials in. This is so you can restart your VTuber
without restarting Minecraft. The bridge reconnects on its own.

---

## Hop 1 — VTuber (ws server, :7431) <-> bridge

Port from `MINECRAFT_BRIDGE_PORT`, default `7431`. Bound to `127.0.0.1`.

### Bridge -> VTuber

| type | Shape | Meaning |
|---|---|---|
| `handshake` | `{type, source, version, capabilities}` | Sent on connect. |
| `heartbeat` | `{type, timestamp, gameState}` | Liveness ping, carrying a state snapshot; answer with `heartbeat_ack`. |
| `bridge_status` | `{type, altoclefConnected, companionSocketConnected, username, timestamp}` | Whether the bridge's own link to the game is up. This is how you know the difference between "bridge running" and "game running". ⚠ the wire field is `altoclefConnected`; `getStatus().gameConnected` is the library's own name for it, so a third-party controller reading `gameConnected` off the wire gets `undefined` forever. `username` is the only place the in-game player name reaches hop 1. |
| `state` | `{type, gameState:{...}, observedAt}` | Live game state, roughly every 2s. `observedAt` is what the staleness checks read. ⚠ the bridge forwards its own **accumulated** snapshot, not the companion's frame — a key the companion stops sending keeps its last value. See [stale fields](#conditionally-sent-fields). |
| `event` | `{type, event, data}` | Something happened (see [events](#game-events)). |
| `response` | `{type, action_id, status, error?, result?}` | Outcome for the action with that `action_id`. **Not always terminal** — see below. |
| `queue_status` | `{type, ...}` | *Reserved — the reference bridge never sends this.* |
| `log` | `{type, level, message}` | *Reserved — the reference bridge never sends this;* `log()` writes to its console and emits a local EventEmitter event only. |

`status` is one of `executing`, `success`, `error`. **`executing` is a
non-terminal acknowledgement** — it means "accepted, still running", and a
second `response` with the same `action_id` follows. Treating it as completion
is the classic integration bug: the action looks instant and every later
`success` looks unsolicited.

### VTuber -> bridge

| type | Shape | Meaning |
|---|---|---|
| `action` | `{type, action, params, id, priority}` | Do a thing. `id` comes back as the `action_id` on the response. |
| `heartbeat` | `{type, timestamp}` | You may ping the bridge; it answers `heartbeat_ack`. |
| `heartbeat_ack` | `{type, timestamp}` | Reply to the bridge's `heartbeat`. |
| `query` | `{type, ...}` | Ask the bridge for its current view. |
| `config` | `{type, ...}` | Push a setting (e.g. autonomous on/off) to the bridge. |

---

## Hop 2 — bridge <-> in-game companion (tcp server, :7440)

Port from `-Daltoclef.control.port`, else `$ALTOCLEF_CONTROL_PORT`, else `7440`.
Bound to localhost on purpose — the bot must never be reachable off-box.

### Bridge -> companion

```jsonc
{"type":"command","id":"<id>","command":"get diamond 3"}  // no leading '@'
{"type":"chat","id":"<id>","text":"#explore"}             // raw line (baritone/chat)
{"type":"ping"}                                           // companion implements it;
                                                          // the reference bridge never sends it
```

`id` is omitted on one command: the control-loss `stop` the bridge issues when its
own link drops. Nothing is waiting on that one.

### Companion -> bridge

```jsonc
{"type":"hello","username":"Steve"}
{"type":"ack","id":"<id>"}
{"type":"finished","id":"<id>"}              // carries type + id only, never a result
{"type":"error","id":"<id>","error":"..."}   // an ABORTED finish arrives here, not above
{"type":"state","gameState":{...}}           // ~every 2s
{"type":"event","event":"...","data":{...}}  // payload is ALWAYS nested under "data"
{"type":"pong"}                              // the reference bridge has no case for this
                                             // and logs it as an unknown message
```

⚠ `finished` and `error` both come out of one `sendTaskOutcome` on the companion
side: a task that was *cancelled* rather than completed is turned into an `error`
frame carrying its abort reason. That is the only thing separating "done" from
"gave up" — the game reports a cancelled task exactly like a finished one.

**Completion is real.** `finished` / `error` are driven by AltoClef's actual
`TaskFinishedEvent`, not a timer. An earlier version of the bridge faked
execution with `setTimeout` plus random success and never touched Minecraft at
all — if the companion is not connected, actions now fail honestly instead.

---

## `gameState`

Sent about every 2 seconds. Fields are best-effort; **always guard with `?.` or
defaults** rather than assuming a key is present, because most of them are
skipped when the value cannot be read this tick.

| Field | Notes |
|---|---|
| `health`, `maxHealth`, `hunger` | rounded |
| `position` | `{x, y, z}` block coords |
| `dimension` | e.g. `minecraft:overworld` |
| `onGround`, `inWater`, `inLava`, `underwater` | |
| `air`, `maxAir` | drowning headroom |
| `xpLevel` | |
| `selectedItem`, `offhandItem` | |
| `mainHandDurability`, `mainHandMaxDurability` | absent when the item is not damageable |
| `eating`, `needsToEat`, `hasFood` | from AltoClef's FoodChain |
| `multiplayer`, `server`, `nearbyPlayerNames` | **ground truth** — the companion reports what it actually joined, never what your config intended |
| `inventory`, `inventoryTypes`, `inventoryFree` | what she is carrying, and how much room is left |
| `armor` | equipped pieces |
| `timeOfDay`, `weather` | `day`/`night`, `clear`/`rain`/`thunder` |
| `rainingHere`, `skyVisible` | roof- and biome-aware: standing **in** the rain differs from rain existing somewhere |
| `biome` | |
| `nearbyHostiles`, `nearbyHostileTypes`, `nearbyPlayers` | counts and kinds |
| `nearbyCreatures` | the ranked entity readout, nearest-and-most-interesting first, capped at 6: `{type, dist, dir, vert?, notable?, boss?, hostile?, aggro?, baby?, tame?, name?}`. **Sent every poll even when empty**, deliberately — see [stale fields](#conditionally-sent-fields). `aggro` comes from the synced aggressive flag, not from a server-side target a client cannot see |
| `nearbyCreatureTypes`, `foodAnimals`, `villagers` | the same sweep, summarised |
| `nearbyPeople` | per-player: `{name, display?, dist, dir, vert?, watching?, sneaking?, onFire?, hurt?, threats?, holding?, armor, geared?}`. `watching` is "looking right at her" |
| `onlinePlayers`, `onlinePlayerNames` | the tab list, not the loaded-entity sweep |
| `bossBars` | `{name, percent, color}`, max 4 |
| `nearby` | the resource-affordance scan (~35 keys): `nearestOre`/`nearestOreDist`, `ores`, `logs`, `water`, `lava`, `craftingTable`, `furnace`, `chest`, `bed`, `smoker`, `campfire`, `hay`; structure finds `spawner`, `trialSpawner`, `vault`, `ominousVault`, `sculkShrieker` (each with a `…Count`); and per crop (`wheat`, `carrot`, `potato`, `beetroot`, `berries`) a bare key plus `…Count` and `…Ripe`. ⚠ a missing `…Ripe` means *this build cannot tell*, never zero — a crop is present at any growth age but only harvestable at the last one |
| `containers` | remembered chests/furnaces: `{dim,x,y,z,type,empty,full,at,items:{id:count}}`. `at` is when it was last actually read, not now |
| `overWater`, `clearEdge` | standing over water; the edge of the largest clear cube she is standing in. ⚠ `clearEdge` is capped just above the largest threshold anything reads, because it is a shell scan on the render thread |
| `lightLevel`, `depthBelowSurface` | |
| `moonPhase`, `secondsUntilSunset`, `skyColorPhase` | `moonPhase` 0-7 (0 = full); `skyColorPhase` is one of `sunrise`, `morning`, `midday`, `afternoon`, `golden_hour`, `sunset`, `dusk`, `night`, `predawn`. **Overworld only** |
| `saveName` | singleplayer world name. With `server`, this is what scopes per-world memory |
| `chain`, `preempted` | which AltoClef chain owns her right now, and whether a non-user chain has taken over |
| `combat` | `{mode, ranged, gearingUp, standingGround, couldWinIfGeared, target?, targetDist?, arrows, canShoot}`. ⚠ **omitted entirely when unreadable — absent is not "not fighting"** |
| `advancementsAll` | the full id set, **first poll of a session only** |
| `advancementsNew`, `advancementCount` | the delta on later polls, sent only when non-empty |
| `homeSite` | the survey of a candidate or established home site |
| `botTask` | high-level goal + phase, e.g. `beating the game.: getting blaze rods` |
| `botAction` | deepest micro-action |
| `botTaskPath`, `botTaskDepth` | the whole task chain, outermost first — this is what a "why is she doing that" readout is built from |
| `settlementBuild` | exact toaster survey: kind/role/anchor/dimensions, phase, percent, shell/interior checks, two-slot check, walk-through check, side-torch counts, and remaining stone |

Three fields on this frame come from the **bridge**, not the game: `currentTask`
(the relay's own view of which action owns the task slot — distinct from
`botTask`), plus `nearbyEntities` and `isInCombat`, which are vestigial and always
`[]` / `false`.

<a name="conditionally-sent-fields"></a>
### ⚠ Conditionally-sent fields, and why that matters

The bridge merges each companion frame into a running snapshot and forwards *the
snapshot*. That is right for state — last known health is the best answer — and
wrong for anything sent conditionally, because **a field that stops being sent
keeps its last value forever**.

- `advancementsAll` / `advancementsNew` describe a moment, not a condition, so the
  bridge drops them from the snapshot the instant it has forwarded them. Without
  that they latch and re-deliver the same advancements on every poll, which on the
  reference implementation meant rewriting the whole memory ledger to disk every
  two seconds.
- `combat`, `preempted` and `chain` are each inside their own `try` on the
  companion side, so they genuinely can stop arriving. A consumer that treats
  absent as "unknown" cannot see that through the merge — budget your own timeout
  rather than waiting for the field to disappear.
- `moonPhase`, `secondsUntilSunset` and `skyColorPhase` are **overworld only**, so
  they hold their last overworld reading while she is in the nether or the end.
  Gate them on `dimension` yourself.
- `server` survives a return to singleplayer; `saveName` survives a join. Read them
  together with `multiplayer`, which is always sent.

`botTask` is what lets a character say what it is genuinely doing right now. It
comes from `getTaskRunner().getCurrentTaskChain()`; older mod builds without the
`CommandExecutor.getMod()` accessor degrade gracefully to no phase.

---

## Game events

Delivered as `{type:'event', event, data}` and re-emitted by the Node library as
`gameEvent(event, data)`. This is the main feed for a VTuber brain.

The full set the companion emits: `achievement`, `block_broken`, `chat`,
`creeper_spotted`, `damage_taken`, `death`, `diamond_found`,
`dimension_changed`, `entity_killed`, `hostiles_nearby`, `inventory_change`,
`item_collected`, `low_hunger`, `manual_control`, `nightfall`, `player_joined`,
`player_left`, `protection_denied`, `rare_find`, `respawn`, `task_finished`,
`weather_changed`.

`task_finished` carries an `abortReason` when the task was cut short rather than
completed. **Read it.** The game reports a cancelled task exactly like a finished
one, so without it a goal abandoned at 34% is indistinguishable from a job done —
and a controller that books it as a success will never retry.

`position_update` and `time_update` are handled by the reference bridge and the
Node library but emitted by nothing; treat them as reserved.

The Node library **synthesises** a further set on the same `gameEvent` channel,
with no wire origin — they come from its own perception and memory layers:
`place_discovered`, `first_time`, `helping_player`, `noticings`,
`creature_spotted`, `biome_changed`, `bread_opportunity`, `player_approached`,
`room_quiet_moment`, `oven_installed`, `target_unreachable`, `pinned_by_mobs`,
`request_opportunity`, `home_unreachable`, `homestead_settled`,
`expedition_started`, `expedition_ended`.

Note `death` and `diamond_found` are singular — the human-readable *labels* read
"died" and "diamonds found", but a handler must match the event name.

`protection_denied` is worth special handling on public servers: it fires when
the server rejects an interaction ("you are not allowed to interact with this
block"). Two denials inside a minute during a goal means the bot is standing in
someone's claim, and the right response is to remember the area and leave, not
to retry.

## Cancellation and replacement

The controller treats `stop` as a synchronization barrier. A replacement goal
is not sent after the bridge's `executing` acknowledgement; it waits for the
terminal stop response proving that AltoClef released the old task tree. Agent,
operator, mode-switch, and gamer sources may use this path to replace current
work. Duplicate gamer starts share the same transition.

If that terminal stop response is lost, the controller closes the relay socket.
Relay and companion disconnect fail-safes then issue their own stop before
reconnecting, preventing an old task from continuing unsupervised.

---

## Adding an action

1. **Node side** — add it to the action enum and, if it needs no game round
   trip, answer it locally from `getStatus()` / memory.
2. **Bridge** — add the name to `SUPPORTED_ACTIONS` **and** map it to a command
   string in `_translate`. Both: `_handleAction` checks the set and rejects with
   `unsupported minecraft action` *before* `_translate` is ever reached, so a
   translation on its own is dead code. A control verb that starts no goal must
   also go into `NON_TASK_ACTIONS`, or its instant completion blanks the
   `currentTask` of a goal that is still running.
3. **Mod side** — only if AltoClef has no command for it; add a `Command`
   subclass and register it. `PlaceCommand.java` in the fork is a small worked
   example.

⚠ An action handled *only* by your own controller, above the library, is a trap:
anything the library's own chat parser or autonomy can produce reaches the bridge
directly and will be rejected there. Handle it inside the library, or make sure
nothing else can emit it.

Actions that never reach the game (answered from memory) include `status`,
`enable`, `disable`, `autonomous`, `favorite`, `unfavorite`, `favorites`,
`set_home`, `set_outpost`, `outposts`, `gamer`, `gamer_stop`, `places`,
`remember_place`, `forget_place`, `food_spots`, `forget_food`, `stores`, and
`retreat` (composed node-side out of other verbs). `go_place`, like `go_home` and
`go_outpost`, is a coordinate rewrite: it *does* reach the game, as a `move`.

`inventory` and `coords` look like they belong on that list and do not — both
are real companion commands and need a live game.

### Game-bound actions not shown elsewhere in this doc

| Action | Becomes | Notes |
|---|---|---|
| `stock_food` | `@food <score>` | a forage. deliberately **not** `eat`, which is a safety action and skips the busy gate. `amount` is a food *score* (nutrition × count), not an item count |
| `withdraw` | `@withdraw <item> <n>` | take back out of a chest. clamp to what the chest actually has — over-asking has no give-up |
| `peek` | `@peek x y z` | read a container without taking anything. do this before sizing a withdraw; the cache only refreshes while the screen is open |
| `place_block` | `@place_at x y z <block>` | lighting, shoring, ornaments at an exact coordinate. deliberately **not** `install_appliance`, which files against the settlement ledger and counts toward its completion |
| `protect_settlement` | `@protect_settlement …` | "never mine or bridge through this building". starts no goal |
| `tic` | `@tic crouch\|jump\|flex` | a one-second fidget. the library sends this itself |

### Settlement actions

| Action | Parameters | Companion command |
|---|---|---|
| `build_settlement` | `role` (`homestead`/`outpost`); needs a settlement already saved | `@toaster_build ...` |
| `install_appliance` | `target` (see allowlist below), integer `x,y,z` | `@place_at ...` |
| `set_outpost` | local `target` name and optional `level` | persisted only |
| `build_outpost` | saved outpost name | *node-side only* — resolves its persisted geometry and is rewritten into `build_settlement` before it reaches the bridge, which has no `build_outpost` of its own |

`build_settlement` takes no dimensions from you. The floorplan is the only legal
shape, so the bridge **resolves** width/depth/height from `role` rather than
validating what it was handed — a gate that can disagree with its own caller
about a constant is a second source of truth, not a check. `x,y,z` are likewise
overwritten from the saved settlement, so call `set_home` / `set_outpost` first;
without one you get `no toaster blueprint is saved on this world yet`.

`level` on an outpost is a **label**, not a size. Every outpost is 12x7x6.

`install_appliance` allowlist: `furnace`, `blast_furnace`, `smoker`, `campfire`,
`soul_campfire`, `chest`, `crafting_table`.

The bridge validates roles and appliance allowlists and never interpolates
arbitrary command text. Reissuing a build is safe because the companion changes
only blocks that disagree with the settlement schematic.
