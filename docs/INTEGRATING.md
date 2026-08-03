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
});

await mc.initialize({ port: 7431, actionTimeout: 300000, debug: false });
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

Subscribe with `mc.on(name, handler)`. All 23:

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

`actionSent`, `actionAck`, `actionStarted`, `actionStopped`, `actionTimeout`

---

## Methods

### Driving

```js
await mc.executeAction(action, params, { source, waitForCompletion, priority });
```

`source` is `'llm'`, `'viewer'`, or `'autonomy'`. **Always set it** — see
[arbitration](#arbitration) below.

> **The number one integration trap.** Not every action reaches the game. The
> bridge's translator knows the game-bound actions; the rest are **control-plane
> actions your host dispatcher must answer itself** from `getStatus()` and
> memory:
>
> `enable` `disable` `status` `autonomous` `gamer` `gamer_stop` `favorite`
> `unfavorite` `favorites` `set_outpost` `outposts`
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
mc.shouldSurfaceChat(sender, text);   // -> {surface, addressed, owner}
mc.interpretChatCommand(text, sender); // -> {action, target, params} | null
mc.addressedToSomeoneElse(text);       // don't answer on another player's behalf
mc.recordViewerSuggestion(user, text, { inGame });
```

### Gates and state

```js
mc.enable(); mc.disable();
mc.setAutonomousMode(bool);
mc.setMood('excited');       // biases the idle behaviour menu
mc.setBotNames([...]);       // rename at runtime
mc.setBroadcast(fn);         // (re)point the UI mirror
await mc.startGamerMode();   // committed, narrated speedrun
mc.stopGamerMode();
```

### Places

```js
mc.setFavoriteHere('the lava pit');
mc.setHome('the homestead');
mc.setOutpostHere('east toaster', 2); // level 1-4; main home stays larger
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
roof, clear interior, two toast slots, walk-through, and side torches all match.

---

## Sharp edges

Things that are reasonable in context but will surprise you once:

- **`getStatus()` is not a pure getter.** It advances internal affect state as a
  side effect. Call it freely, but do not treat it as free.
- **When nothing is connected it still returns a fully-populated `gameState`** —
  health 20/20, position 0,0,0. That is the honesty trap in miniature. Gate on
  `gameConnected` before you let any of it reach a prompt.
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
