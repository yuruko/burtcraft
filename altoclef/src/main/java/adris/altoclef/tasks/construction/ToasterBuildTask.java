package adris.altoclef.tasks.construction;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasks.InteractWithBlockTask;
import adris.altoclef.tasks.construction.settlement.Settlement;
import adris.altoclef.tasks.movement.GetWithinRangeOfBlockTask;
import adris.altoclef.tasksystem.ITaskRequiresGrounded;
import adris.altoclef.tasksystem.Task;
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
    /** One stable string: burnt-side progress supervision hashes the phase. */
    private static final String BLOCKED_PHASE = "blocked_baritone_cannot_build";
    private static JsonObject latestTelemetry;

    private final Settlement settlement;
    private Survey survey;
    private long surveyedAt;
    /** Last yard reading, and when it was taken. Refreshed on its own slow clock. */
    private YardScan yard = YardScan.EMPTY;
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
    private boolean builderYardMode;
    private String phase = "surveying";
    private boolean behaviourPushed;
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
    /** The side light she is currently working on, and when she started on it. */
    private BlockPos torchTarget;
    private long torchTargetAt;
    /** When the current walk to the quarry started; 0 = not walking. */
    private long quarryWalkSince;
    /** Arrived at (or given up on) the quarry for THIS restock. See walkToQuarry. */
    private boolean quarryReached;
    /**
     * Side-light spots that have already had their turn and would not take a
     * torch. Deferred, never abandoned - once every remaining spot is in here
     * the set is emptied and the whole rotation comes round again.
     */
    private final java.util.Set<BlockPos> torchDeferred = new java.util.LinkedHashSet<>();
    /**
     * Blocks the hands tried and could not lay. See {@link #handBuildStep}: the
     * torches have had this since the day one of them turned out to be
     * unplaceable, and the shell needed it for exactly the same reason.
     */
    private final java.util.Set<BlockPos> handDeferred = new java.util.LinkedHashSet<>();

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
        // Only FINISHED shell is protected, so nothing the build legitimately
        // breaks is caught. A shell position holding the WRONG block still gets
        // cleared and re-laid, the interior still gets swept, and the entrance and
        // toast slots still get opened out - all three want something other than
        // what is standing there, so none of them satisfy isShellMaterial.
        mod.getBehaviour().avoidBlockBreaking(pos -> {
            // Geometry first: this runs on every break check in the world, and
            // six int comparisons reject all but the build site.
            if (!settlement.inOuterPrism(pos)) return false;
            if (!settlement.isFloor(pos) && !settlement.isRoof(pos) && !settlement.isWall(pos)) return false;
            if (settlement.isEntrance(pos) || settlement.isToastSlot(pos)) return false;
            // this predicate runs on BARITONE'S PATHING THREAD, which outlives the
            // world by a moment when the game is closing - and an unguarded
            // getWorld() there threw an NPE straight out of the path finder
            // (observed 2026-08-05 08:37:35 on shutdown). no world means no
            // opinion: protecting nothing is the safe answer while everything is
            // being torn down anyway.
            var world = mod.getWorld();
            if (world == null) return false;
            return settlement.isShellMaterial(world.getBlockState(pos));
        });
        surveyedAt = 0L;
        yard = YardScan.EMPTY;
        yardScannedAt = 0L;
        builderYardMode = false;
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
        torchTarget = null;
        torchTargetAt = 0L;
        quarryWalkSince = 0L;
        quarryReached = false;
        torchDeferred.clear();
        handDeferred.clear();
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
            // burnt-side supervision hashes it as progress, so flapping it here would
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
                    : (current.clearRemaining > 0 ? "clearing_interior" : "clearing_the_yard"))
                : BLOCKED_PHASE;
            setDebugState(working ? "" : "baritone will not build this site");
            publish(current, true);
            return null;
        }

        setDebugState("");
        BlockPos missingTorch = nextTorchTarget(current);
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
            // The torch points AWAY from its wall, so the wall is the neighbour
            // on the opposite side and the face to click is the one looking back
            // at the torch's own spot. True for the floorplan's inside lights and
            // for the fallback layout's outside ones alike.
            BlockPos wall = missingTorch.relative(facing.getOpposite());
            return new InteractWithBlockTask(Items.TORCH, facing, wall, false);
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
     * Hand Baritone the schematic for the job in front of her.
     *
     * The box is sized to the mode rather than always being the big one: while
     * the shell is going up she wants Baritone recalculating over ~1000
     * positions, not the ~7900 the yard box covers, and eight times the recalc
     * is eight times the pause every time it is kicked.
     */
    private void startBuilder(AltoClef mod, boolean withYard) {
        builderYardMode = withYard;
        mod.getClientBaritone().getBuilderProcess().build(
            settlement.kind() + "_" + settlement.name(),
            new SettlementSchematic(settlement, withYard),
            schematicOrigin(withYard));
    }

    private BlockPos schematicOrigin(boolean withYard) {
        return withYard
            ? new BlockPos(settlement.yardMinX(), settlement.floorY(), settlement.yardMinZ())
            : settlement.origin();
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
     * parks on one STABLE blocked string - stable because burnt-side progress
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
        boolean wantYard = current.shellRemaining() == 0 && current.clearRemaining == 0;
        if (builder.isActive() && wantYard != builderYardMode) {
            // Both directions: a creeper opening the wall pulls the schematic
            // back off the yard and onto the house, which is the right order.
            Debug.logMessage("toaster build: switching the schematic to the "
                + (wantYard ? "yard - the house is closed" : "house - it needs repairing again"));
            stopBuilder(mod);
            startBuilder(mod, wantYard);
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
        startBuilder(mod, wantYard);
        // The stall clock is deliberately NOT given back here. It stays tripped
        // until a real block lands, so BUILDER_STALL_RETRY_MS paces the kicks
        // directly: one restart, one window to place something, then the next.
        // Handing the clock back instead would stretch every window back out to
        // the full stall timeout and quadruple how long she stands there.
        return builderKicks < BUILDER_KICK_LIMIT;
    }

    /**
     * Which side light to work on now.
     *
     * The lighting step runs AFTER the builder is stopped, so none of the stall
     * machinery that watches the shell is watching here - a spot that will not
     * take a torch had nothing to move her off it, and the whole step sat on
     * "lighting_sides" indefinitely. A spot now gets TORCH_ATTEMPT_MS of her
     * attention and is then deferred so the next one gets a turn. Deferring is
     * not giving up: when every remaining spot has had a turn the set empties
     * and the rotation starts over, and the survey keeps telling the truth
     * either way - complete() still counts every torch, so a house that really
     * cannot be lit is never reported finished.
     */
    private BlockPos nextTorchTarget(Survey current) {
        if (current.missingTorches.isEmpty()) {
            torchTarget = null;
            torchTargetAt = 0L;
            torchDeferred.clear();
            return null;
        }
        long now = System.currentTimeMillis();
        if (torchTarget != null && !current.missingTorches.contains(torchTarget)) {
            // It got lit. Whatever was deferred deserves a fresh look.
            torchTarget = null;
            torchDeferred.clear();
        }
        if (torchTarget != null && now - torchTargetAt >= TORCH_ATTEMPT_MS) {
            torchDeferred.add(torchTarget);
            Debug.logMessage("side light at " + torchTarget.toShortString()
                + " will not take a torch, trying another spot");
            torchTarget = null;
        }
        if (torchTarget == null) {
            BlockPos pick = null;
            for (BlockPos pos : current.missingTorches) {
                if (!torchDeferred.contains(pos)) { pick = pos; break; }
            }
            if (pick == null) {
                // Every unlit spot has had its turn. Round again rather than
                // leaving the house half dark forever.
                torchDeferred.clear();
                pick = current.missingTorches.get(0);
            }
            torchTarget = pick;
            torchTargetAt = now;
        }
        return torchTarget;
    }

    /**
     * Ground truth for "is anything actually happening". The survey tally only
     * moves when a real block in the site changed, so it cannot be refreshed by
     * her shuffling on the spot - which is precisely how the burnt-side stall
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
            yardScannedAt = now;
        }
        survey = Survey.scan(mod, settlement, yard, handDeferred);
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

        SettlementSchematic(Settlement settlement, boolean withYard) {
            super(settlement.width() + (withYard ? Settlement.YARD_MARGIN * 2 : 0),
                settlement.height(),
                settlement.depth() + (withYard ? Settlement.YARD_MARGIN * 2 : 0));
            this.settlement = settlement;
            this.origin = withYard
                ? new BlockPos(settlement.yardMinX(), settlement.floorY(), settlement.yardMinZ())
                : settlement.origin();
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
         * Burnt-side, an install is booked the moment the companion reports the
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
        static Survey scan(AltoClef mod, Settlement settlement, YardScan yard, java.util.Set<BlockPos> deferred) {
            Survey out = new Survey();
            out.scannedAt = System.currentTimeMillis();
            out.yardRemaining = yard == null ? 0 : yard.remaining;
            out.yardNearest = yard == null ? null : yard.nearest;
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
            return housed() && yardRemaining == 0;
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
                + "/" + applianceCorrect + "/" + yardRemaining;
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
                + entranceCorrect + torchCorrect + applianceCorrect
                - clearRemaining - yardRemaining;
        }

        /** Short human-readable "what is left" for the stall warning. */
        String remainingSummary() {
            return "shell " + smoothStoneRemaining() + ", clear " + clearRemaining
                + ", torches " + (torchTotal - torchCorrect) + ", yard " + yardRemaining;
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
            double weighted = ratio(floorCorrect, floorTotal) * 0.17
                + ratio(wallCorrect, wallTotal) * 0.20
                + ratio(roofCorrect, roofTotal) * 0.17
                + ratio(slotCorrect, slotTotal) * 0.10
                + ratio(entranceCorrect, entranceTotal) * 0.07
                + Math.max(0.0, clear) * 0.10
                + ratio(torchCorrect, torchTotal) * 0.09
                + yardScore * 0.10;
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
            json.addProperty("torches", torchCorrect);
            json.addProperty("torchesRequired", torchTotal);
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
