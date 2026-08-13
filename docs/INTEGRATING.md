# Integrating burtcraft into your VTuber

The library gives you a body. You supply the mind. This document is the complete
seam list between the two.

Nothing here calls an LLM, writes to a database, makes an HTTP request, or
speaks. It emits events and answers `getStatus()`.

---

## Setup

```js
import { MinecraftTool } from 'burtcraft/core';

const mc = new MinecraftTool({
  names: ['ada', 'ada bot'],        // what she answers to in multiplayer chat
  broadcast: (cue) => overlay(cue), // optional: mirror internal cues to your UI
  memory: null,                     // optional: your own MinecraftMemory instance
  remember: {                       // optional: your long-term/semantic memory
    gameplay: (text, { tags }) => store.add(text, tags),  // deaths, diamonds, achievements
    player:   (player, worldId) => people.upsert(player), // who she plays with
  },
});

await mc.initialize({ port: 7431, actionTimeout: 90000, debug: false });  // these are the defaults
// optional: { reclaimPort: true } - see the warning below
mc.enable();                        // gate: nothing dispatches until enabled
mc.setAutonomousMode(true);         // optional: idle self-play
```

`initialize()` starts the **ws server**. The bridge dials in. Until it does,
`getStatus().connected` is false and every action fails honestly.

> **`reclaimPort`.** If the port is already taken, `reclaimPort: true` kills the
> Node process holding it and rebinds — handy when this controller owns the port
> and you restart it constantly. It is **off by default**, because on a dev box
> the thing on your port is at least as likely to be an unrelated server you
> care about. With it off you get a normal `EADDRINUSE` and nothing dies.

---

## Events

Subscribe with `mc.on(name, handler)`. All 24:

### The ones you actually want

| Event | Args | Use |
|---|---|---|
| `gameEvent` | `(event, data)` | **The main feed.** Something happened in the world. Turn it into a prompt. |
| `botTaskPhase` | `(phase)` | The live "what am I doing" readout changed. Good for narration during long tasks. |
| `actionComplete` | `(info)` | A goal finished. |
| `actionFailed` | `(info)` | A goal did not. Let your character notice. |
| `commentary` | `(entry)` | An internal cue. **Never speak this verbatim** — see below. |
| `viewerSuggestion` | `(suggestion)` | Chat asked for something that was not a direct command. |
| `sessionEnded` | `(info)` | The world/session went away. |

### Connection and lifecycle

`connected`, `disconnected`, `gameConnection`, `enabled`, `disabled`,
`faultDetected`, `faultCleared`, `queueStatus`, `stateUpdate`, `affectUpdate`,
`gamerMode`

### Action lifecycle (fine-grained)

`actionSent`, `actionAck`, `actionStarted`, `actionStopped`, `actionTimeout`,
`chatSent` (a line of hers actually reached the server — the confirmation that
she spoke in game, as opposed to merely deciding to)

---

## Methods

### Driving

```js
await mc.executeAction(action, params, { source, waitForCompletion, priority });
```

**Always set `source`** — see [arbitration](#arbitration) below. The value is not
free-form: the arbitration tables match on these exact strings, so a made-up one
silently gets the weakest treatment.

| your caller | use | behaviour |
|---|---|---|
| your LLM / brain | `agent` | preempts running work; gated inside the spawn region |
| a human operator, or a UI button | `operator` | preempts running work |
| chat / viewer request | `request` | preempts autonomous work; may itself be replaced |
| the idle self-play loop | `autonomous` | never preempts; always replaceable; spawn-gated |
| your own speedrun trigger | `gamer` | preempts running work |

Full sets: `PREEMPTING_SOURCES` and `REPLACEABLE_SOURCES` in
`core/minecraft_tool.js`. Internal recovery paths use their own names
(`safety`, `recovery`, `pinned`, …) — you do not need to send those.

> **The number one integration trap.** Not every action reaches the game. The
> bridge's translator knows the game-bound actions; the rest are **control-plane
> actions your host dispatcher must answer itself** from `getStatus()` and
> memory:
>
> `enable` `disable` `status` `autonomous` `gamer` `gamer_stop` `favorite`
> `unfavorite` `favorites`
>
> Hand one of those to `executeAction` and it gets relayed to a bridge that has
> no translation for it, and you get an error instead of the obvious local
> answer. `set_home`, `set_outpost`, and `outposts` resolve inside
> `executeAction` as memory operations; `go_home`, `go_outpost`, `build_outpost`,
> and `move` with a saved-spot name are
> rewritten into coordinate moves for you.
>
> `examples/04_llm_tool.mjs` splits the actions into families for exactly this
> reason — copy that dispatcher rather than writing a passthrough.

### Reading

```js
mc.getStatus();            // structured snapshot - the context seam
mc.pullCommentary();       // drain queued internal cues
mc.getViewerSuggestions(); // what chat has been asking for
mc.chatRoom();             // recent in-game chat
mc.knownPlayers();         // who she has seen
```

### Chat handling

```js
mc.shouldSurfaceChat(sender, text);
// surfaced -> {surface: true, addressed, owner, followUp?, toSomeoneElse?, request?}
// refused  -> {surface: false, reason}    // ⚠ no addressed/owner on this shape
mc.interpretChatCommand(text, sender); // -> {action, target, params} | null
mc.addressedToSomeoneElse(text);       // don't answer on another player's behalf
mc.recordViewerSuggestion(user, text, { inGame });
```

⚠ There is a fifth lane that is easy to miss: **anyone may just ask.** A
request-shaped line surfaces with `request: true` even when it never says her
name — but `addressed` stays `false`, so your prompt must not claim they were
waiting on her personally. Players who are not physically near her pay a 20s
floor between requests; somebody standing next to her does not.

### Decisions the library asks you to make

Three events are questions, not notifications. Each one has a fallback timer
armed *before* you are asked, so a dead API key or a hung model degrades into
reasonable default behaviour instead of hanging — but if you never wire up the
answer, you never get the good version.

| Event | Answer with | If you never answer |
|---|---|---|
| `noticings` `{items:[{kind,line,tags}], busy, task}` | `mc.acceptNoticings([kind, …])` — **only once you have actually committed to a turn** | nothing is spent; the same noticings can win a later opening |
| `bread_opportunity` (facts about someone who just walked up) | `mc.actOnBreadOpportunity(player, 'ignore'\|'talk'\|'offer'\|'give'\|'approach_and_give')` | a coin flip picks the gesture once the timer expires |
| `request_opportunity` `{player, said, inGame, busy, task, carrying, position, nearby, budgetMs}` | `mc.actOnRequestDecision({action, params})`, or `{action:'decline'}` | the ask is let go, silently |

⚠ **Offering is not spending.** `acceptNoticings()` is a separate call on
purpose. The board hands you a shortlist without consuming it; if the offer
spent them, a speech gate that then decided not to talk would eat the perception
permanently — which is the exact failure the board was built to fix. Call it
when you have queued the line, not when you receive the list.

### Gates and state

```js
mc.enable(); mc.disable();
mc.setAutonomousMode(bool);
mc.setMood('excited');       // biases the idle behaviour menu
mc.setBotNames([...]);       // rename at runtime
mc.setBroadcast(fn);         // (re)point the UI mirror
mc.setRemember(sink);        // (re)point long-term memory; null unhooks
await mc.startGamerMode();   // committed, narrated speedrun
mc.stopGamerMode();

mc.setAutonomyMode('gather_food');
// auto | gather_materials | gather_food | scout_area | secure_area
// 'auto' is the full idle ladder; the others replace ONLY the free-time
// provider. Nothing above the idle menu is mode-gated - safety, recovery and
// viewer requests are not preferences. Read it back from getStatus() as
// `autonomyMode` / `autonomyModeLabel`, and the legal set is exported as
// AUTONOMY_MODES.
```

Every key in the config is also an `initialize()` option, not just the four in
[Setup](#setup). The ones worth knowing:

| Option | Default | What |
|---|---|---|
| `autonomousTickMs` | `25000` | how often the idle menu gets a turn |
| `noticeEnabled` | `true` | the noticings board |
| `noticeSensitivity` | `0.35` | moves the salience floor *and* the offer gap together — a low floor with a long gap just delays the same noise |
| `ticFrequency` | `0.12` | chance of an idle fidget |
| `trenchEnabled` | `false` | the defensive moat. Turning this on makes every standing settlement read as incomplete and start a ~1240-block dig |

The constructor also takes `registerMemoryExitHook` (default `true`). That is the
flag to pass `false` if you construct the tool yourself specifically to avoid the
process-exit hook.

### Places

```js
mc.setFavoriteHere('the lava pit');
mc.setHome('the homestead');
mc.setOutpostHere('east toaster', 2); // level is a label; every outpost is 12x7x6
mc.getStatus().homeProject;           // persistent goal, %, phase, components
mc.getStatus().settlements;           // exact anchors and dimensions
await mc.shutdown();
```

---

## The three rules

### 1. Cues are prompts, not lines

`commentary` events and the `say:` strings inside the autonomy loop are
**internal cues**. The correct handling is:

```js
mc.on('commentary', async (cue) => {
  const line = await askYourBrain(
    `you're playing minecraft on your own and thinking: "${cue.text}". say it in your own words.`
  );
  speak(line);
});
```

Not:

```js
mc.on('commentary', (cue) => speak(cue.text));   // <- the mistake
```

Speaking them verbatim is how the same sentence reaches your audience over and
over. Bigger pools and anti-repeat pickers do not fix it — the problem is that
the words were not written by your character. There is a matching rule inside the
library: commentary is never published to in-game chat either. She talks in
Minecraft through the `chat` action, in words her brain generated.

### 2. Arbitration

The autonomy loop and your LLM are peers competing for one bot. Without
arbitration your LLM issues a goal and the idle loop overrides it seconds later,
and your character looks like it cannot follow through.

- Tag every `executeAction` with `source`.
- LLM- and viewer-issued goals get a grace window during which autonomy stands
  down (`LLM_GOAL_GRACE_MS` in `core/minecraft_tool.js`).
- Autonomy only self-starts when `enabled && autonomous && !currentAction`.

If you call `executeAction` untagged from your brain, you have defeated this.

### 3. Honesty

`getStatus()` tells you the truth: `connected` (bridge up), `gameConnected`
(game up), `stateAgeMs` (how stale), `fault` (what is broken). Your context
block must degrade to "not connected" rather than defaulting to something
cheerful. A character narrating gameplay that is not happening is the worst bug
in this stack and the easiest one to write by accident.

The same principle runs through the lower layers: `gameState.multiplayer` and
`server` report what the game actually joined, never what your config intended.
`gameState.settlementBuild` is likewise a real block survey. A torch in inventory
does not satisfy `lit`, and a project reaches 100% only when its floor, walls,
roof, clear interior, two toast slots, walk-through, wall torches **and its
10-block yard** all match. The yard is the last 10% and the easiest to forget:
a house with mobs dropping onto the roof from the high ground next to it is not
finished, so the clearance is part of the build rather than a nicety.

---

## Sharp edges

Things that are reasonable in context but will surprise you once:

- **`getStatus()` is not a pure getter.** It advances internal affect state as a
  side effect. Call it freely, but do not treat it as free.
- **When nothing is connected it still returns a fully-populated `gameState`** —
  health 20, hunger 20, position 0,0,0 (and no `maxHealth` at all). That is the
  honesty trap in miniature. Gate on `gameConnected` before you let any of it
  reach a prompt.
- **`shouldSurfaceChat()` is random and stateful.** Ambient lines are sampled
  (~50% behind a 75s gap) and the call updates per-sender timestamps, so the
  same input can answer differently twice. That is deliberate — it is what stops
  the bot replying to every line — but it means it is not a pure predicate.
- **`recordViewerSuggestion()` returns `null` for three different reasons**
  (blocked verb, not request-shaped, sender on cooldown) and does not tell you
  which.
- **`shutdown()` is synchronous** despite the name. `await` is harmless.
- **Importing the default singleton has side effects** — it constructs a
  `MinecraftMemory` rooted at `./data` relative to your cwd and registers a
  process exit hook. Import `{ MinecraftTool }` and construct it yourself if you
  want control over that.
- **Error ordering can mislead.** With the bridge up but no world loaded, an
  action reports stale telemetry rather than "not in a world" — the staleness
  check runs first. The bot is fine; the message points at the wrong thing.

## Multiplayer manners

On a public server, unfiltered chat handling makes a bot look like a bot. The
library's filter (`shouldSurfaceChat`) implements:

- Lines naming her, or from `$MINECRAFT_OWNER`, **always** surface (8s per-sender gap).
- Ambient chatter is **sampled** (~50%, 75s minimum gap) so she joins in
  occasionally like a person instead of replying to every line.
- Command noise (`/ ! . # @` prefixes) never surfaces.
- Greetings aimed at a named third party are not answered on their behalf.
- **A conversation is a state, not a keyword.** Once she has actually answered
  somebody, they stay "talking to her" for 150s (2s per-sender gap inside that
  window, 600s ceiling) and their follow-ups surface with `followUp: true`.
  Nobody retypes a name every line — the reply to "do you still have iron on?"
  used to fall through to the ambient dice, behind a gap her own reply had just
  reset, so she answered once and went silent for the rest of the exchange.

Outgoing `chat` actions are paced (3s minimum gap, 8/min cap). Addressed lines
also feed `recordViewerSuggestion`, so players in the world can re-task her the
same way stream chat can.

---

## Making it yours

| What | Where |
|---|---|
| The bot's name | `names` option / `BOT_NAMES` env |
| Idle behaviour weights | the mood menus in `_pickIdleBehavior()` |
| Character fixation | `_obsessionBehavior()`; set `OBSESSION_BIAS = 0` to remove |
| Cue wording | the `say:` strings — they are prompts, so rewrite freely |
| Context prose | entirely yours; see `examples/03_context_block.mjs` |
| Mood vocabulary | `MINECRAFT_MOOD_MAP` maps your mood names onto 7 internal ones |

The autonomy brain's survival logic — water avoidance, mob pressure, stall
recovery, protected-area escape, homestead provisioning — is character-neutral
and worth keeping.
