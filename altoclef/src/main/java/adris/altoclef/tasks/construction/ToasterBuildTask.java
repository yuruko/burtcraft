package adris.altoclef.tasks.construction;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasks.InteractWithBlockTask;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.construction.settlement.ToasterLayout;
import adris.altoclef.tasks.construction.settlement.ToasterTier;
import adris.altoclef.tasks.movement.GetWithinRangeOfBlockTask;
import adris.altoclef.tasksystem.ITaskRequiresGrounded;
import adris.altoclef.tasksystem.Task;
import baritone.api.BaritoneAPI;
import baritone.api.Settings;
import baritone.api.process.IBuilderProcess;
import baritone.api.schematic.AbstractSchematic;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.AirBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;

import java.util.ArrayList;
import java.util.List;

/**
 * Builds and repairs one settlement-shaped toaster.
 *
 * Baritone owns the bulk prism work while this task owns resupply, exact side
 * torches, progress telemetry, and completion. Reissuing the same command after
 * a restart is safe: the world is surveyed and only incorrect blocks are changed.
 */
public final class ToasterBuildTask extends Task implements ITaskRequiresGrounded {
    /**
     * How close to the quarry mouth counts as being at the quarry, measured flat.
     * Loose enough that a mob nudging her off the block does not re-trigger the
     * whole walk, tight enough to still be ONE hole: at 12 the accept radius
     * reached back past the yard edge, so an early run could open a second scrape
     * behind the house and never converge on a shaft.
     */
    private static final int QUARRY_ARRIVED_RANGE = 6;
    /**
     * Hard ceiling on the widened incorrectSize - see {@link #widenBuilderSurvey}.
     *
     * This is a real limit, not a formality. incorrectPositions is walked by
     * BuilderProcess#assemble, which runs from onTick and TWICE on the tick where
     * the first call comes back null, so every entry is paid for ~20-40 times a
     * second. The trench box is the largest thing we hand it at roughly 9500
     * cells, so this leaves headroom for a bigger plan without ever letting a
     * malformed schematic ask for an unbounded per-tick walk.
     */
    private static final int SURVEY_CELL_CEILING = 16384;
    /** An unreachable goto never fails, so the walk to the quarry is timed. */
    private static final long QUARRY_WALK_BUDGET_MS = 90_000L;
    private static final int STONE_BATCH = 192;
    /**
     * Where a stone run BEGINS. High enough that she walks off to mine with a
     * working pocket instead of an empty one - dropping to the old 24 meant
     * every interruption caught her with nothing to build with.
     */
    private static final int STONE_RESTOCK_AT = 64;
    /**
     * Where a stone run ENDS. It used to end at STONE_RESTOCK_AT, which is where
     * it begins - so the run was abandoned the instant she crossed back over the
     * line. The log of 2026-08-05 is the whole bug in five numbers: a 192-block
     * gather started at 23:40:22, was dropped four seconds later at 29 stone,
     * and she went back to a 20x13x9 shell with a pocketful, ran dry after four
     * placements, and started again. One threshold cannot be both edges.
     *
     * The band is 64..160 rather than 24..64 because a house is 799 blocks and
     * the old band bought about forty placements per trip - she was walking off
     * to dig every few minutes and the build never looked like it was moving.
     * A full run now leaves with 160+ in hand and lasts roughly a hundred
     * blocks. The cap still yields to what is actually left, so the last stretch
     * of a nearly-finished shell does not send her out for three stacks.
     */
    private static final int STONE_STOCKED_AT = 160;
    /**
     * How long she keeps laying blocks BY HAND after Baritone refuses the site.
     * Long enough to be worth the walk, short enough that the fast path gets
     * another go once conditions change.
     */
    private static final long HAND_MODE_MS = 90_000L;
    /**
     * How long one hand-laid block may take before she is allowed to want a
     * different one. Long enough to cross the site and swing, short enough that
     * a block she genuinely cannot reach does not own her hands all session.
     */
    private static final long HAND_TARGET_MS = 20_000L;
    /** Floor for a torch run; the real ask is whatever the plan still owes. */
    private static final int TORCH_BATCH = 16;
    /**
     * How long one light spot gets before the next one is given a turn.
     *
     * This is sized against node's six-minute survey-silence budget: a FULL
     * rotation of every unlit spot has to fit inside it, or a house that cannot
     * be lit gets the whole build killed instead of moving on. The floorplan
     * lights three torches up each wall column, so the homestead has 36 spots
     * rather than the old 6, and 40s each would have taken 24 minutes to round.
     * These are INTERIOR walls, which are solid by construction - a spot that
     * refuses a torch is now rare enough that a short turn costs nothing.
     */
    private static final long TORCH_ATTEMPT_MS = 12_000L;
    /**
     * How long she may stand IN REACH of a spot with nothing appearing.
     *
     * THE CLOCK MUST NOT RUN DURING THE ONE STATE THAT PROVES THE SPOT IS FINE.
     * TORCH_ATTEMPT_MS used to be plain elapsed time over the whole attempt -
     * path computation, the walk, the approach AND the click - so arriving late
     * left her a sliver of it to actually place in. Live:
     *
     *   19:21:25  interact ... 492,68,3376 dir east: waiting for click
     *   19:21:28  side light at 493,68,3376 will not take a torch, trying another
     *
     * Three seconds. She had walked to the wall, was aiming at the face with a
     * torch in her hand, and the deferral fired anyway - then that spot was
     * written off as impossible after three rounds of the same. The give-up
     * measured travel and blamed the block.
     *
     * Being in reach is arrival: the goal was satisfiable, she satisfied it, and
     * the only question left is whether the face takes a torch - which resolves
     * in a tick or two, or never. Eight seconds covers the equip, the look and a
     * retry (InteractWithBlockTask's own click timer is five), and is still a
     * definite end for a face that genuinely refuses.
     */
    private static final long TORCH_REACH_MS = 8_000L;
    /**
     * The one budget that runs no matter what she is doing.
     *
     * TORCH_ATTEMPT_MS now measures being STUCK rather than being busy - closing
     * distance on the spot resets it - and a rule that generous needs a backstop,
     * or a bot oscillating in front of a spot holds the rotation for good. This
     * is the only clock that cannot be reset by progress.
     */
    private static final long TORCH_CEILING_MS = 45_000L;
    /**
     * How many times the whole rotation may come round with nothing lit before
     * the spots still left are written off. See {@link LightRotation} - the
     * round used to reset unconditionally, which is an infinite loop whenever
     * the remaining spots are ones she can never place on.
     *
     * Three rounds of a 3-spot rotation is under two minutes, and it only ever
     * costs that where the alternative was standing there for good.
     */
    private static final int LIGHT_ROUND_LIMIT = 3;
    private static final long SURVEY_INTERVAL_MS = 900L;
    /**
     * How often the YARD is re-read, as opposed to the house.
     *
     * The shell is ~1000 blocks and every one of them can change on the tick she
     * places it, so it is worth reading four times a second. The yard is ~6000
     * and it is trees and hillside - it changes at walking pace. Reading it on
     * the shell's cadence would have quadrupled the cost of the survey to watch
     * something that barely moves, and this task already runs on the client
     * thread, where every block read is a frame of stream.
     */
    private static final long YARD_SURVEY_INTERVAL_MS = 4_000L;
    /** Spacing between restarts of a paused builder, and after it keeps refusing. */
    private static final long BUILDER_KICK_COOLDOWN_MS = 4_000L;
    private static final long BUILDER_BLOCKED_COOLDOWN_MS = 30_000L;
    private static final int BUILDER_KICK_LIMIT = 5;
    /**
     * How long the survey may sit perfectly unchanged before the builder is
     * declared dead no matter what it claims about itself. Generous, because a
     * legitimate build really does go quiet while Baritone paths to the far
     * corner of the site - the observed failures freeze for MINUTES, not
     * seconds, so this never has to be tight to catch them.
     */
    private static final long BUILDER_STALL_MS = 45_000L;
    /** Window a restarted builder gets to place one block before the next kick. */
    private static final long BUILDER_STALL_RETRY_MS = 20_000L;
    /**
     * How long she may stand on ONE BLOCK with nothing to show for it before the
     * builder is called dead.
     *
     * BUILDER_STALL_MS has to be generous because it only knows the tally, and a
     * healthy builder legitimately goes quiet for a while - but only ever while
     * WALKING to the next placement. It never stands still to do it. That is the
     * whole difference between the two states, and it was going unread: on
     * 2026-08-05 she stood at -2292,69,3250 from 00:42:37 to 00:44:13 with 117
     * cobblestone in her pocket and 749 shell blocks to go, and the entire game
     * log for 00:43 is two lines of inventory heartbeat. Baritone said
     * active=true paused=false throughout. Ninety-six seconds of stream.
     *
     * So motion is the second opinion, and having it means the timeout no longer
     * has to be long enough to survive a walk across the site. Both signals must
     * agree - no block changed AND she has not moved - so a builder that is
     * actually pathing is never touched, however quiet it is.
     */
    private static final long BUILDER_MOTIONLESS_MS = 12_000L;
    /** One stable string: host-side progress supervision hashes the phase. */
    private static final String BLOCKED_PHASE = "blocked_baritone_cannot_build";
    private static JsonObject latestTelemetry;

    private final Settlement settlement;
    private Survey survey;
    private long surveyedAt;
    /** Last yard reading, and when it was taken. Refreshed on its own slow clock. */
    private YardScan yard = YardScan.EMPTY;
    /** Same, for the ring. Rides the yard's clock - both are big and neither is urgent. */
    private TrenchScan trench = TrenchScan.EMPTY;
    private long yardScannedAt;
    /**
     * Whether the schematic Baritone is currently holding includes the yard.
     *
     * The yard is deliberately NOT in the schematic while the shell is going up.
     * Reaching a wall block four courses above the floor means PILLARING, and
     * the pillar goes down in the yard - so a schematic that wants the yard
     * empty would order her to break the scaffold she is standing on to place
     * the block she climbed up for. That is the same fight that had her breaking
     * and re-placing one interior block forever, moved outdoors.
     */
    private Scope builderScope = Scope.HOUSE;
    private String phase = "surveying";
    private boolean behaviourPushed;
    /**
     * True while {@link #widenBuilderSurvey} is holding baritone's builder survey
     * open, and therefore while {@link #restoreBuilderSurvey} still owes it a
     * restore. Also the once-only latch on saving the originals.
     */
    private boolean surveyWidened;
    private boolean savedDistanceTrim;
    private int savedIncorrectSize;
    private long builderKickAt;
    private int builderKicks;
    /** Last surveyed block tally, and when it last actually changed. */
    private String progressKey = "";
    private long progressAt;
    /** Best completion score seen this build - the kick budget only resets on a new best. */
    private int progressBest = Integer.MIN_VALUE;
    /** Where she was standing when she last moved, and when that was. */
    private BlockPos builderMotionPos;
    private long builderMotionAt;
    /** True from crossing the restock line until she is actually stocked again. */
    private boolean restocking;
    /** While set in the future, she builds by hand instead of driving Baritone. */
    private long handModeUntil;
    /** The one block the hands have committed to, what to do to it, and until when. */
    private BlockPos handTarget;
    private boolean handPlacing;
    private long handTargetUntil;
    /** When the current walk to the quarry started; 0 = not walking. */
    private long quarryWalkSince;
    /** Arrived at (or given up on) the quarry for THIS restock. See walkToQuarry. */
    private boolean quarryReached;
    /** The three light rotations, one per ring. See {@link LightRotation}. */
    private final LightRotation sideLights = new LightRotation("side light");
    private final LightRotation yardLights = new LightRotation("yard light");
    private final LightRotation trenchLights = new LightRotation("trench light");
    /**
     * Blocks the hands tried and could not lay. See {@link #handBuildStep}: the
     * torches have had this since the day one of them turned out to be
     * unplaceable, and the shell needed it for exactly the same reason.
     */
    private final java.util.Set<BlockPos> handDeferred = new java.util.LinkedHashSet<>();
    /**
     * The furthest stage this build has seen; it never goes backwards.
     *
     * A stage is worked out from the world, so a creeper taking the bed out
     * would otherwise drop her back to SHELL and shrink the plan around a house
     * that is plainly further along than that. Null until the first survey, so
     * the opening reading is free to be anything - the settlement's FULL default
     * must not be mistaken for a floor.
     */
    private ToasterTier.Stage stageFloor;

    public ToasterBuildTask(Settlement settlement) {
        if (settlement == null) throw new IllegalArgumentException("settlement is required");
        this.settlement = settlement;
    }

    public static JsonObject getLatestTelemetry() {
        return latestTelemetry == null ? null : latestTelemetry.deepCopy();
    }

    @Override
    protected void onStart(AltoClef mod) {
        mod.getBehaviour().push();
        behaviourPushed = true;
        // every stone that can become shell is protected, not just the preferred
        // one - otherwise the cobblestone she is about to build with gets spent
        // on something else mid-project.
        for (Block stone : Settlement.shellStoneByPreference()) {
            mod.getBehaviour().addProtectedItems(stone.asItem());
        }
        mod.getBehaviour().addProtectedItems(settlement.material().asItem(), Blocks.TORCH.asItem());
        // THE HOUSE IS NOT A QUARRY.
        //
        // The restock run asks for cobblestone, and MineOrCollectTask goes to the
        // NEAREST cobblestone it is allowed to break. Once she is standing on her
        // own roof, that is the course she just laid. On 2026-08-05 she placed
        // -2295,76,3260 at 00:44:48, mined it back out at 00:44:59, and re-placed
        // it at 00:56:23; the whole top course of the far wall cycled like that
        // for twenty minutes, and the survey tally kept moving the entire time, so
        // nothing upstream could see it as a stall - it looked like progress.
        //
        // Protecting inventory was never enough: the stone was not in her bag, it
        // was in the wall. This is the wall's version of addProtectedItems.
        //
        // IT DOES NOT LIVE ON THE BEHAVIOUR STACK ANY MORE. It used to be a
        // getBehaviour().avoidBlockBreaking() next to the lines above, and that
        // frame is popped in onStop - so the house was un-mineable only while she
        // was building it, and became ordinary stone the moment she finished.
        // Walking home then routinely cut a doorway through her own wall, because
        // straight through is shorter than round to the door. The rule belongs to
        // the HOUSE, not to this task, so it is registered somewhere the stack
        // cannot clear (see Settlement#protectFromMining) and stays true during a
        // goto, a mining trip and an idle tick alike.
        settlement.protectFromMining(mod::getWorld);
        surveyedAt = 0L;
        yard = YardScan.EMPTY;
        yardScannedAt = 0L;
        builderScope = Scope.HOUSE;
        phase = "surveying";
        builderKickAt = 0L;
        builderKicks = 0;
        progressKey = "";
        progressAt = 0L;
        progressBest = Integer.MIN_VALUE;
        restocking = false;
        handModeUntil = 0L;
        handTarget = null;
        handTargetUntil = 0L;
        quarryWalkSince = 0L;
        quarryReached = false;
        sideLights.forget();
        yardLights.forget();
        trenchLights.forget();
        trench = TrenchScan.EMPTY;
        // START AT ONE COURSE. The field defaults to full depth so a settlement
        // nobody is building never describes itself as half-dug, but a build that
        // is actually running has to open the ring a course at a time. Courses
        // already out re-open on the first survey - their remaining count is zero
        // - so resuming a dig costs one extra reading, not four.
        if (settlement.trenchEnabled()) settlement.setTrenchDepthAllowed(1);
        // NOT ON THE BEHAVIOUR STACK, for the same reason the house's mining guard
        // is not: a veto popped when the build ends is a veto lifted exactly when
        // a plain @goto starts pricing one dirt block across the ring.
        settlement.protectTrenchFromBridging();
        handDeferred.clear();
        stageFloor = null;
        refreshSurvey(mod, true);
    }

    @Override
    protected Task onTick(AltoClef mod) {
        Survey current = refreshSurvey(mod, false);
        // THE SITE IS OUT OF VIEW: go and stand in it. nothing about the house
        // can be judged from an unloaded chunk and Baritone cannot build what the
        // client has not got, so travelling is the only honest move. she used to
        // survey the void from hundreds of blocks away, "find" an empty lot, and
        // grind out a stone run for walls that were already standing.
        if (current == null || !siteLoaded(mod)) {
            stopBuilder(mod);
            restBuilderClock();
            phase = "traveling_to_site";
            setDebugState("site is out of view, heading to it");
            if (current != null) publish(current, true);
            return new GetWithinRangeOfBlockTask(settlement.origin(), 12);
        }
        noteProgress(current);
        if (current.complete()) {
            phase = "complete";
            setDebugState("");
            publish(current, false);
            stopBuilder(mod);
            return null;
        }

        // Shell and clearing are one idempotent schematic. A healthy stockpile
        // keeps Baritone working for several minutes instead of interrupting it
        // after every stack.
        boolean houseWork = current.shellRemaining() > 0 || current.clearRemaining > 0;
        // THE YARD WAITS FOR THE LIGHTS. Torches are thirty-six blocks and they
        // are what stops things spawning INSIDE the house; a yard is thousands
        // and it only stops them getting near it. Running the big outdoor job
        // first would leave her mowing a field around a dark house for an hour,
        // which is both the wrong order of work and the wrong thing to watch.
        boolean yardWork = !houseWork && current.yardRemaining > 0 && current.missingTorches.isEmpty();
        if (houseWork || yardWork) {
            // counted inside the branch that uses it: clearing a yard needs no
            // stone at all, and this walks thirty-five block types every tick.
            if (current.smoothStoneRemaining() > 0) {
                int stone = shellStoneCarried(mod);
                // HYSTERESIS, not one line used as both edges. Crossing 24 starts a
                // run; only being STOCKED ends it. Without the latch every tick
                // re-asked the same question, so the gather died at 25 and she
                // built four blocks before starting the walk over again.
                // ...and the band must never CLOSE. capping the upper edge at "how
                // much is still outstanding" collapses it to zero width exactly when
                // the deficit is small: with one block left, stocked == 1, so a single
                // block in the bag both starts the run (1 < 24) and ends it (1 >= 1) on
                // the same tick. that is the "runs out of blocks near the end and never
                // goes to fetch any" case - she latches and unlatches forever instead of
                // walking to the quarry. the floor keeps the two edges apart.
                int stocked = Math.max(STONE_RESTOCK_AT + 1,
                        Math.min(STONE_STOCKED_AT, current.smoothStoneRemaining()));
                if (stone < STONE_RESTOCK_AT) restocking = true;
                if (restocking && stone >= stocked) restocking = false;
                // the walk to the quarry belongs to ONE restock. see walkToQuarry.
                if (!restocking) quarryReached = false;
                if (restocking) {
                    stopBuilder(mod);
                    restBuilderClock();
                    // ALWAYS MINE FROM THE SAME MOUTH. see Settlement#quarryMouth:
                    // "nearest breakable stone" measured from the build site is a
                    // new scrape every restock, and measured from inside the last
                    // hole it is the next block of the same hole. Walking here
                    // first is the whole difference between twenty pits and a mine.
                    Task walk = walkToQuarry(mod);
                    if (walk != null) {
                        phase = "walking_to_quarry";
                        setDebugState("heading back to the mine");
                        publish(current, true);
                        return walk;
                    }
                    phase = "gathering_stone";
                    setDebugState("stone run");
                    publish(current, true);
                    int target = Math.min(STONE_BATCH, Math.max(STONE_STOCKED_AT, current.smoothStoneRemaining()));
                    // ResourceTask counts are a target to HOLD, not an amount to add,
                    // so this asks for `target` of the stone she already has most of -
                    // her existing pile counts toward it instead of being re-gathered.
                    return TaskCatalogue.getItemTask(stoneToGather(mod), target);
                }
            }
            // EATING, FIGHTING OR AN MLG OWNS THE HANDS. that is a transient hold by
            // a higher chain, not Baritone refusing the site, and counting it as a
            // refusal let one mob walking past condemn the whole house to
            // blocked_baritone_cannot_build. the phase is deliberately left ALONE:
            // host-side supervision hashes it as progress, so flapping it here would
            // fake progress and mute the very watchdog that should rotate her off.
            if (mod.getExtraBaritoneSettings().isInteractionPaused()) {
                setDebugState("something else has the hands right now");
                builderKickAt = System.currentTimeMillis();
                // A fight holds her on one block with the tally flat, which is the
                // wedge signature exactly. The builder is not the one standing
                // still here, so it does not get charged for it.
                restBuilderClock();
                publish(current, true);
                return null;
            }
            // BARITONE REFUSING IS NOT THE END OF THE HOUSE. AltoClef can place and
            // break blocks perfectly well on its own - slower, but it converges,
            // and every block it lands changes the survey tally, which is the only
            // thing that ever forgives the builder. Twice now she has stood in one
            // corner for two minutes with stone in her pocket while Baritone held a
            // schematic it would not act on, and the five kicks re-picked the same
            // impossible target every time. Hand mode is latched so one hand-laid
            // block cannot hand control straight back to the same dead state.
            long now = System.currentTimeMillis();
            if (now < handModeUntil) {
                Task hand = handBuildStep(mod, current);
                if (hand != null) {
                    // ONLY ON THE WAY IN. hand mode's PlaceBlockTask drives the SAME
                    // BuilderProcess we are stopping - it re-issues build() on any tick
                    // it finds the builder inactive. stopping it unconditionally here
                    // made the parent kill and the child restart the builder once per
                    // tick, forever: 20 "Run Structure Build" per second in the log,
                    // an onLostControl() through the middle of every placement, and a
                    // builder that could never keep a goal long enough to lay a block.
                    // she stood aimed at the target while the two of us fought over it.
                    // the entry below already stops it when baritone hands over, and a
                    // finished PlaceBlockTask releases it in its own onStop.
                    if (!"hand_building".equals(phase)) stopBuilder(mod);
                    phase = "hand_building";
                    setDebugState("laying it by hand - baritone would not");
                    publish(current, true);
                    return hand;
                }
                handModeUntil = 0L;
                // Ninety seconds of hand-laying is ninety seconds Baritone was not
                // driving. Handing it back on a clock that has been running the
                // whole time would trip the stall test on its first tick.
                restBuilderClock();
            }
            boolean working = driveBuilder(mod, current);
            // Two restarts without a single block landing is already enough of an
            // answer - waiting out the whole five-kick budget first is another two
            // minutes of standing in a field on stream. builderKicks only survives
            // while NOTHING changes; one real block resets it.
            if (!working || builderKicks >= 2) {
                Task hand = handBuildStep(mod, current);
                if (hand != null) {
                    handModeUntil = now + HAND_MODE_MS;
                    stopBuilder(mod);
                    phase = "hand_building";
                    setDebugState("laying it by hand - baritone would not");
                    publish(current, true);
                    return hand;
                }
            }
            // Named in the order the work actually happens now, so the readout on
            // stream does not say "clearing_interior" through an entire wall.
            phase = working
                ? (current.shellRemaining() > 0 ? current.nextShellPhase()
                    : current.clearRemaining > 0 ? "clearing_interior"
                    : current.yardRemaining > 0 ? "clearing_the_yard"
                    : current.trenchRemaining > 0 ? "digging_the_trench"
                    : "clearing_the_yard")
                : BLOCKED_PHASE;
            setDebugState(working ? "" : "baritone will not build this site");
            publish(current, true);
            return null;
        }

        setDebugState("");
        BlockPos missingTorch = nextTorchTarget(mod, current);
        if (missingTorch != null) {
            if (!mod.getItemStorage().hasItem(Blocks.TORCH.asItem())) {
                // going away to craft: baritone should not keep holding the site.
                stopBuilder(mod);
                phase = "crafting_side_torches";
                publish(current, true);
                // ask for what the plan still owes, not a fixed stack - 36 wall
                // torches fetched 16 at a time is three round trips.
                int owed = Math.max(TORCH_BATCH, current.torchTotal - current.torchCorrect + 8);
                return TaskCatalogue.getItemTask("torch", Math.min(64, owed));
            }
            // Lighting does not go through Baritone at all any more, so the
            // builder must not be left holding the site: BuilderProcess outranks
            // the CustomGoalProcess the interact task paths with, and a stale
            // schematic would quietly win every tick. stopBuilder is itself
            // guarded by isActive(), so calling it on every tick of the step is
            // free and removes the phase latch this branch used to need.
            stopBuilder(mod);
            phase = "lighting_sides";
            publish(current, true);
            // A WALL TORCH IS ONE RIGHT-CLICK ON THE FACE OF THE WALL THAT HOLDS
            // IT, and that is now literally how she places it.
            //
            // It used to be a one-block schematic handed to Baritone's
            // BuilderProcess, and that machinery has to clear approxPlaceable's
            // synthetic UP-facing context, hotbar promotion, an assembled pathing
            // goal and a reach-limited raytrace before a single click happens.
            // When any of those comes up empty the process says NOTHING - the log
            // showed "letting baritone place a block" followed by twelve seconds
            // of complete silence, no path, no error, per spot, thirty-six spots
            // deep, forever. Two rounds of fixes went into that chain (the
            // asItem() material gate, then the 20Hz parent/child fight) and she
            // still never lit a single torch.
            //
            // InteractWithBlockTask is the primitive every crafting table, chest
            // and furnace in this codebase already uses: it paths to the correct
            // SIDE of the block, aims at that face, equips the torch from
            // anywhere in the bag - not just the hotbar - and clicks. Vanilla's
            // WallTorchBlock.getStateForPlacement then derives the facing from
            // where she is standing, so approaching from the torch's own side is
            // what makes the state come out as the plan asked for, rather than us
            // asserting a blockstate and hoping the placement agrees.
            Direction facing = settlement.torchFacing(missingTorch);
            // WHICH BLOCK SHE CLICKS DEPENDS ON WHICH KIND OF TORCH IT IS, and
            // the layered plan asks for both. A WALL torch points AWAY from the
            // wall holding it, so the block to click is the neighbour on the
            // opposite side and the face is the one looking back at the torch's
            // own spot. A FLOOR torch - 104 of them, standing on the furnace
            // banks and the deck - faces UP, and then the block underneath is
            // what holds it up, exactly like the yard lights below.
            //
            // The two happen to be one expression (UP's opposite is DOWN), and
            // it is spelled out anyway because getting it wrong is not cosmetic:
            // PlaceBlockTask compares the whole blockstate, so a floor torch
            // asked for as a wall torch is a spot that can never be satisfied
            // and the lighting step rotates on it forever. It lives in
            // torchSupport so the rotation writes off the same block she clicks.
            return new InteractWithBlockTask(Items.TORCH, facing, torchSupport(missingTorch), false);
        }

        // THE DARK RING ROUND THE HOUSE. Last, because it is the one job that
        // needs the yard already felled: a torch goes on the ground, and until
        // the yard is clear "the ground" is whatever tree is standing there.
        BlockPos missingLight = nextPerimeterTarget(mod, current);
        if (missingLight != null) {
            if (!mod.getItemStorage().hasItem(Blocks.TORCH.asItem())) {
                stopBuilder(mod);
                phase = "crafting_yard_lights";
                publish(current, true);
                int owed = Math.max(TORCH_BATCH, current.perimeterTotal - current.perimeterCorrect + 8);
                return TaskCatalogue.getItemTask("torch", Math.min(64, owed));
            }
            stopBuilder(mod);
            phase = "lighting_the_yard";
            publish(current, true);
            // Same primitive as the wall torches, one face round: a standing torch
            // is a right-click on the TOP of the block underneath it, so the block
            // she clicks is the ground and the side is UP. Vanilla decides between
            // TORCH and WALL_TORCH from where she is stood, and the survey accepts
            // either - what matters here is that the spot stops being dark.
            return new InteractWithBlockTask(Items.TORCH, Direction.UP, missingLight.below(), false);
        }

        // THE RING, ONCE IT IS A RING. The digging itself belongs to the builder -
        // the trench box IS the schematic - so the hands only arrive for the two
        // jobs Baritone has no opinion about, and only after the last course is
        // out: a torch on the trench floor needs the floor to exist, and a gate on
        // the causeway needs the causeway either side of it.
        if (current.trenchWanted && current.trenchRemaining == 0) {
            BlockPos missingTrenchLight = nextTrenchTarget(mod, current);
            if (missingTrenchLight != null) {
                if (!mod.getItemStorage().hasItem(Blocks.TORCH.asItem())) {
                    stopBuilder(mod);
                    phase = "crafting_trench_lights";
                    publish(current, true);
                    int owed = Math.max(TORCH_BATCH,
                        current.trenchLightTotal - current.trenchLightCorrect + 4);
                    return TaskCatalogue.getItemTask("torch", Math.min(64, owed));
                }
                stopBuilder(mod);
                phase = "lighting_the_trench";
                publish(current, true);
                return new InteractWithBlockTask(Items.TORCH, Direction.UP,
                    missingTrenchLight.below(), false);
            }
            if (!current.trenchGateStanding) {
                // ANY wood family will do - the survey accepts any FenceGateBlock,
                // because what matters is that she can open it and nothing else can.
                adris.altoclef.util.ItemTarget gate = new adris.altoclef.util.ItemTarget(
                    adris.altoclef.util.helpers.ItemHelper.WOOD_FENCE_GATE, 1);
                if (!mod.getItemStorage().hasItem(
                        adris.altoclef.util.helpers.ItemHelper.WOOD_FENCE_GATE)) {
                    stopBuilder(mod);
                    phase = "crafting_the_gate";
                    publish(current, true);
                    return TaskCatalogue.getItemTask("fence_gate", 1);
                }
                stopBuilder(mod);
                phase = "hanging_the_gate";
                publish(current, true);
                return new InteractWithBlockTask(gate, Direction.UP,
                    settlement.causewayGate().below(), false);
            }
        }

        // A HOUSE SHE CANNOT LIGHT IS STILL A FINISHED SITE'S WORTH OF STANDING
        // ABOUT. Reaching here with lights still owed means every rotation has run
        // out of spots worth another turn, and complete() counts those torches, so
        // isFinished can never come true: without this she surveys, finds the same
        // dark spot, offers it nothing, and ticks here forever at 97%.
        //
        // BLOCKED_PHASE is the same definite answer the shell gives when baritone
        // refuses the site, and node already treats it as one - it collapses the
        // build's stall budget to BUILD_BLOCKED_GRACE_MS instead of the full
        // survey-silence budget, so the goal ends with a real outcome she can talk
        // about. It is not a claim the torches are lit: the survey still says they
        // are missing, and it will say so again if the build is dispatched afresh.
        if (sideLights.gaveUp() || yardLights.gaveUp() || trenchLights.gaveUp()) {
            stopBuilder(mod);
            phase = BLOCKED_PHASE;
            setDebugState("some lights will not go up - nothing else left to build");
            publish(current, true);
            return null;
        }

        // Nothing left to hand off to, so nobody should be holding the site.
        stopBuilder(mod);
        phase = "surveying";
        publish(current, true);
        return null;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        stopBuilder(mod);
        // these are GLOBAL baritone settings, not a behaviour frame, so nothing
        // else puts them back. an interrupt is a stop like any other here: the
        // widened survey is only correct while this task is the one driving the
        // builder, and the next ToasterBuildTask widens it again on its first
        // startBuilder.
        restoreBuilderSurvey();
        if (behaviourPushed) {
            mod.getBehaviour().pop();
            behaviourPushed = false;
        }
        Survey current = refreshSurvey(mod, true);
        publish(current, false);
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        // an UNSEEN site is not a finished one. no survey means no evidence
        // either way, and "no evidence" must never read as "done" - that is the
        // same shape as a cancelled build reporting itself complete.
        Survey current = refreshSurvey(mod, false);
        return current != null && current.complete();
    }

    @Override
    protected boolean isEqual(Task other) {
        if (!(other instanceof ToasterBuildTask task)) return false;
        Settlement a = task.settlement;
        return a.kind().equals(settlement.kind()) && a.anchor().equals(settlement.anchor())
            && a.width() == settlement.width() && a.depth() == settlement.depth()
            && a.height() == settlement.height();
    }

    @Override
    protected String toDebugString() {
        int percent = survey == null ? 0 : survey.percent();
        return "building " + settlement.kind().replace('_', ' ') + " "
            + settlement.width() + "x" + settlement.depth() + "x" + settlement.height()
            + " (" + percent + "%): " + phase;
    }

    /**
     * The only two stones she will set out to FETCH. Everything else in the
     * shell family is still accepted and still spent - it just is not worth
     * walking after, and the ones left out are left out for a reason:
     *
     *   stone / smooth_stone - smelt tasks, which is the fuel bill this whole
     *       change exists to stop paying.
     *   andesite / diorite / granite / tuff - specific veins, so a restock can
     *       strand her hunting one when plain rock is under her feet.
     *   blackstone - forceDimension(NETHER); wanting a wall must never book a
     *       nether trip.
     *
     * Both survivors are bulk collection tasks that mine whatever rock is
     * around, one for above the deepslate line and one for below it.
     */
    private static final java.util.LinkedHashMap<Block, String> GATHERABLE_STONE = new java.util.LinkedHashMap<>();
    static {
        GATHERABLE_STONE.put(Blocks.COBBLESTONE, "cobblestone");
        GATHERABLE_STONE.put(Blocks.COBBLED_DEEPSLATE, "cobbled_deepslate");
    }

    /** Every block in the inventory that is allowed to become shell. */
    private int shellStoneCarried(AltoClef mod) {
        // AN UPGRADE NARROWS THE ANSWER TO ONE BLOCK, and the count has to
        // narrow with it. Counting a pocketful of cobble as "stocked" while only
        // stone brick may be laid parks her on the site with a full bag, nothing
        // she is allowed to place, and no restock ever triggered.
        //
        // This cannot start a run for a block a stone run could never fetch: a
        // target is only ever named while she is holding at least
        // MATERIAL_SWITCH_STOCK of it (see ToasterTier#buildingMaterial), and
        // that is the same 64 as STONE_RESTOCK_AT - so by the time she has spent
        // down to where a run would begin, the target is already gone and every
        // shell stone counts again.
        Block target = settlement.shellUpgradeTarget();
        if (target != null) return mod.getItemStorage().getItemCount(target.asItem());
        int total = 0;
        for (Block stone : Settlement.shellStoneByPreference()) {
            total += mod.getItemStorage().getItemCount(stone.asItem());
        }
        if (!Settlement.shellStoneByPreference().contains(settlement.material())) {
            total += mod.getItemStorage().getItemCount(settlement.material().asItem());
        }
        return total;
    }

    /**
     * Walk to the quarry mouth ONCE per restock, or null when that is done (or
     * she has spent long enough trying).
     *
     * ONCE PER RESTOCK IS THE WHOLE POINT, and getting that wrong is what made
     * her wiggle on the spot forever the first time this shipped. Arriving is a
     * PRECONDITION of a stone run, not an invariant to hold during one: the
     * mining task's entire job is to walk her off to whatever stone it found, so
     * a per-tick "are you still at the quarry?" answers no a second later, hands
     * back a walk task, cancels the mine, and she is dragged back to the mouth -
     * arrive, mine, get dragged back, forever. `quarryReached` latches the
     * arrival for the rest of the run; the restock latch above clears it.
     *
     * (The file already says this ten lines up, about the stone threshold:
     * HYSTERESIS, not one line used as both edges. Same trap, same fix.)
     *
     * HORIZONTAL DISTANCE ONLY. Ten restocks in, the working face is twenty
     * blocks below the mouth, and a 3D check would call that "not at the quarry".
     *
     * AND IT IS BUDGETED, because an unreachable GetToBlockTask never fails - it
     * falls into TimeoutWanderTask and retries forever, which is the exact shape
     * of every statue bug this file already carries a fix for. If the walk cannot
     * be completed the run gives up and mines where she stands, which is simply
     * the behaviour from before the quarry existed. Never worse, usually a mine.
     */
    private Task walkToQuarry(AltoClef mod) {
        if (mod.getPlayer() == null) return null;
        if (quarryReached) return null;
        BlockPos mouth = settlement.quarryMouth();
        BlockPos at = mod.getPlayer().blockPosition();
        int dx = at.getX() - mouth.getX();
        int dz = at.getZ() - mouth.getZ();
        if (dx * dx + dz * dz <= QUARRY_ARRIVED_RANGE * QUARRY_ARRIVED_RANGE) {
            quarryWalkSince = 0L;
            quarryReached = true;
            return null;
        }
        long now = System.currentTimeMillis();
        if (quarryWalkSince == 0L) quarryWalkSince = now;
        if (now - quarryWalkSince > QUARRY_WALK_BUDGET_MS) {
            // latched too: a quarry she cannot reach must not be re-attempted
            // every tick for the rest of the run either.
            quarryReached = true;
            // Said out loud rather than swallowed: a quarry she can no longer
            // reach is worth knowing about, and the run continuing regardless is
            // the whole point of having a budget.
            Debug.logMessage("can't get back to the quarry at " + mouth.toShortString()
                + "; mining where i stand this run");
            return null;
        }
        return new GetWithinRangeOfBlockTask(mouth, QUARRY_ARRIVED_RANGE);
    }

    /**
     * Top up the stone she already has the most of. Restocking the existing pile
     * keeps one shell one colour, and it means a deepslate hole or a nether trip
     * finishes the toaster with what is under her feet instead of walking her
     * back to a smelter for a recipe she cannot afford yet.
     */
    private String stoneToGather(AltoClef mod) {
        String best = "cobblestone";
        int bestCount = 0;
        for (java.util.Map.Entry<Block, String> option : GATHERABLE_STONE.entrySet()) {
            int held = mod.getItemStorage().getItemCount(option.getKey().asItem());
            if (held > bestCount) {
                bestCount = held;
                best = option.getValue();
            }
        }
        return best;
    }

    /**
     * One block, by hand, with AltoClef's own tasks. Null means there is
     * genuinely nothing she can do unaided right now.
     *
     * THE SHELL COMES FIRST, AND THE TARGET IS HELD. Both halves of that are bug
     * fixes for the same forty-two seconds of the 2026-08-05 log, where she
     * broke and re-placed a block in one spot roughly every two seconds and
     * never laid anything.
     *
     * Clearing used to win, on the reasoning that breaking needs no materials.
     * But PlaceBlockTask drives Baritone's BuilderProcess, and a wall block four
     * above the floor is reached by PILLARING UP - so laying shell drops a
     * scaffold block into the interior by design. The next survey called that
     * scaffold a wrong interior block and broke it, found the interior clean,
     * went back to the wall, pillared up again, and put the block right back.
     * She was breaking her own ladder and rebuilding it, at -2279,69,3249,
     * forever. Sweeping the floor while still laying bricks is not a build
     * order; the interior is cleared once the shell is closed and nothing is
     * standing on it. An empty pocket still clears, because then there is no
     * scaffold to fight and breaking is the only useful thing left.
     *
     * And the block she picks is LATCHED until the world agrees it is done. Any
     * two hand targets can trade the hands back and forth when the choice is
     * re-asked every survey, because a fresh subtask cancels the one that was
     * mid-swing - re-deciding is what oscillates, not the decision.
     */
    private Task handBuildStep(AltoClef mod, Survey current) {
        if (handTarget != null) {
            Task keep = handTaskFor(mod, handTarget, handPlacing);
            if (keep != null && System.currentTimeMillis() < handTargetUntil) return keep;
            // WHICH WAY DID THE LATCH END? `keep == null` means the world now
            // agrees with the target - it landed. Still having work to hand back
            // when the clock has run out means twenty seconds of trying achieved
            // nothing, and re-picking is pointless: the survey names the NEAREST
            // outstanding block, so the same impossible one comes straight back.
            // That is the freeze - a 36% house and "laying it by hand" on screen
            // for as long as anyone cares to watch. Put it down and pick another.
            if (keep != null) {
                handDeferred.add(handTarget);
                Debug.logMessage("can't lay " + handTarget.toShortString() + " by hand; leaving it and taking another block");
            } else {
                // SOMETHING LANDED, SO THE GEOMETRY CHANGED. A block is usually
                // unplaceable because nothing solid is adjacent to click on, and
                // the block that just went in is very often exactly the face its
                // neighbour was missing. Everything deferred deserves another go.
                handDeferred.clear();
            }
            // A yard block she just cleared must not be handed straight back by a
            // reading up to four seconds old. The house is re-scanned below for
            // exactly this reason; the yard keeps a slower clock, so it has to be
            // told when one of its own answers has just been acted on.
            if (settlement.inYard(handTarget)) yardScannedAt = 0L;
            handTarget = null;
            // THE BLOCK LANDED, SO THE SURVEY THAT NAMED IT IS NOW A LIE. A
            // subtask does not stop itself here - the parent stops returning it -
            // so handing back the same finished position for the rest of the
            // survey interval is not merely stale, it is a hot loop:
            // PlaceBlockTask answers an already-correct target by re-issuing
            // Baritone's builder every tick, which completes instantly and
            // releases, twenty times a second. That is the "Run Structure
            // Build" / "done building (nothing incorrect left)" pair filling the
            // 00:27 log. Re-scan before choosing the next block.
            Survey fresh = refreshSurvey(mod, true);
            if (fresh != null) current = fresh;
        }
        BlockPos missing = current.firstMissingShell;
        // stone == null means the stone run owns the shell, not the hands.
        if (missing != null && carriedShellStone(mod) != null) {
            // FALL THROUGH rather than return, because a survey up to
            // SURVEY_INTERVAL_MS old can still be naming a position that has
            // since been filled. Returning null there would drop her out of hand
            // mode over a block that is already done.
            Task place = commitHand(mod, missing, true);
            if (place != null) return place;
        }
        if (current.firstWrongInterior != null) return commitHand(mod, current.firstWrongInterior, false);
        // THE DOORWAY AND THE TOAST SLOTS ARE BREAKING WORK TOO, and until now
        // the hands could not touch them: the only two things handBuildStep knew
        // how to want were a missing shell block and a wrong INTERIOR block, and
        // an opening is neither. So a shell that was finished except for a slot
        // Baritone would not cut had nothing left to fall back on - hand mode
        // returned null, the phase parked on blocked_baritone_cannot_build, and
        // the house could never be reported complete however long she stood in it.
        if (current.firstBlockedOpening != null) return commitHand(mod, current.firstBlockedOpening, false);
        // The yard last, and only once the house itself is done - see
        // builderYardMode for why clearing it any earlier fights the scaffold.
        if (current.shellRemaining() == 0 && current.clearRemaining == 0 && current.yardNearest != null) {
            Task cut = commitHand(mod, current.yardNearest, false);
            if (cut != null) return cut;
            yardScannedAt = 0L;   // it is already gone; the cached answer is stale
        }
        // THE RING AFTER THE YARD ABOVE IT, and it needs a hand fallback more than
        // any of them: a cell Baritone will not dig is a notch left in a wall whose
        // entire value is being unbroken, and the one thing she must never do about
        // it is bridge across - which the placement veto has already taken away.
        if (current.shellRemaining() == 0 && current.clearRemaining == 0
            && current.yardRemaining == 0 && current.trenchNearest != null) {
            // Unlike the yard, the ring is not all breaking work: the seal under it
            // and the causeway over it are both blocks that have to go IN, so the
            // hand job is whichever one this cell is short of.
            boolean placing = mod.getWorld().getBlockState(current.trenchNearest).isAir();
            Task dig = commitHand(mod, current.trenchNearest, placing);
            if (dig != null) return dig;
            yardScannedAt = 0L;   // the ring rides the yard's clock
        }
        return null;
    }

    /** Latch one block as the hands' job, and start doing it. */
    private Task commitHand(AltoClef mod, BlockPos target, boolean placing) {
        Task task = handTaskFor(mod, target, placing);
        if (task == null) return null;
        handTarget = target;
        handPlacing = placing;
        handTargetUntil = System.currentTimeMillis() + HAND_TARGET_MS;
        return task;
    }

    /**
     * The task for a committed target, or null once the world already agrees
     * with it - which is how a commitment ends early instead of on the clock.
     */
    private Task handTaskFor(AltoClef mod, BlockPos target, boolean placing) {
        BlockState state = mod.getWorld().getBlockState(target);
        if (placing) {
            if (!(state.getBlock() instanceof AirBlock)) return null;   // it is filled now
            Block stone = carriedShellStone(mod);
            if (stone == null) return null;
            return new PlaceBlockTask(target, stone);
        }
        // The yard has its own idea of what may be removed - it refuses fluids,
        // unbreakables and anything a person placed, none of which preserveInterior
        // knows about, and it permits plain terrain, which preserveInterior would
        // have let her swing at forever if it had said no.
        if (settlement.inYard(target)) {
            return settlement.isYardObstruction(state) ? new DestroyBlockTask(target) : null;
        }
        if (state.getBlock() instanceof AirBlock) return null;
        // An opening is MEANT to be air, so nothing standing in one is furniture
        // worth keeping - a chest pushed into the doorway is still a blocked door.
        if (!settlement.isEntrance(target) && !settlement.isToastSlot(target)
            && settlement.preserveInterior(state)) return null;
        return new DestroyBlockTask(target);
    }

    /** The shell stone she is actually carrying, in blueprint preference order. */
    private Block carriedShellStone(AltoClef mod) {
        // While a renovation is on, the only correct block is the target - so
        // handing the hands anything else would lay a block the very next survey
        // reads as wrong and orders broken out again.
        Block target = settlement.shellUpgradeTarget();
        if (target != null) {
            return mod.getItemStorage().getItemCount(target.asItem()) > 0 ? target : null;
        }
        for (Block stone : Settlement.shellStoneByPreference()) {
            if (mod.getItemStorage().getItemCount(stone.asItem()) > 0) return stone;
        }
        if (mod.getItemStorage().getItemCount(settlement.material().asItem()) > 0) {
            return settlement.material();
        }
        return null;
    }

    private void stopBuilder(AltoClef mod) {
        if (mod.getClientBaritone().getBuilderProcess().isActive()) {
            mod.getClientBaritone().getBuilderProcess().onLostControl();
        }
    }

    /**
     * WIDEN THE BUILDER'S VIEW TO THE SIZE OF THE THING BEING BUILT.
     *
     * Baritone's builder defaults are sized for "path over there and fix a few
     * blocks", and two of them are actively hostile to a settlement:
     *
     *   distanceTrim (true)  - BuilderProcess#trim runs EVERY TICK and drops any
     *                          outstanding cell more than sqrt(200) ~ 14.1 blocks
     *                          from her feet.
     *   incorrectSize (100)  - not a soft cap. It is an early `return` out of the
     *                          middle of fullRecalc's scan loop, so past 100 cells
     *                          the rest of the schematic is never even looked at.
     *
     * On their own those are survivable. What makes them a wedge is that
     * fullRecalc is NOT periodic: BuilderProcess#recalc runs it once, and then
     * only ever again when incorrectPositions drains to EXACTLY empty. Between
     * those two moments the only thing adding work is recalcNearby, which reaches
     * builderTickScanRadius (5) blocks.
     *
     * So: one cell she cannot satisfy - a torch whose facing can never match, a
     * block whose support is missing, anything the unplaceable/handDeferred sets
     * are there to survive - sits inside the trimmed neighbourhood and keeps the
     * set non-empty forever. fullRecalc never re-runs, the rest of the structure
     * is never re-added, and she works a 14-block bubble around one impossible
     * block for as long as you let her. The plan v2 toaster is 13x21x11 and the
     * trench ring is ~1240 cells; neither fits in that bubble, so most of the
     * build is invisible to the builder for most of the build.
     *
     * The cap is raised to the scope's own box rather than switched off, and the
     * ceiling is a real limit and not a formality - see SURVEY_CELL_CEILING.
     */
    private void widenBuilderSurvey(int boxCells) {
        Settings settings = BaritoneAPI.getSettings();
        // save ONCE. startBuilder is re-issued on every scope change and on every
        // builder kick, and saving each time would capture our own widened values
        // as the "originals" and make the restore a no-op.
        if (!surveyWidened) {
            savedDistanceTrim = settings.distanceTrim.value;
            savedIncorrectSize = settings.incorrectSize.value;
            surveyWidened = true;
        }
        settings.distanceTrim.value = false;
        settings.incorrectSize.value = surveyCapFor(boxCells, savedIncorrectSize);
    }

    /**
     * The widened incorrectSize for a box of {@code boxCells}, given whatever the
     * setting was before we touched it.
     *
     * Pure and static so the invariants are checkable without a client: it never
     * returns below {@code previous} (an operator who raised it by hand keeps
     * their value), never above {@link #SURVEY_CELL_CEILING}, and is monotonic in
     * the box size. A degenerate box cannot shrink the cap below what was there.
     */
    static int surveyCapFor(int boxCells, int previous) {
        return Math.max(previous, Math.min(boxCells, SURVEY_CELL_CEILING));
    }

    /**
     * Put both settings back exactly as they were found. Deliberately restores the
     * SAVED values rather than the stock defaults: an operator who had set either
     * of these by hand gets their value back, not baritone's.
     */
    private void restoreBuilderSurvey() {
        if (!surveyWidened) return;
        Settings settings = BaritoneAPI.getSettings();
        settings.distanceTrim.value = savedDistanceTrim;
        settings.incorrectSize.value = savedIncorrectSize;
        surveyWidened = false;
    }

    /**
     * Hand Baritone the schematic for the job in front of her.
     *
     * The box is sized to the mode rather than always being the big one: while
     * the shell is going up she wants Baritone recalculating over ~1000
     * positions, not the ~7900 the yard box covers, and eight times the recalc
     * is eight times the pause every time it is kicked.
     */
    private void startBuilder(AltoClef mod, Scope scope) {
        builderScope = scope;
        SettlementSchematic schematic = new SettlementSchematic(settlement, scope);
        // the BOX volume, which over-estimates the number of cells that actually
        // carry a desired state - the safe direction for a cap.
        widenBuilderSurvey(schematic.widthX() * schematic.heightY() * schematic.lengthZ());
        mod.getClientBaritone().getBuilderProcess().build(
            settlement.kind() + "_" + settlement.name(),
            schematic,
            scopeOrigin(settlement, scope));
    }

    /**
     * How far outside the walls each box reaches. The trench box is the only one
     * that also grows DOWNWARD - see {@link #scopeOrigin}.
     */
    private enum Scope { HOUSE, YARD, TRENCH }

    private static int scopeMargin(Scope scope) {
        return switch (scope) {
            case HOUSE -> 0;
            case YARD -> Settlement.YARD_MARGIN;
            case TRENCH -> Settlement.YARD_MARGIN + Settlement.TRENCH_WIDTH;
        };
    }

    private static BlockPos scopeOrigin(Settlement s, Scope scope) {
        return switch (scope) {
            case HOUSE -> s.origin();
            case YARD -> new BlockPos(s.yardMinX(), s.floorY(), s.yardMinZ());
            // the one box whose floor is not the house's floor: the trench is dug
            // below grade, so the schematic has to start four courses under it.
            case TRENCH -> new BlockPos(s.trenchMinX(), s.trenchFloorY(), s.trenchMinZ());
        };
    }

    /**
     * Which box the job in front of her needs.
     *
     * TRENCH is a strict superset - it contains the yard box and the house - so
     * nothing is lost by being in it and a wall opened by a creeper is still
     * repaired. It is not the permanent choice only because it covers ~9500
     * positions to the house's ~1000, and every builder kick pays that recalc.
     *
     * The trench comes last for the same reason the yard waits for the wall
     * torches: it is the one job that needs everything before it already true,
     * and digging it while the yard is still a forest just moves her back and
     * forth across the site.
     */
    private Scope scopeFor(Survey current) {
        if (current.shellRemaining() > 0 || current.clearRemaining > 0) return Scope.HOUSE;
        if (settlement.trenchEnabled()
            && current.yardRemaining == 0
            && current.perimeterCorrect == current.perimeterTotal) return Scope.TRENCH;
        return Scope.YARD;
    }

    /**
     * Keep Baritone actually building, and never mistake "holding a schematic"
     * for "working".
     *
     * isActive() is `schematic != null`. When Baritone cannot assemble a goal it
     * logs "Unable to do it. Pausing.", sets paused, and clears every key - so it
     * stays active while standing perfectly still, forever. The old guard only
     * re-issued build() when !isActive(), which that pause can never satisfy, so
     * the whole task deadlocked: Baritone paused, this tick returned no subtask,
     * isFinished() stayed false, and she stood in the build site indefinitely
     * with the phase still reading "clearing_interior".
     *
     * A paused builder is therefore restarted, not resumed: onLostControl clears
     * paused AND the stale incorrectPositions, so the fresh build() re-runs a
     * full recalc instead of replaying the same dead goal. Kicks are spaced so a
     * genuinely impossible build cannot become a hot loop, and after
     * BUILDER_KICK_LIMIT consecutive refusals the spacing widens and the phase
     * parks on one STABLE blocked string - stable because host-side progress
     * supervision hashes the phase, so a flapping one would read as progress and
     * suppress the very watchdog that should rotate her onto something else.
     *
     * isPaused() is NOT enough on its own, which is what soft-locked her for
     * seven silent minutes on 2026-08-04. Baritone has dead states where it
     * holds a schematic, reports itself unpaused, logs nothing, and moves
     * nothing:
     *
     *   - a pending inventory move returns REQUEST_PAUSE every tick WITHOUT
     *     ever setting `paused` (BuilderProcess: "awaiting inventory move"), and
     *   - a placement it can never land keeps forcing SNEAK + right-click at a
     *     block that never changes, with no goal and no pathing.
     *
     * Both satisfied the old `isActive() && !isPaused()` guard, so the task
     * reported "working" forever, the phase read a healthy "clearing_interior",
     * and the kick counter - which only ever incremented inside the isPaused()
     * branch - never reached the limit, so BLOCKED_PHASE was unreachable in
     * exactly the states that needed it.
     *
     * So liveness is MEASURED, never taken on the builder's word: the survey
     * tally is the ground truth, and a builder that has not changed one block in
     * BUILDER_STALL_MS is dead however healthy it claims to be. Every kick is
     * counted now, whatever the reason, so escalation to BLOCKED_PHASE works in
     * all of these states rather than only the one that admits to being paused.
     *
     * @return true while Baritone is demonstrably on the job (or inside a kick's
     *         backoff); false once it has refused long enough to hand her over.
     */
    private boolean driveBuilder(AltoClef mod, Survey current) {
        IBuilderProcess builder = mod.getClientBaritone().getBuilderProcess();
        long now = System.currentTimeMillis();
        long idleMs = progressAt == 0L ? 0L : now - progressAt;
        boolean stalled = progressAt != 0L && idleMs >= BUILDER_STALL_MS;
        // Motion is sampled on every drive tick, so "how long has she been on this
        // block" is available without the builder having to admit anything.
        BlockPos standing = mod.getPlayer().blockPosition();
        if (builderMotionPos == null || !builderMotionPos.equals(standing)) {
            builderMotionPos = standing;
            builderMotionAt = now;
        }
        // WEDGED: nothing built AND she has not moved. Neither half is damning on
        // its own - a stone run leaves the tally flat, and mining one block holds
        // her still - but a builder that is genuinely working cannot do both at
        // once for twelve seconds. This is what catches the states Baritone will
        // not report: a pending inventory move that returns REQUEST_PAUSE without
        // ever setting `paused`, and a placement it re-attempts forever at a block
        // that never changes.
        boolean wedged = progressAt != 0L && builderMotionAt != 0L
            && idleMs >= BUILDER_MOTIONLESS_MS
            && now - builderMotionAt >= BUILDER_MOTIONLESS_MS;
        // THE SCHEMATIC CHANGES SHAPE ONCE THE HOUSE IS CLOSED, and Baritone holds
        // whichever one it was handed. Without this the shell would finish and she
        // would carry on driving a schematic that has no opinion about the yard -
        // active, unpaused, perfectly healthy, and with nothing left to do, which
        // is a builder that reports "working" while standing in a field.
        Scope wantScope = scopeFor(current);
        if (builder.isActive() && wantScope != builderScope) {
            // Every direction: a creeper opening the wall pulls the schematic back
            // off the trench or the yard and onto the house, which is the right
            // order - there is no point ringing a house that has a hole in it.
            Debug.logMessage("toaster build: switching the schematic to the "
                + switch (wantScope) {
                    case HOUSE -> "house - it needs repairing again";
                    case YARD -> "yard - the house is closed";
                    case TRENCH -> "trench - the yard is clear and lit";
                });
            stopBuilder(mod);
            startBuilder(mod, wantScope);
            // a brand new schematic has not had a chance to place anything yet, so
            // it starts on a clean clock rather than inheriting the shell's.
            builderKicks = 0;
            builderKickAt = now;
            restBuilderClock();
            return true;
        }
        if (builder.isActive() && !builder.isPaused() && !stalled && !wedged) return true;

        boolean refused = builderKicks >= BUILDER_KICK_LIMIT;
        // A declared pause is a fact, so it can be retried briskly. A STALL is an
        // inference, and restarting the builder costs a fresh recalc plus a path
        // - re-judging that 4 seconds later would spend the whole kick budget
        // before any single kick had a chance to place one block, and blame a
        // healthy build that was merely walking to the far corner.
        //
        // A WEDGE is not that inference. The restarted builder is being watched by
        // the same motion test that condemned it, and that test clears itself the
        // instant she takes one step - so a restart that worked stops being judged
        // on its own merits rather than on a clock. Only a restart that leaves her
        // standing exactly where she was gets re-judged, and twelve more seconds of
        // statue is proof enough. This is the difference between escaping a dead
        // builder in 24 seconds and escaping it in 65.
        long cooldown = refused ? BUILDER_BLOCKED_COOLDOWN_MS
            : (wedged ? BUILDER_MOTIONLESS_MS
            : (stalled ? BUILDER_STALL_RETRY_MS : BUILDER_KICK_COOLDOWN_MS));
        if (builderKickAt != 0L && now - builderKickAt < cooldown) return !refused;
        builderKickAt = now;
        builderKicks++;
        // everything a human needs to tell the four candidate causes apart without
        // reading source: whose hands, what stock, where she is standing, and what
        // Baritone claims about itself. this line was a no-op until Debug was
        // reconnected, which is why the last three freezes were guesswork.
        mod.logWarning("toaster build: builder is not building (active=" + builder.isActive()
            + " paused=" + builder.isPaused() + " idle=" + (idleMs / 1000)
            + "s still=" + ((now - builderMotionAt) / 1000) + "s" + (wedged ? " WEDGED" : "")
            + ", " + current.remainingSummary()
            + ", shellStone=" + shellStoneCarried(mod)
            + ", interactionPaused=" + mod.getExtraBaritoneSettings().isInteractionPaused()
            + ", at=" + mod.getPlayer().blockPosition().toShortString()
            + ", origin=" + settlement.origin().toShortString()
            + ") - restart " + builderKicks
            + (builderKicks >= BUILDER_KICK_LIMIT ? ", giving up on this site" : ""));
        stopBuilder(mod);
        startBuilder(mod, wantScope);
        // The stall clock is deliberately NOT given back here. It stays tripped
        // until a real block lands, so BUILDER_STALL_RETRY_MS paces the kicks
        // directly: one restart, one window to place something, then the next.
        // Handing the clock back instead would stretch every window back out to
        // the full stall timeout and quadruple how long she stands there.
        return builderKicks < BUILDER_KICK_LIMIT;
    }

    /**
     * The block she must CLICK to put a torch in {@code spot}.
     *
     * A WALL torch points AWAY from the wall holding it, so the block to click is
     * the neighbour on the opposite side. A FLOOR torch faces UP and is held up by
     * the block underneath. Both the rotation below and the InteractWithBlockTask
     * the lighting step hands back ask through here, so the block she is judged
     * unable to reach is always the block she was actually sent to click.
     */
    private BlockPos torchSupport(BlockPos spot) {
        Direction facing = settlement.torchFacing(spot);
        return facing == Direction.UP ? spot.below() : spot.relative(facing.getOpposite());
    }

    private BlockPos nextTorchTarget(AltoClef mod, Survey current) {
        return sideLights.next(current.missingTorches, unreachable(mod), this::torchSupport,
            look(mod, this::torchSupport, settlement::torchFacing));
    }

    private BlockPos nextPerimeterTarget(AltoClef mod, Survey current) {
        // A yard light stands on the ground, so the ground is what she clicks.
        return yardLights.next(current.missingPerimeter, unreachable(mod), BlockPos::below,
            look(mod, BlockPos::below, spot -> Direction.UP));
    }

    private BlockPos nextTrenchTarget(AltoClef mod, Survey current) {
        return trenchLights.next(current.trenchMissingLights, unreachable(mod), BlockPos::below,
            look(mod, BlockPos::below, spot -> Direction.UP));
    }

    /**
     * How the attempt on one spot is actually going, asked of the world.
     *
     * The rotation cannot ask the InteractWithBlockTask directly - the build task
     * hands back a fresh equal instance every tick and the task system keeps the
     * live one, so the object here is never the object running. It does not need
     * it: both facts are in the world. Reach is the same call the interact task
     * makes to decide whether to click at all, and distance is just where she is.
     */
    private java.util.function.Function<BlockPos, LightRotation.Attempt> look(
            AltoClef mod,
            java.util.function.Function<BlockPos, BlockPos> supportOf,
            java.util.function.Function<BlockPos, Direction> faceOf) {
        return spot -> {
            BlockPos support = supportOf.apply(spot);
            boolean reach = adris.altoclef.util.helpers.LookHelper
                .getReach(support, faceOf.apply(spot)).isPresent();
            double distance = mod.getPlayer() == null ? Double.NaN
                : Math.sqrt(mod.getPlayer().position().distanceToSqr(
                    support.getX() + 0.5, support.getY() + 0.5, support.getZ() + 0.5));
            return new LightRotation.Attempt(reach, distance);
        };
    }

    /** AltoClef's standing verdict on whether she can get to a block at all. */
    private static java.util.function.Predicate<BlockPos> unreachable(AltoClef mod) {
        return pos -> mod.getBlockTracker().unreachable(pos);
    }

    /**
     * One light rotation - the wall torches, the yard ring, or the trench floor.
     *
     * The lighting step runs AFTER the builder is stopped, so none of the stall
     * machinery that watches the shell is watching here: a spot that will not take
     * a torch has nothing to move her off it. So a spot gets TORCH_ATTEMPT_MS of
     * her attention and is then deferred, and the next one gets a turn. For a spot
     * that is merely awkward that is still not giving up - when every remaining
     * spot has had a turn the set empties and the rotation comes round again.
     *
     * THAT ROUND HAS TO BE COUNTED, THOUGH. The reset used to be unconditional,
     * which is a perfect infinite loop the moment every remaining spot is one she
     * can NEVER place on: defer, defer, defer, clear, defer, forever. Live, at 97%
     * built: 204 attempts across the same 3 side lights in one hour, 12 seconds
     * each, and nothing anywhere in the three processes said a word about it.
     *
     * There are two ways out now and they answer different failures:
     *
     *  - ALTOCLEF'S OWN VERDICT, which already existed and was simply never read.
     *    InteractWithBlockTask calls requestBlockUnreachable on the support block
     *    when it cannot get to it, and by the end of that hour the tracker was
     *    logging "Try 66 / 4" against a threshold of four while this rotation
     *    handed the same spot straight back. Asking costs nothing.
     *  - LIGHT_ROUND_LIMIT fruitless rounds, for the spot she can path to and
     *    still not place on. That is what the other two spots in that log were:
     *    no blacklist entry ever, just twelve seconds of nothing, on repeat.
     *
     * Giving up on PLACING is not a claim the spot is lit. The survey still counts
     * it missing, so complete() stays false and the site is never reported
     * finished on the strength of having given up - the caller escalates to
     * BLOCKED_PHASE instead, which is the definite answer node already knows how
     * to end a build on.
     *
     * Any progress wipes every verdict here: one torch landing anywhere means the
     * world is no longer the one those verdicts were formed in, and the spot she
     * could not reach is very often the one that torch just opened up.
     */
    private static final class LightRotation {
        /**
         * How the attempt on the current spot is going. {@code distance} is to the
         * block she must CLICK, and is NaN when there is no player to ask.
         */
        record Attempt(boolean inReach, double distance) {}

        private final String what;
        private BlockPos target;
        private long targetAt;
        /** When she last got measurably nearer the spot, or first reached it. */
        private long sinceProgress;
        /** When she came into reach; 0 = she has not. */
        private long arrivedAt;
        /** The nearest she has been to this spot, so closing in is detectable. */
        private double closest = Double.MAX_VALUE;
        /** Spots that have had their turn this round. */
        private final java.util.Set<BlockPos> deferred = new java.util.LinkedHashSet<>();
        /** Spots written off for good - see gaveUp(). */
        private final java.util.Set<BlockPos> impossible = new java.util.LinkedHashSet<>();
        private int fruitlessRounds;
        /** How many were outstanding last tick; -1 = no reading yet. */
        private int lastMissing = -1;

        LightRotation(String what) {
            this.what = what;
        }

        /**
         * Has this spot had a fair go? Three clocks, because "she is getting
         * nowhere" and "she has been at this a while" are different claims.
         *
         * The whole give-up used to be one line - twelve seconds of wall clock
         * since the spot was picked - which counted baritone's path computation,
         * the walk, the approach and the click against the block, and then
         * reported the block as the thing at fault. On a loaded server a single
         * path took thirteen seconds to compute, so the budget could expire
         * before she had taken a step, and worse, it expired three seconds into
         * a click that was already underway.
         *
         *  - IN REACH: she is there, with the face in front of her. Whether it
         *    takes a torch is now a fact about the block, and TORCH_REACH_MS is
         *    the honest time to establish it.
         *  - CLOSING: getting nearer is progress by any reading, so the stuck
         *    clock restarts. A spot she is walking to is not a spot that refuses
         *    her. Half a block of movement so ordinary jitter does not count.
         *  - Otherwise TORCH_ATTEMPT_MS of going nowhere, which is what the
         *    twelve seconds was always meant to mean, and TORCH_CEILING_MS over
         *    everything so no amount of progress holds the rotation for good.
         *
         * Note this leaves AltoClef's own verdict room to form: the block
         * tracker needs four failed approaches to call a block unreachable, and
         * a budget that cut every approach short never let it get there. pick()
         * has always asked; now the answer exists.
         */
        private boolean hadItsGo(long now, Attempt at) {
            if (now - targetAt >= TORCH_CEILING_MS) return true;
            if (at.inReach()) {
                if (arrivedAt == 0L) arrivedAt = now;
                return now - arrivedAt >= TORCH_REACH_MS;
            }
            arrivedAt = 0L;
            if (at.distance() < closest - 0.5) {
                closest = at.distance();
                sinceProgress = now;
            }
            return now - sinceProgress >= TORCH_ATTEMPT_MS;
        }

        BlockPos next(List<BlockPos> missing,
                      java.util.function.Predicate<BlockPos> unreachable,
                      java.util.function.Function<BlockPos, BlockPos> supportOf,
                      java.util.function.Function<BlockPos, Attempt> look) {
            if (missing.isEmpty()) {
                forget();
                return null;
            }
            long now = System.currentTimeMillis();
            boolean progressed = (lastMissing >= 0 && missing.size() < lastMissing)
                || (target != null && !missing.contains(target));
            if (progressed) forget();
            lastMissing = missing.size();

            if (gaveUp()) return null;

            if (target != null && hadItsGo(now, look.apply(target))) {
                deferred.add(target);
                Debug.logMessage(what + " at " + target.toShortString()
                    + " will not take a torch, trying another spot");
                target = null;
            }
            if (target == null) {
                BlockPos pick = pick(missing, unreachable, supportOf);
                if (pick == null) {
                    // Every spot left has had its turn and not one of them took a
                    // torch. Round again - but not forever.
                    fruitlessRounds++;
                    if (gaveUp()) {
                        impossible.addAll(deferred);
                        deferred.clear();
                        Debug.logMessage(what + ": " + impossible.size()
                            + " spot(s) will not take a torch after " + LIGHT_ROUND_LIMIT
                            + " rounds, giving up on them");
                        return null;
                    }
                    deferred.clear();
                    pick = pick(missing, unreachable, supportOf);
                    if (pick == null) return null;
                }
                target = pick;
                targetAt = now;
                sinceProgress = now;
                arrivedAt = 0L;
                closest = Double.MAX_VALUE;
            }
            return target;
        }

        /** The first spot still worth a turn, writing off any the tracker refuses. */
        private BlockPos pick(List<BlockPos> missing,
                              java.util.function.Predicate<BlockPos> unreachable,
                              java.util.function.Function<BlockPos, BlockPos> supportOf) {
            for (BlockPos pos : missing) {
                if (deferred.contains(pos) || impossible.contains(pos)) continue;
                if (unreachable.test(supportOf.apply(pos))) {
                    impossible.add(pos);
                    continue;
                }
                return pos;
            }
            return null;
        }

        /** Has this ring run out of spots it has any reason to try again? */
        boolean gaveUp() {
            return fruitlessRounds >= LIGHT_ROUND_LIMIT;
        }

        void forget() {
            target = null;
            targetAt = 0L;
            sinceProgress = 0L;
            arrivedAt = 0L;
            closest = Double.MAX_VALUE;
            deferred.clear();
            impossible.clear();
            fruitlessRounds = 0;
            lastMissing = -1;
        }
    }

    /**
     * OPEN ONE COURSE AT A TIME, and only when the one above it is finished.
     *
     * This is what makes the staircase reachable at every moment of the dig
     * rather than only once it is carved: the stairs are clamped by the same
     * gate, so the deepest ground anywhere in the ring is never more than one
     * course below the step beside it. Without it the builder works by proximity
     * and sinks a single four-deep shaft wherever it happens to begin - and with
     * bridging vetoed, standing at the bottom of that shaft is a trap she has no
     * move out of.
     *
     * Bounded by TRENCH_DEPTH, so a resumed build catches up in one pass instead
     * of one course per survey.
     */
    private boolean advanceTrenchLayer(TrenchScan scan) {
        if (!settlement.trenchEnabled() || scan == null) return false;
        if (scan.remaining > 0) return false;
        int open = settlement.trenchDepthAllowed();
        if (open >= Settlement.TRENCH_DEPTH) return false;
        settlement.setTrenchDepthAllowed(open + 1);
        Debug.logMessage("toaster build: trench course " + (open + 1)
            + " of " + Settlement.TRENCH_DEPTH + " open");
        return true;
    }

    /**
     * Ground truth for "is anything actually happening". The survey tally only
     * moves when a real block in the site changed, so it cannot be refreshed by
     * her shuffling on the spot - which is precisely how the host-side stall
     * watchdog was being kept alive through a frozen build.
     *
     * A changed tally is also the ONLY thing that forgives the builder: the kick
     * budget resets here and nowhere else, so a builder that keeps being
     * restarted without ever laying a block still runs out of credit and parks
     * on BLOCKED_PHASE.
     */
    private void noteProgress(Survey current) {
        String key = current.progressKey();
        if (progressAt != 0L && key.equals(progressKey)) return;
        progressKey = key;
        progressAt = System.currentTimeMillis();
        // FORGIVE THE BUILDER ONLY WHEN IT GAINED GROUND. a changed key means the
        // site changed, which an oscillation does every single cycle - 41 -> 40 ->
        // 41 is three fresh keys and zero progress. resetting the kick budget on
        // that handed the builder infinite credit in exactly the state the budget
        // exists to catch. the clock above still moves (the world IS changing, so
        // this is not a stall), but the kick budget now needs a new best.
        int score = current.progressScore();
        if (progressBest == Integer.MIN_VALUE || score > progressBest) {
            progressBest = score;
            builderKicks = 0;
        }
    }

    /**
     * Hand the site back to the builder with a clean slate.
     *
     * The liveness clock measures the builder, so it may only run while the
     * builder is the one holding the hands. It was running the whole time she was
     * away on a stone run, walking to the site, or laying blocks by hand - none of
     * which Baritone can be blamed for, and all of which take minutes. The first
     * drive tick after a four-minute gather therefore read `idle=234s` and
     * condemned a builder that had not yet been given a schematic, which is the
     * 00:42:30 line of the 2026-08-05 log. Every kick after that was spent on
     * paced retries of a build that had never actually been tried once.
     *
     * Zeroing progressAt rather than stamping it hands the decision to
     * noteProgress on the next tick, which is the one place allowed to say when
     * the clock starts.
     */
    private void restBuilderClock() {
        progressAt = 0L;
        builderMotionPos = null;
        builderMotionAt = 0L;
    }

    /**
     * A SURVEY OF UNLOADED CHUNKS IS NOT EVIDENCE. The client hands back air for
     * every block in a chunk it does not have, so scanning the site from across
     * the world reads as "nothing here is built" - which publishes a phantom 0%
     * over real persisted progress and starts a resupply run for a wall that
     * already stands. Every corner is checked because the box straddles chunks.
     */
    private boolean siteLoaded(AltoClef mod) {
        int y = settlement.floorY();
        return mod.getChunkTracker().isChunkLoaded(new BlockPos(settlement.minX(), y, settlement.minZ()))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(settlement.maxX(), y, settlement.minZ()))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(settlement.minX(), y, settlement.maxZ()))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(settlement.maxX(), y, settlement.maxZ()));
    }

    /**
     * WHICH STAGE THE WORLD IS AT, re-read every survey and never remembered.
     *
     * The stage she should be working on is the LOWEST one that is not finished,
     * so she lives in the silhouette from night one and the furniture arrives
     * later. Every stage is a superset of the one before it, so this is a walk
     * up the list that stops at the first thing still owed.
     *
     * @return true when the stage actually moved, which makes the survey that
     *         was just taken stale - it counted fixtures against the old scope.
     */
    private boolean advanceStage(AltoClef mod, Survey current) {
        // Only the layered plan has stages. The old extruded geometry ignores
        // the field entirely and must keep its FULL default, or a 14x9x8 house
        // that is already standing would find its gallery cut down to nothing.
        if (!ToasterLayout.applies(settlement)) return false;
        ToasterTier.Stage want = ToasterTier.Stage.FULL;
        for (ToasterTier.Stage candidate : ToasterTier.Stage.values()) {
            if (!stageSatisfied(mod, current, candidate)) {
                want = candidate;
                break;
            }
        }
        if (stageFloor != null && want.ordinal() < stageFloor.ordinal()) want = stageFloor;
        stageFloor = want;
        if (settlement.stage() == want) return false;
        Debug.logMessage("toaster build: working the " + stageName(want) + " stage now");
        settlement.setStage(want);
        return true;
    }

    /**
     * Is every block this stage claims actually standing?
     *
     * The shell and the openings are the same in every stage and the survey has
     * just read all 1126 of them, so that half of the answer is taken from the
     * tally rather than paid for twice - re-walking the shell here would double
     * the cost of the most expensive part of the pass for something already in
     * hand. Everything else is a fixture, and there are 2 of them at SHELL and
     * 19 at LIVED_IN, so the common case is a handful of block reads.
     */
    private boolean stageSatisfied(AltoClef mod, Survey current, ToasterTier.Stage candidate) {
        if (current.shellRemaining() > 0) return false;
        for (ToasterLayout.Cell cell : ToasterLayout.cellsFor(settlement, candidate)) {
            if (cell.glyph == ToasterLayout.SHELL) continue;
            if (!fixtureStanding(mod, cell)) return false;
        }
        return true;
    }

    /**
     * Does the world agree with one fixture cell?
     *
     * Deliberately looser than {@link ToasterLayout#wantedBlock} in two places,
     * because the plan names ONE block and the game will hand her a different
     * one for perfectly good reasons: a bed is whatever colour she crafted, and
     * vanilla decides between a standing torch and a wall torch from where she
     * was stood when she clicked. Insisting on the literal block would leave a
     * stage permanently unsatisfied over a blue bed.
     */
    private boolean fixtureStanding(AltoClef mod, ToasterLayout.Cell cell) {
        BlockState state = mod.getWorld().getBlockState(cell.pos);
        switch (cell.glyph) {
            case ToasterLayout.SHELL:
                return settlement.isShellMaterial(state);
            case ToasterLayout.BED:
                return state.getBlock() instanceof net.minecraft.world.level.block.BedBlock;
            case ToasterLayout.TORCH:
            case ToasterLayout.WALL_TORCH:
                return state.getBlock() == Blocks.TORCH || state.getBlock() == Blocks.WALL_TORCH;
            default:
                Block wanted = ToasterLayout.wantedBlock(cell.glyph, settlement.material());
                return wanted != null && state.getBlock() == wanted;
        }
    }

    private static String stageName(ToasterTier.Stage stage) {
        return stage.name().toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * WHAT THE SHELL IS MADE OF, re-decided every survey.
     *
     * Normally nothing is named at all: any stone she can dig counts as shell,
     * which is what stops her tearing a sound cobblestone wall down to re-lay it
     * in smooth stone. Naming a block turns that off - every wall block that is
     * not the named one instantly reads as outstanding work - so it is only ever
     * done for a REAL upgrade, one rung above plain cobble, and
     * {@link ToasterTier#buildingMaterial} will only climb a rung while she is
     * holding a full stack of the better block. That stack is what keeps the
     * answer from flickering every time a furnace finishes, and it is also what
     * stops a renovation stranding her mid-wall.
     */
    private void refreshShellTarget(AltoClef mod) {
        if (!ToasterLayout.applies(settlement)) return;
        List<Block> ladder = ToasterTier.materialLadder();
        int[] carried = new int[ladder.size()];
        for (int rung = 0; rung < ladder.size(); rung++) {
            carried[rung] = mod.getItemStorage().getItemCount(ladder.get(rung).asItem());
        }
        Block chosen = ToasterTier.buildingMaterial(carried, established(mod));
        // rung 0 is cobblestone, i.e. "just build the house" - which is the
        // no-target case, not an upgrade to anything.
        settlement.setShellUpgradeTarget(ToasterTier.rungOf(chosen) >= 1 ? chosen : null);
    }

    /**
     * RICH IS NOT "HAS SOME IRON".
     *
     * The top rung is 1126 iron blocks - ten thousand ingots - so the question
     * is not whether a stack happened to land in her bag, it is whether she is
     * the kind of bot that finishes such a thing. The stack itself is already
     * demanded by buildingMaterial, so all this has to decide is the rest of it,
     * and diamond tooling is the cheapest honest proxy available from here: a
     * pickaxe and a chestplate mean she reached the bottom of a mine, kitted
     * herself out, and lived long enough to still be wearing it.
     */
    private boolean established(AltoClef mod) {
        return mod.getItemStorage().hasItem(Items.DIAMOND_PICKAXE)
            && mod.getItemStorage().hasItem(Items.DIAMOND_CHESTPLATE);
    }

    private Survey refreshSurvey(AltoClef mod, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && survey != null && now - surveyedAt < SURVEY_INTERVAL_MS) return survey;
        // keep whatever was last actually SEEN (null until she first gets there)
        // rather than overwriting it with a reading of chunks she does not have.
        if (!siteLoaded(mod)) return survey;
        // The yard keeps its own slow clock. A FORCED re-read of the house is not
        // a reason to pay for it again: handBuildStep forces one after every
        // single block it lands, and re-walking the yard's ~860 columns several
        // times a second is how a survey becomes the thing that drops frames.
        if (yardScannedAt == 0L || now - yardScannedAt >= YARD_SURVEY_INTERVAL_MS) {
            yard = YardScan.scan(mod, settlement);
            // the ring is ~310 columns to the yard's ~860 and it costs nothing when
            // the trench is switched off, so it shares the same slow clock.
            trench = TrenchScan.scan(mod, settlement);
            // a finished course opens the next one, and the reading has to be taken
            // again afterwards or the survey describes a trench she is no longer
            // allowed to stop digging.
            for (int course = 0; course < Settlement.TRENCH_DEPTH && advanceTrenchLayer(trench); course++) {
                trench = TrenchScan.scan(mod, settlement);
            }
            yardScannedAt = now;
        }
        // BOTH AXES ARE DECIDED BEFORE THE BLOCKS ARE READ, because both change
        // what the reading MEANS: the material target decides which wall blocks
        // count as correct, and the stage decides how many fixtures are even
        // being asked for.
        refreshShellTarget(mod);
        survey = Survey.scan(mod, settlement, yard, trench, handDeferred);
        // ...except the stage, which needs the shell tally to know whether the
        // silhouette is closed. So it is settled after the scan, and a scan that
        // turns out to have counted the wrong scope is simply taken again - a
        // stage moves a handful of times in a whole build.
        if (advanceStage(mod, survey)) survey = Survey.scan(mod, settlement, yard, trench, handDeferred);
        surveyedAt = now;
        publish(survey, isActive());
        return survey;
    }

    /**
     * A SURVEY THAT WAS NEVER TAKEN IS NOT A READING.
     *
     * refreshSurvey deliberately hands back the `survey` field - null until she
     * has actually stood in the site with its chunks loaded - so every stop
     * before she gets there (@stop, an F1 takeover, burnt's build watchdog, a
     * goal preempt mid-walk) reached onStop with null and threw inside task
     * teardown. Keeping the last real telemetry is the honest answer: nothing
     * new was seen, so nothing new is reported.
     */
    private void publish(Survey current, boolean active) {
        if (current == null) return;
        latestTelemetry = current.toJson(settlement, phase, active);
    }

    private static final class SettlementSchematic extends AbstractSchematic {
        private final Settlement settlement;
        private final BlockPos origin;

        SettlementSchematic(Settlement settlement, Scope scope) {
            super(settlement.width() + scopeMargin(scope) * 2,
                // the trench box is the only one taller than the house, because it
                // is the only one that reaches under the floor course.
                settlement.height() + (scope == Scope.TRENCH ? Settlement.TRENCH_DEPTH : 0),
                settlement.depth() + scopeMargin(scope) * 2);
            this.settlement = settlement;
            this.origin = scopeOrigin(settlement, scope);
        }

        @Override
        public BlockState desiredState(int x, int y, int z, BlockState current, List<BlockState> available) {
            BlockPos world = origin.offset(x, y, z);
            // `available` is Baritone's placeable-from-inventory estimate, so the
            // shell resolves to stone she is actually holding instead of naming
            // one recipe and then reporting it as missing.
            return settlement.desiredState(world, current, available);
        }
    }

    /**
     * The yard as it stands: how much of it still walls the house in, and the
     * nearest thing to swing at if Baritone refuses to do it.
     */
    private static final class YardScan {
        static final YardScan EMPTY = new YardScan(0, null);
        final int remaining;
        final BlockPos nearest;

        YardScan(int remaining, BlockPos nearest) {
            this.remaining = remaining;
            this.nearest = nearest;
        }

        /**
         * THE HEIGHTMAP DOES THE REJECTING.
         *
         * A homestead yard is 860 columns and, on the open ground she is
         * supposed to be settling on, every one of them is already empty air the
         * whole way up. Reading seven blocks per column to discover that is
         * ~6000 block reads per pass on the client thread, for an answer one
         * heightmap lookup already had. So each column is rejected in one lookup
         * unless its terrain genuinely reaches into the band beside the walls,
         * and only the part of it that does is walked.
         *
         * A column in an unloaded chunk reads as ground far below the floor and
         * is skipped. That is the safe direction: nothing is claimed to need
         * clearing that has not been seen, and she is standing in the middle of
         * the site whenever this runs, so ten blocks out is always loaded.
         */
        static YardScan scan(AltoClef mod, Settlement s) {
            BlockPos me = mod.getPlayer() != null ? mod.getPlayer().blockPosition() : s.origin();
            int remaining = 0;
            BlockPos nearest = null;
            double nearestDistance = Double.MAX_VALUE;
            BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
            for (int x = s.yardMinX(); x <= s.yardMaxX(); x++) {
                for (int z = s.yardMinZ(); z <= s.yardMaxZ(); z++) {
                    // the house's own footprint is not yard, and skipping it by
                    // column costs one comparison instead of seven
                    if (x >= s.minX() && x <= s.maxX() && z >= s.minZ() && z <= s.maxZ()) continue;
                    int surface = mod.getWorld().getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1;
                    int ceiling = Math.min(s.roofY(), surface);
                    for (int y = s.floorY() + 1; y <= ceiling; y++) {
                        cursor.set(x, y, z);
                        if (!s.isYardObstruction(mod.getWorld().getBlockState(cursor))) continue;
                        remaining++;
                        double distance = cursor.distSqr(me);
                        if (distance < nearestDistance) {
                            nearestDistance = distance;
                            nearest = cursor.immutable();
                        }
                    }
                }
            }
            return new YardScan(remaining, nearest);
        }
    }

    /**
     * The ring as it stands: how much of it is still solid, whether it is lit,
     * and whether the gate is hung.
     *
     * EVERY CELL IS JUDGED BY ASKING {@link Settlement#desiredState} - the same
     * function the schematic asks - instead of re-deriving here what a trench is
     * supposed to look like. A second description of the same geometry is the
     * mistake the floorplan taught us once already, and this is where it would
     * hurt most: the builder and the survey would disagree about which cells are
     * finished, so she would work on ground the tally already called done and the
     * job would never close.
     *
     * The heightmap only bounds the TOP of each column. Everything from the
     * column's floor up to grade is read unconditionally, because that is the
     * part that is supposed to be underground and a heightmap has nothing to say
     * about it.
     */
    private static final class TrenchScan {
        static final TrenchScan EMPTY = new TrenchScan(0, null, List.of(), 0, true);
        final int remaining;
        final BlockPos nearest;
        final List<BlockPos> missingLights;
        final int lightTotal;
        final boolean gateStanding;

        TrenchScan(int remaining, BlockPos nearest, List<BlockPos> missingLights,
                   int lightTotal, boolean gateStanding) {
            this.remaining = remaining;
            this.nearest = nearest;
            this.missingLights = missingLights;
            this.lightTotal = lightTotal;
            this.gateStanding = gateStanding;
        }

        int lightsCorrect() { return lightTotal - missingLights.size(); }
        boolean complete() { return remaining == 0 && missingLights.isEmpty() && gateStanding; }

        static TrenchScan scan(AltoClef mod, Settlement s) {
            if (!s.trenchEnabled()) return EMPTY;
            BlockPos me = mod.getPlayer() != null ? mod.getPlayer().blockPosition() : s.origin();
            int remaining = 0;
            BlockPos nearest = null;
            double nearestDistance = Double.MAX_VALUE;
            BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
            for (int x = s.trenchMinX(); x <= s.trenchMaxX(); x++) {
                for (int z = s.trenchMinZ(); z <= s.trenchMaxZ(); z++) {
                    cursor.set(x, s.floorY(), z);
                    // the yard and the house fill most of this box; one predicate
                    // rejects them by column rather than by cell
                    if (!s.inTrenchColumn(cursor)) continue;
                    int surface = mod.getWorld().getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1;
                    int top = Math.min(s.roofY(), Math.max(surface, s.floorY()));
                    for (int y = s.trenchGroundY(x, z); y <= top; y++) {
                        cursor.set(x, y, z);
                        BlockState state = mod.getWorld().getBlockState(cursor);
                        if (state.equals(s.desiredState(cursor, state))) continue;
                        remaining++;
                        double distance = cursor.distSqr(me);
                        if (distance < nearestDistance) {
                            nearestDistance = distance;
                            nearest = cursor.immutable();
                        }
                    }
                }
            }
            List<BlockPos> lights = s.trenchLightPositions();
            List<BlockPos> missing = new java.util.ArrayList<>();
            for (BlockPos spot : lights) {
                Block block = mod.getWorld().getBlockState(spot).getBlock();
                if (block != Blocks.TORCH && block != Blocks.WALL_TORCH) missing.add(spot);
            }
            boolean gate = mod.getWorld().getBlockState(s.causewayGate()).getBlock()
                instanceof net.minecraft.world.level.block.FenceGateBlock;
            return new TrenchScan(remaining, nearest, missing, lights.size(), gate);
        }
    }

    private static final class Survey {
        int floorTotal, floorCorrect;
        int wallTotal, wallCorrect;
        int roofTotal, roofCorrect;
        int slotTotal, slotCorrect;
        int entranceTotal, entranceCorrect;
        int interiorTotal, clearRemaining;
        int torchTotal, torchCorrect;
        /** How much of the ten-block yard still walls the house in, and where. */
        int yardRemaining;
        BlockPos yardNearest;
        /**
         * The ring. Copied in from {@link TrenchScan} the same way the yard is.
         *
         * {@code trenchWanted} is carried rather than re-derived because
         * {@link #percent()} has to tell "no trench asked for" from "a trench with
         * everything still to do" - without it a settlement that never wanted one
         * could never reach a hundred per cent.
         */
        boolean trenchWanted;
        int trenchRemaining;
        BlockPos trenchNearest;
        int trenchLightTotal, trenchLightCorrect;
        List<BlockPos> trenchMissingLights = List.of();
        boolean trenchGateStanding = true;
        /**
         * The nearest doorway or toast slot with something standing in it.
         *
         * Openings are meant to be air, so they are neither "missing shell" nor
         * "wrong interior" - which meant nothing in hand mode could ever want
         * one, and a shell that was finished except for a slot Baritone would not
         * cut had no way left to finish at all.
         */
        BlockPos firstBlockedOpening;
        /**
         * THE WORLD IS THE LEDGER.
         *
         * Host-side, an install is booked the moment the companion reports the
         * place finished - and a CANCELLED task reports finished too
         * (UserTaskChain.cancel runs the same onFinish path). So an F1 takeover
         * mid-place books an appliance that is not there, and the block is
         * retired from a fixed plan forever: a hole nothing will ever fill.
         * Publishing which slot is ACTUALLY empty lets that heal itself.
         */
        int applianceTotal, applianceCorrect;
        int nextApplianceIndex = -1;
        BlockPos nextAppliancePos;
        String nextApplianceKind;
        BlockPos firstMissingTorch;
        /**
         * Every unlit spot, in geometry order. One unplaceable position used to
         * be the only one she ever saw, so the whole lighting step head-butted it
         * forever while five perfectly good spots waited behind it.
         */
        final List<BlockPos> missingTorches = new ArrayList<>();
        /**
         * The same, for the ground torches out in the yard. Kept as its own tally
         * rather than folded into the wall torches because the two are placed
         * differently (a wall face versus the ground), happen at different points
         * in the build, and answer different questions on the readout - "is the
         * house lit" and "is the yard lit" are not one fact.
         */
        int perimeterTotal, perimeterCorrect;
        final List<BlockPos> missingPerimeter = new ArrayList<>();
        // The nearest thing she could fix WITHOUT Baritone, so a refusal from the
        // builder still has somewhere to go. Nearest, not first, because the walk
        // is most of the cost of doing it by hand.
        BlockPos firstWrongInterior;
        BlockPos firstMissingShell;
        // what the shell is ACTUALLY made of, so the readout names the stone she
        // used instead of the one the blueprint used to insist on.
        final java.util.Map<Block, Integer> shellBlocks = new java.util.HashMap<>();

        /**
         * When the blocks were actually LOOKED AT, not when this was last turned
         * into json. Burnt reads it as "how fresh is this reading" to decide
         * whether the world outranks her own install ledger, and a re-publish
         * without a re-scan would silently make a stale survey look new.
         */
        long scannedAt;

        /**
         * `deferred` is the set of positions the hands have already tried and
         * failed to lay. It suppresses them as CHOICES of next target only -
         * every count below is blind to it, so a block she cannot place still
         * reads as outstanding and the house is never reported finished on the
         * strength of having given up on part of it.
         */
        static Survey scan(AltoClef mod, Settlement settlement, YardScan yard, TrenchScan trench,
                           java.util.Set<BlockPos> deferred) {
            Survey out = new Survey();
            out.scannedAt = System.currentTimeMillis();
            out.yardRemaining = yard == null ? 0 : yard.remaining;
            out.yardNearest = yard == null ? null : yard.nearest;
            out.trenchWanted = settlement.trenchEnabled();
            if (trench != null) {
                out.trenchRemaining = trench.remaining;
                out.trenchNearest = trench.nearest;
                out.trenchLightTotal = trench.lightTotal;
                out.trenchLightCorrect = trench.lightsCorrect();
                out.trenchMissingLights = trench.missingLights;
                out.trenchGateStanding = trench.gateStanding;
            }
            BlockPos me = mod.getPlayer() != null ? mod.getPlayer().blockPosition() : settlement.origin();
            double nearestInterior = Double.MAX_VALUE;
            double nearestShell = Double.MAX_VALUE;
            double nearestOpening = Double.MAX_VALUE;
            for (int x = settlement.minX(); x <= settlement.maxX(); x++) {
                for (int y = settlement.floorY(); y <= settlement.roofY(); y++) {
                    for (int z = settlement.minZ(); z <= settlement.maxZ(); z++) {
                        BlockPos pos = new BlockPos(x, y, z);
                        BlockState state = mod.getWorld().getBlockState(pos);
                        if (settlement.isEntrance(pos) || settlement.isToastSlot(pos)) {
                            boolean open = state.getBlock() instanceof AirBlock;
                            if (settlement.isEntrance(pos)) {
                                out.entranceTotal++;
                                if (open) out.entranceCorrect++;
                            } else {
                                out.slotTotal++;
                                if (open) out.slotCorrect++;
                            }
                            double distance = pos.distSqr(me);
                            if (!open && distance < nearestOpening && !deferred.contains(pos)) {
                                nearestOpening = distance;
                                out.firstBlockedOpening = pos;
                            }
                        } else if (settlement.isFloor(pos)) {
                            out.floorTotal++;
                            if (settlement.isShellMaterial(state)) { out.floorCorrect++; out.noteShell(state); }
                        } else if (settlement.isRoof(pos)) {
                            out.roofTotal++;
                            if (settlement.isShellMaterial(state)) { out.roofCorrect++; out.noteShell(state); }
                        } else if (settlement.isWall(pos)) {
                            out.wallTotal++;
                            if (settlement.isShellMaterial(state)) { out.wallCorrect++; out.noteShell(state); }
                        } else if (settlement.isInterior(pos)) {
                            out.interiorTotal++;
                            if (!(state.getBlock() instanceof AirBlock) && !settlement.preserveInterior(state)) {
                                out.clearRemaining++;
                            }
                        }
                        // The nearest block she could fix with her own hands if
                        // Baritone will not. The doorway and the toast slots are
                        // deliberately excluded: they are meant to be open air, and
                        // a hand-placer that does not know that would brick up her
                        // own front door.
                        boolean air = state.getBlock() instanceof AirBlock;
                        double distance = pos.distSqr(me);
                        // Only the CHOICE of hand target skips deferred blocks -
                        // every total and every *Correct counter above is
                        // untouched, so a block she cannot reach still counts as
                        // outstanding and the house never reports itself finished
                        // on the strength of having given up.
                        boolean skip = deferred.contains(pos);
                        if (settlement.isInterior(pos)) {
                            if (!air && !settlement.preserveInterior(state) && distance < nearestInterior && !skip) {
                                nearestInterior = distance;
                                out.firstWrongInterior = pos;
                            }
                        } else if (air && distance < nearestShell && !skip
                                && !settlement.isEntrance(pos) && !settlement.isToastSlot(pos)
                                && (settlement.isFloor(pos) || settlement.isRoof(pos) || settlement.isWall(pos))) {
                            nearestShell = distance;
                            out.firstMissingShell = pos;
                        }
                    }
                }
            }
            List<adris.altoclef.tasks.construction.settlement.ToasterGeometry.Slot> slots = settlement.applianceSlots();
            out.applianceTotal = slots.size();
            for (int i = 0; i < slots.size(); i++) {
                var slot = slots.get(i);
                if (mod.getWorld().getBlockState(slot.pos).getBlock() == slot.block) {
                    out.applianceCorrect++;
                } else if (out.nextApplianceIndex < 0) {
                    out.nextApplianceIndex = i;
                    out.nextAppliancePos = slot.pos;
                    out.nextApplianceKind = slot.kind();
                }
            }
            List<BlockPos> torches = settlement.torchPositions();
            out.torchTotal = torches.size();
            for (BlockPos pos : torches) {
                BlockState state = mod.getWorld().getBlockState(pos);
                if (state.getBlock() == Blocks.WALL_TORCH || state.getBlock() == Blocks.TORCH) {
                    out.torchCorrect++;
                } else {
                    out.missingTorches.add(pos);
                    if (out.firstMissingTorch == null) out.firstMissingTorch = pos;
                }
            }
            for (BlockPos pos : settlement.perimeterLightPositions()) {
                out.perimeterTotal++;
                BlockState state = mod.getWorld().getBlockState(pos);
                // ANY torch counts as lit. She clicks the top of a block, so
                // vanilla gives her a standing TORCH - but a spot next to a wall
                // can come out as a WALL_TORCH, and it lights the ground just the
                // same. Insisting on the exact block would send her back to
                // re-place a torch that is already burning, forever.
                // the tally stays blind to every deferral, same as the rest of the
                // survey: a spot she has given up on still reads as outstanding, so
                // the yard is never reported lit on the strength of giving up.
                // Skipping one is a job for the target picker (see nextPerimeterTarget).
                if (state.getBlock() == Blocks.TORCH || state.getBlock() == Blocks.WALL_TORCH) {
                    out.perimeterCorrect++;
                } else {
                    out.missingPerimeter.add(pos);
                }
            }
            return out;
        }

        int shellRemaining() {
            return smoothStoneRemaining()
                + slotTotal - slotCorrect + entranceTotal - entranceCorrect;
        }

        int smoothStoneRemaining() {
            return floorTotal - floorCorrect + wallTotal - wallCorrect + roofTotal - roofCorrect;
        }

        /** Is the HOUSE done? The yard is a separate promise - see complete(). */
        boolean housed() {
            return shellRemaining() == 0 && clearRemaining == 0 && torchCorrect == torchTotal;
        }

        boolean complete() {
            return housed() && yardRemaining == 0 && perimeterCorrect == perimeterTotal
                && trenchDone();
        }

        /**
         * A trench nobody asked for is finished by definition.
         *
         * This is what keeps every homestead already standing out of a 1250-block
         * dig it never agreed to: {@code trenchWanted} is off unless the build was
         * dispatched with the flag, and then {@link #complete()} is exactly the
         * sentence it was before.
         */
        boolean trenchDone() {
            if (!trenchWanted) return true;
            return trenchRemaining == 0 && trenchLightCorrect == trenchLightTotal && trenchGateStanding;
        }

        /**
         * Every tally that a placed or broken block moves. Identical strings on
         * two scans mean the site is byte-for-byte unchanged, which is the only
         * honest definition of "the builder did nothing".
         */
        String progressKey() {
            return floorCorrect + "/" + wallCorrect + "/" + roofCorrect + "/" + slotCorrect
                + "/" + entranceCorrect + "/" + clearRemaining + "/" + torchCorrect
                // felling a yard IS the work during that phase, so it has to count
                // as progress here or the stall watchdog condemns a builder that is
                // visibly chopping down a wood.
                + "/" + applianceCorrect + "/" + yardRemaining + "/" + perimeterCorrect
                // digging the ring IS the work during that phase, for the same
                // reason felling the yard is - leave it out and the six-minute
                // stall budget condemns a builder that is visibly excavating.
                + "/" + trenchRemaining + "/" + trenchLightCorrect;
        }

        /**
         * How much of the site is DONE, as one number. A key that merely CHANGED
         * says the world moved; this says it moved forward. The break/re-place
         * livelock moves wallCorrect +-1 forever, which is a fresh key every
         * cycle - so every watchdog downstream of noteProgress read a bot
         * rebuilding the same hole as a bot making progress, and the escapes that
         * exist for exactly this (hand mode, BLOCKED_PHASE) could never fire.
         */
        int progressScore() {
            return floorCorrect + wallCorrect + roofCorrect + slotCorrect
                + entranceCorrect + torchCorrect + applianceCorrect + perimeterCorrect
                + trenchLightCorrect
                - clearRemaining - yardRemaining - trenchRemaining;
        }

        /** Short human-readable "what is left" for the stall warning. */
        String remainingSummary() {
            return "shell " + smoothStoneRemaining() + ", clear " + clearRemaining
                + ", torches " + (torchTotal - torchCorrect) + ", yard " + yardRemaining
                + ", yard lights " + (perimeterTotal - perimeterCorrect)
                + (trenchWanted
                    ? ", trench " + trenchRemaining
                        + ", trench lights " + (trenchLightTotal - trenchLightCorrect)
                        + (trenchGateStanding ? "" : ", no gate")
                    : "");
        }

        void noteShell(BlockState state) {
            shellBlocks.merge(state.getBlock(), 1, Integer::sum);
        }

        /** The stone most of the shell is made of; the preferred one until any exists. */
        String shellMaterialName(Settlement s) {
            Block dominant = null;
            int best = 0;
            for (java.util.Map.Entry<Block, Integer> entry : shellBlocks.entrySet()) {
                if (entry.getValue() > best) { best = entry.getValue(); dominant = entry.getKey(); }
            }
            Block named = dominant == null ? s.material() : dominant;
            try {
                return BuiltInRegistries.BLOCK.getKey(named).getPath();
            } catch (Throwable ignored) {
                return "stone";
            }
        }

        String nextShellPhase() {
            if (floorCorrect < floorTotal) return "building_floor";
            if (wallCorrect < wallTotal) return "building_walls";
            if (roofCorrect < roofTotal) return "building_roof_and_toast_slots";
            if (slotCorrect < slotTotal) return "cutting_two_toast_slots";
            if (entranceCorrect < entranceTotal) return "cutting_walkthrough";
            return "repairing_shell";
        }

        private static double ratio(int correct, int total) {
            return total <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, (double) correct / total));
        }

        int percent() {
            double clear = interiorTotal <= 0 ? 1.0 : 1.0 - (double) clearRemaining / interiorTotal;
            // The yard has no fixed total - open ground starts at zero to do and a
            // wood starts at thousands - so it cannot be a ratio like the rest.
            // It is scored as "how close to done does this look", which reaches
            // full marks the moment nothing is left and degrades gently otherwise.
            double yardScore = yardRemaining <= 0 ? 1.0 : Math.max(0.0, 1.0 - yardRemaining / 400.0);
            double weighted = ratio(floorCorrect, floorTotal) * 0.16
                + ratio(wallCorrect, wallTotal) * 0.19
                + ratio(roofCorrect, roofTotal) * 0.16
                + ratio(slotCorrect, slotTotal) * 0.09
                + ratio(entranceCorrect, entranceTotal) * 0.06
                + Math.max(0.0, clear) * 0.09
                + ratio(torchCorrect, torchTotal) * 0.09
                + yardScore * 0.09
                + ratio(perimeterCorrect, perimeterTotal) * 0.07;
            // THE TRENCH IS FOLDED IN, NOT ADDED TO THE TABLE. Reserving a slice of
            // the weights for it would cap every settlement that never wanted one
            // below a hundred; rescaling only when it is asked for leaves the nine
            // ratios above summing to 1.0 exactly as they did.
            if (trenchWanted) {
                double dug = trenchRemaining <= 0 ? 1.0
                    : Math.max(0.0, 1.0 - trenchRemaining / 1300.0);
                double trenchScore = dug * 0.80
                    + ratio(trenchLightCorrect, trenchLightTotal) * 0.15
                    + (trenchGateStanding ? 0.05 : 0.0);
                weighted = weighted * 0.90 + trenchScore * 0.10;
            }
            return complete() ? 100 : Math.min(99, Math.max(0, (int) Math.floor(weighted * 100.0)));
        }

        JsonObject toJson(Settlement s, String phase, boolean active) {
            JsonObject json = new JsonObject();
            json.addProperty("active", active);
            json.addProperty("kind", s.kind());
            json.addProperty("role", s.role());
            json.addProperty("name", s.name());
            json.addProperty("x", s.anchor().getX());
            json.addProperty("y", s.anchor().getY());
            json.addProperty("z", s.anchor().getZ());
            json.addProperty("width", s.width());
            json.addProperty("depth", s.depth());
            json.addProperty("height", s.height());
            json.addProperty("material", shellMaterialName(s));
            // HOW MUCH OF THE PLAN IS CURRENTLY BEING ASKED FOR. Every fixture
            // count below is scoped to it, so burnt's side reading "appliances
            // 3 of 3" needs to know it is looking at the lived-in stage and not
            // at a finished 355-slot toaster.
            json.addProperty("stage", s.stage().name().toLowerCase(java.util.Locale.ROOT));
            json.addProperty("phase", phase);
            json.addProperty("percent", percent());
            json.addProperty("complete", complete());
            json.addProperty("clear", clearRemaining == 0);
            json.addProperty("floor", floorCorrect == floorTotal);
            json.addProperty("walls", wallCorrect == wallTotal);
            json.addProperty("roof", roofCorrect == roofTotal);
            json.addProperty("toastSlots", slotCorrect == slotTotal && slotTotal > 0);
            json.addProperty("toastSlotCount", 2);
            json.addProperty("walkthrough", entranceCorrect == entranceTotal && entranceTotal > 0);
            json.addProperty("lit", torchCorrect == torchTotal && torchTotal > 0);
            json.addProperty("smoothStoneRemaining", Math.max(0, smoothStoneRemaining()));
            json.addProperty("clearRemaining", clearRemaining);
            // THE HOUSE AND THE YARD ARE REPORTED SEPARATELY ON PURPOSE. Burnt's
            // side gates the appliance gallery on the house being habitable; if a
            // yard she cannot finish could hold that back, one hillside would mean
            // a toaster that never gets a single furnace in it.
            json.addProperty("housed", housed());
            json.addProperty("yardClear", yardRemaining == 0);
            json.addProperty("yardRemaining", yardRemaining);
            json.addProperty("yardMargin", Settlement.YARD_MARGIN);
            // THE RING. `trench` is what burnt's side reads to know whether this
            // settlement is even supposed to have one - the counters below are all
            // zero either way, so without it "nothing left to dig" and "not digging"
            // are the same reading.
            json.addProperty("trench", trenchWanted);
            json.addProperty("trenchDone", trenchDone());
            json.addProperty("trenchRemaining", trenchRemaining);
            json.addProperty("trenchLights", trenchLightCorrect);
            json.addProperty("trenchLightsRequired", trenchLightTotal);
            json.addProperty("trenchLightsRemaining", trenchLightTotal - trenchLightCorrect);
            json.addProperty("trenchGate", trenchGateStanding);
            json.addProperty("trenchDepth", Settlement.TRENCH_DEPTH);
            json.addProperty("trenchWidth", Settlement.TRENCH_WIDTH);
            json.addProperty("torches", torchCorrect);
            json.addProperty("torchesRequired", torchTotal);
            // the yard lights are reported apart from the wall torches: "the house
            // is lit" and "nothing spawns outside it" are different promises and
            // burnt's side says different things about them.
            json.addProperty("yardLit", perimeterCorrect == perimeterTotal && perimeterTotal > 0);
            json.addProperty("yardLights", perimeterCorrect);
            json.addProperty("yardLightsRequired", perimeterTotal);
            json.addProperty("yardLightSpacing", Settlement.PERIMETER_LIGHT_SPACING);
            // the gallery as the WORLD has it, so a booked-but-absent appliance
            // cannot retire its block from the plan permanently
            json.addProperty("appliances", applianceCorrect);
            json.addProperty("appliancesRequired", applianceTotal);
            json.addProperty("nextApplianceIndex", nextApplianceIndex);
            if (nextAppliancePos != null) {
                json.addProperty("nextApplianceKind", nextApplianceKind);
                json.addProperty("nextApplianceX", nextAppliancePos.getX());
                json.addProperty("nextApplianceY", nextAppliancePos.getY());
                json.addProperty("nextApplianceZ", nextAppliancePos.getZ());
            }
            json.addProperty("updatedAt", scannedAt);
            return json;
        }
    }
}
