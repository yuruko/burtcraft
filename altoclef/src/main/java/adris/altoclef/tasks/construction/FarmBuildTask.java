package adris.altoclef.tasks.construction;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.external.ExternalControlServer;
import adris.altoclef.tasks.InteractWithBlockTask;
import adris.altoclef.tasks.movement.GetWithinRangeOfBlockTask;
import adris.altoclef.tasksystem.ITaskRequiresGrounded;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.ItemTarget;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * MAKES a wheat field, or GROWS one that is already there.
 *
 * Everything in this tree could only ever HARVEST - {@link
 * adris.altoclef.tasks.resources.CollectCropTask} breaks max-age crops and
 * altoclef replants behind itself - so a field she found was the only field she
 * would ever have. This is the other half: water, farmland, seeds. Because
 * altoclef replants, a field built once feeds her forever without ever coming
 * back here.
 *
 * THE GEOMETRY IS VANILLA'S, NOT AN INVENTION. Farmland is hydrated by
 * {@code FarmBlock.isNearWater}, which sweeps the box from {@code pos+(-4,0,-4)}
 * to {@code pos+(4,1,4)} for a water fluid - four blocks horizontally, at the
 * farmland's own level or one above it. So ONE source block in the middle of a
 * 9x9 square wets every cell of it, and that is exactly what {@code CREATE}
 * builds: a square of side {@code 2*radius+1}, one source at the centre, wheat
 * on everything else. Anything bigger simply needs more sources, and the survey
 * works out how many by asking the world rather than by counting.
 *
 * {@code EXPAND} does not assume the plot at all - it hunts for farmland
 * already in the ground near the centre, takes its bounding box, and grows that
 * by {@code radius}. This is the "make the village's wheat field bigger" case,
 * so it is the one that has to be polite: nothing a person placed is ever
 * broken (one truth for that, {@link ExternalControlServer#isPlacedByPeople},
 * the same call {@code Settlement.isYardObstruction} delegates to), and a cell
 * that already holds wheat AT ANY AGE is DONE rather than outstanding. That
 * last one is the {@code CollectCropTask.validCrop} trap wearing a different
 * hat: "there is a crop here" and "there is a crop here worth breaking" are
 * different questions, and answering the second when you meant the first is how
 * you end up tearing out somebody's field to re-till it.
 */
public final class FarmBuildTask extends Task implements ITaskRequiresGrounded {

    public enum Mode { CREATE, EXPAND }

    /** What she is doing to one particular block right now. */
    private enum Job {
        DIG_WELL("digging out the well"),
        POUR_WATER("pouring the water in"),
        CLEAR("clearing"),
        TILL("tilling"),
        PLANT("planting");

        final String label;

        Job(String label) {
            this.label = label;
        }
    }

    /**
     * Vanilla's hydration reach. Not a tuning knob - changing it makes her
     * build fields the game will not water.
     */
    private static final int HYDRATION_RANGE = 4;
    /** Biggest square {@code @farm create} will accept, per side-half. */
    private static final int MAX_RADIUS = 16;
    /** How far an EXPAND-derived plot may run from the centre she was given. */
    private static final int MAX_EXPAND_REACH = 32;
    /** How far out EXPAND looks for existing farmland, beyond the growth ring. */
    private static final int EXPAND_SCAN_MARGIN = 8;
    /** Vertical slack on that hunt: a field on a slope is still one field. */
    private static final int EXPAND_SCAN_HEIGHT = 2;
    /** How far below the given y to look for the ground she actually meant. */
    private static final int SOIL_PROBE_DEPTH = 3;
    private static final long SURVEY_INTERVAL_MS = 700L;
    /**
     * How long one cell may hold her hands before another cell gets a turn.
     * Long enough to walk across the plot and swing, short enough that a cell
     * she genuinely cannot reach does not own the whole build.
     */
    private static final long TARGET_ATTEMPT_MS = 20_000L;
    private static final int ARRIVE_RANGE = 12;
    /** Seeds fetched in one go, so she is not walking off after every row. */
    private static final int SEED_BATCH = 32;
    /** How many dry cells are weighed as a well site. See {@link #chooseWell}. */
    private static final int WELL_CANDIDATES_EXAMINED = 256;

    /**
     * Every hoe. Any of them tills, so she uses whatever is already in the bag
     * and only the tier she goes and MAKES is a decision (see {@link #HOE_TO_MAKE}).
     */
    private static final Item[] HOES = {
        Items.WOODEN_HOE, Items.STONE_HOE, Items.IRON_HOE,
        Items.GOLDEN_HOE, Items.DIAMOND_HOE, Items.NETHERITE_HOE
    };

    /**
     * STONE. A radius-4 plot is eighty tills and a wooden hoe carries
     * fifty-nine uses, so the cheap one snaps halfway down the field and the
     * ladder just walks her off to make another one. Cobblestone is the
     * cheapest material that outlasts the job.
     */
    private static final String HOE_TO_MAKE = "stone_hoe";

    /**
     * What a hoe turns into farmland. Vanilla's {@code HoeItem.TILLABLES}
     * minus rooted dirt, which becomes plain dirt rather than farmland.
     *
     * Coarse dirt is in here even though its first click only makes DIRT: the
     * ladder re-surveys after every change, so the second click follows on its
     * own without this having to know that it takes two.
     */
    private static final Set<Block> TILLABLE = Set.of(
        Blocks.GRASS_BLOCK, Blocks.DIRT, Blocks.DIRT_PATH, Blocks.COARSE_DIRT);

    private final BlockPos center;
    private final int radius;
    private final Mode mode;

    /** Worked out once, from the world. Null until she has actually seen the site. */
    private Plot plot;
    private boolean warnedNoSoil;
    private Survey survey;
    private long surveyedAt;
    /** The one block she has committed to, what she is doing to it, and until when. */
    private BlockPos target;
    private Job targetJob;
    private long targetUntil;
    /**
     * Cells that have had their turn and would not take the work.
     *
     * DEFERRED, NEVER WRITTEN OFF - and the counters are deliberately blind to
     * this set, so a field is never reported finished on the strength of giving
     * up on part of it. Once every outstanding cell is in here the set empties
     * and the whole rotation comes round again. Keyed by job as well as
     * position because TILL and PLANT happen at the SAME block: a cell that
     * could not be tilled must not be un-plantable later for that reason.
     */
    private final Set<Cell> deferred = new LinkedHashSet<>();
    private boolean behaviourPushed;
    private String phase = "surveying";

    public FarmBuildTask(BlockPos center, int radius, Mode mode) {
        if (center == null) throw new IllegalArgumentException("a farm needs a centre");
        if (mode == null) throw new IllegalArgumentException("a farm needs a mode");
        if (radius < 1 || radius > MAX_RADIUS) {
            throw new IllegalArgumentException("radius must be 1-" + MAX_RADIUS + ", got " + radius);
        }
        this.center = center;
        this.radius = radius;
        this.mode = mode;
    }

    @Override
    protected void onStart(AltoClef mod) {
        mod.getBehaviour().push();
        behaviourPushed = true;
        // the tools and the crop go in her pocket and stay there. a deposit run
        // or a craft that spends the seeds mid-build costs a walk each time.
        mod.getBehaviour().addProtectedItems(Items.WHEAT_SEEDS, Items.WATER_BUCKET, Items.BUCKET);
        mod.getBehaviour().addProtectedItems(HOES);
        // THE FIELD IS NOT A SEED PATCH. the planting step can fall through to
        // CollectWheatSeedsTask, which harvests any wheat it can find - and
        // once she has planted a row, the nearest wheat in the world is her
        // own. this also keeps her off the crops of the field she came here to
        // EXPAND. the frame is popped in onStop, so ordinary harvesting is
        // untouched the moment the build is over.
        mod.getBehaviour().avoidBlockBreaking(this::isFarmMaterial);
        plot = null;
        warnedNoSoil = false;
        survey = null;
        surveyedAt = 0L;
        target = null;
        targetJob = null;
        targetUntil = 0L;
        deferred.clear();
        phase = "surveying";
    }

    @Override
    protected Task onTick(AltoClef mod) {
        // 1. THE SITE IS OUT OF VIEW. an unloaded chunk hands back air for
        //    every block in it, so surveying from across the world reads as
        //    "nothing here is planted" - which for EXPAND would mean deriving
        //    the plot from a field the client cannot see. travelling is the
        //    only honest move. (same reasoning as ToasterBuildTask#siteLoaded.)
        //    `current == null` is only ever the FIRST time. After that the last
        //    reading is kept - overwriting it with a reading of chunks she has
        //    not got would publish a phantom 0% over a real field - so the load
        //    test has to be asked separately or a stale survey hides the fact
        //    she has wandered off the site.
        Survey current = refreshSurvey(mod, false);
        if (current == null || !siteLoaded(mod)) {
            phase = "traveling_to_site";
            setDebugState("the field is out of view, heading over");
            return new GetWithinRangeOfBlockTask(plot == null ? center : plot.center(), ARRIVE_RANGE);
        }

        // 8. DONE.
        if (current.complete()) {
            phase = "complete";
            setDebugState("");
            return null;
        }

        // THE COMMITTED CELL OWNS THE TICK. Re-deciding every survey is what
        // oscillates, not the decision: a fresh target cancels the subtask that
        // was mid-swing, so two equally good cells can trade the hands back and
        // forth forever without either being finished. (ToasterBuildTask
        // learned this one the expensive way; see its handBuildStep.)
        if (target != null) {
            Task keep = jobTask(mod, target, targetJob);
            if (keep != null && System.currentTimeMillis() < targetUntil) {
                setDebugState(targetJob.label + " " + target.toShortString());
                return keep;
            }
            if (keep != null) {
                // WHICH WAY DID THE LATCH END? Still having work to hand back
                // when the clock has run out means twenty seconds achieved
                // nothing, and re-picking is pointless - the chooser takes the
                // nearest outstanding cell, which is the one that just failed.
                // Put it down and take another.
                deferred.add(new Cell(target, targetJob));
                Debug.logMessage("farm: can't finish " + targetJob.label + " at "
                    + target.toShortString() + " - leaving it and taking another cell");
            } else {
                // SOMETHING LANDED, SO THE GEOMETRY CHANGED. A cell usually
                // refuses because of what is (or is not) next to it, and the
                // block that just changed is very often exactly that. Everything
                // deferred deserves another go.
                deferred.clear();
            }
            target = null;
            targetJob = null;
            // THE WORLD MOVED, SO THE SURVEY THAT NAMED IT IS NOW A LIE.
            // Handing back a finished cell for the rest of the survey interval
            // is not merely stale - the ladder would re-commit to it, find it
            // already done on the next tick, and spin.
            Survey fresh = refreshSurvey(mod, true);
            if (fresh != null) current = fresh;
            if (current.complete()) {
                phase = "complete";
                setDebugState("");
                return null;
            }
        }

        // 2. NO HOE. Only asked for while there is still ground to break -
        //    a field that is tilled and merely needs seed does not need one,
        //    and sending her to make a hoe she will not use is a walk for
        //    nothing.
        if (!current.toTill.isEmpty() && carriedHoe(mod) == null) {
            phase = "getting_a_hoe";
            setDebugState("no hoe, going to make one");
            return TaskCatalogue.getItemTask(HOE_TO_MAKE, 1);
        }

        // 3+4. WATER FIRST, ALWAYS. Farmland with nothing in reach dries back
        //      into dirt, so tilling a dry plot is work that undoes itself.
        //      An empty `dry` list IS the "there is already water here" case -
        //      natural or otherwise - so nothing below has to test for it.
        if (!current.dry.isEmpty()) {
            BlockPos well = chooseWell(mod, current);
            if (well != null) {
                // 3. the bucket, and the water to put in it. CollectWaterBucketTask
                //    already knows how to find a lake; there is no new pathfinding
                //    here on purpose.
                if (!mod.getItemStorage().hasItem(Items.WATER_BUCKET)) {
                    phase = "fetching_water";
                    setDebugState("no water, going to fill a bucket");
                    return TaskCatalogue.getItemTask(Items.WATER_BUCKET, 1);
                }
                // 4. dig the well one block down, then pour.
                BlockState at = mod.getWorld().getBlockState(well);
                Job job = (!at.isAir() && !isWater(at)) ? Job.DIG_WELL : Job.POUR_WATER;
                Task sink = commit(mod, well, job);
                if (sink != null) {
                    phase = job == Job.DIG_WELL ? "digging_the_well" : "pouring_the_water";
                    return sink;
                }
                // A WELL SHE CANNOT SINK MUST NOT OWN THE TICK. Returning the
                // null straight out would leave her standing in a field with
                // the phase reading "digging_the_well" and nothing happening -
                // the exact freeze this package keeps re-learning. Set the spot
                // aside and let the rest of the field carry on; the water step
                // comes round again on every survey.
                // said ONCE per spot, not per tick - this branch runs at 20Hz
                // while the field is dry, and a line a second buries the log
                // that is meant to explain the failure.
                if (deferred.add(new Cell(well, job))) {
                    Debug.logMessage("farm: can't sink a well at " + well.toShortString()
                        + " - carrying on and trying another spot");
                }
            }
        }

        // 5. CLEAR WHAT IS STANDING ON IT. A hoe only tills when the block
        //    above is air (vanilla's onlyIfAirAbove), so grass, a flower or a
        //    snow layer is not cosmetic here - it is the reason the till does
        //    nothing at all.
        BlockPos cover = choose(mod, current.toClear, Job.CLEAR);
        if (cover != null) {
            Task task = commit(mod, cover, Job.CLEAR);
            if (task != null) {
                phase = "clearing_the_plot";
                return task;
            }
            // The reading that named it is out of date - the world moved inside
            // the survey interval. Bin it so the next tick reads fresh instead
            // of re-picking the same finished cell for the rest of the window.
            surveyedAt = 0L;
        }

        // 6. TILL.
        BlockPos till = choose(mod, current.toTill, Job.TILL);
        if (till != null) {
            Task task = commit(mod, till, Job.TILL);
            if (task != null) {
                phase = "tilling";
                return task;
            }
            surveyedAt = 0L;
        }

        // 7. PLANT. Breaking the grass on the way in usually pays for this by
        //    itself, so the fetch is the fallback rather than the plan.
        BlockPos plant = choose(mod, current.toPlant, Job.PLANT);
        if (plant != null) {
            if (!mod.getItemStorage().hasItem(Items.WHEAT_SEEDS)) {
                phase = "getting_seeds";
                setDebugState("out of seeds");
                return TaskCatalogue.getItemTask("wheat_seeds",
                    Math.min(SEED_BATCH, Math.max(1, current.toPlant.size())));
            }
            Task task = commit(mod, plant, Job.PLANT);
            if (task != null) {
                phase = "planting";
                return task;
            }
            surveyedAt = 0L;
        }

        // Everything outstanding is deferred and the rotation has not come
        // round yet. Say so rather than standing there mute.
        phase = "waiting_out_deferrals";
        setDebugState("every cell left has just been tried; going round again");
        return null;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        if (behaviourPushed) {
            mod.getBehaviour().pop();
            behaviourPushed = false;
        }
    }

    /**
     * FROM A FRESH READ OF THE WORLD, never from a counter.
     *
     * A tally she incremented is a claim about what she THINKS she did, and
     * every freeze in this package has been a gap between that and the ground.
     * No survey at all means no evidence either way, and "no evidence" must
     * never read as "done".
     */
    @Override
    public boolean isFinished(AltoClef mod) {
        Survey current = refreshSurvey(mod, false);
        return current != null && current.complete();
    }

    @Override
    protected boolean isEqual(Task other) {
        if (!(other instanceof FarmBuildTask task)) return false;
        return task.center.equals(center) && task.radius == radius && task.mode == mode;
    }

    @Override
    protected String toDebugString() {
        String where = plot == null ? center.toShortString() : plot.center().toShortString();
        String size = plot == null ? ((2 * radius + 1) + "x" + (2 * radius + 1))
            : (plot.width() + "x" + plot.depth());
        int percent = survey == null ? 0 : survey.percent();
        return (mode == Mode.EXPAND ? "expanding" : "building") + " a " + size
            + " wheat field at " + where + " (" + percent + "%): " + phase;
    }

    // ---------------------------------------------------------------- choosing

    /** Latch one block as the job in hand, and start doing it. */
    private Task commit(AltoClef mod, BlockPos pos, Job job) {
        Task task = jobTask(mod, pos, job);
        if (task == null) return null;
        target = pos;
        targetJob = job;
        targetUntil = System.currentTimeMillis() + TARGET_ATTEMPT_MS;
        setDebugState(job.label + " " + pos.toShortString());
        return task;
    }

    /**
     * The task for a committed block, or null once the world already agrees
     * with it - which is how a commitment ends early instead of on the clock.
     *
     * Every branch re-reads the block. The survey behind the caller can be up
     * to {@link #SURVEY_INTERVAL_MS} old, and acting on a cell that has since
     * been filled is how a finished target gets handed back in a hot loop.
     */
    private Task jobTask(AltoClef mod, BlockPos pos, Job job) {
        BlockState state = mod.getWorld().getBlockState(pos);
        switch (job) {
            case DIG_WELL -> {
                if (state.isAir() || isWater(state)) return null;
                if (!mayBreak(state)) return null;
                return new DestroyBlockTask(pos);
            }
            case POUR_WATER -> {
                if (isWater(state)) return null;
                if (!state.isAir()) return null;   // it filled back in; dig again
                if (!mod.getItemStorage().hasItem(Items.WATER_BUCKET)) return null;
                // A BUCKET IS A RIGHT-CLICK ON THE FACE BELOW THE HOLE, exactly
                // as ToasterBuildTask lights a yard torch: click the top of the
                // block underneath and the fluid lands in the empty square above
                // it. Vanilla works out the rest.
                return new InteractWithBlockTask(new ItemTarget(Items.WATER_BUCKET, 1),
                    Direction.UP, pos.below(), false);
            }
            case CLEAR -> {
                // `pos` is the COVER block here - the thing standing on the
                // cell, one above the soil.
                if (state.isAir()) return null;
                if (!mayBreak(state)) return null;
                return new DestroyBlockTask(pos);
            }
            case TILL -> {
                if (state.is(Blocks.FARMLAND)) return null;
                if (!TILLABLE.contains(state.getBlock())) return null;
                // the hoe only bites when the square above is empty; something
                // has fallen back onto it, so this is the clearing step's
                // problem again, not ours.
                if (!mod.getWorld().getBlockState(pos.above()).isAir()) return null;
                Item hoe = carriedHoe(mod);
                if (hoe == null) return null;
                // ONE hoe, not the whole family: an ItemTarget of six items
                // that she does not hold sends InteractWithBlockTask into a
                // squashed fetch for all six.
                return new InteractWithBlockTask(new ItemTarget(hoe, 1), Direction.UP, pos, false);
            }
            case PLANT -> {
                // `pos` is the FARMLAND; the crop grows in the square above it.
                if (!state.is(Blocks.FARMLAND)) return null;
                BlockState above = mod.getWorld().getBlockState(pos.above());
                if (!above.isAir()) return null;   // planted, or blocked - either way not ours
                if (!mod.getItemStorage().hasItem(Items.WHEAT_SEEDS)) return null;
                // The same click CollectCropTask replants with.
                return new InteractWithBlockTask(new ItemTarget(Items.WHEAT_SEEDS, 1),
                    Direction.UP, pos, true);
            }
        }
        return null;
    }

    /**
     * The nearest outstanding block that has not just been tried.
     *
     * When every one of them is deferred the set is emptied and the rotation
     * starts over - deferring moves her along, it never abandons a cell. The
     * survey keeps telling the truth either way, because {@link Survey#complete}
     * counts the lists and knows nothing about this set.
     */
    private BlockPos choose(AltoClef mod, List<BlockPos> candidates, Job job) {
        if (candidates.isEmpty()) return null;
        BlockPos from = mod.getPlayer() == null ? center : mod.getPlayer().blockPosition();
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (BlockPos pos : candidates) {
            if (deferred.contains(new Cell(pos, job))) continue;
            double distance = pos.distSqr(from);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = pos;
            }
        }
        if (best == null) {
            // Every cell of this kind has had its turn. Round again rather
            // than leaving half a field forever.
            deferred.clear();
            best = candidates.get(0);
        }
        return best;
    }

    /**
     * Where the next water source goes.
     *
     * CREATE puts it in the middle, because a radius-4 square is exactly the
     * reach of one source and the middle is the only cell that covers all of
     * it. Anything larger - and every EXPAND - needs more than one, so the
     * fallback picks the dry cell that would wet the most of the other dry
     * ones. One source per pass, re-surveyed each time; it converges without
     * anybody having to compute how many a shape needs.
     */
    private BlockPos chooseWell(AltoClef mod, Survey current) {
        if (current.dry.isEmpty() || plot == null) return null;
        if (mode == Mode.CREATE) {
            BlockPos middle = plot.center();
            if (current.dry.contains(middle) && !isDeferredWell(middle)) return middle;
        }
        BlockPos best = null;
        int bestCover = -1;
        int examined = 0;
        for (BlockPos candidate : current.dry) {
            if (isDeferredWell(candidate)) continue;
            // BOUNDED. This is candidates x dry cells, and a radius-16 plot has
            // 1089 of each - a million comparisons on the client thread. The
            // best of a couple of hundred spread-out candidates is as good a
            // well as the best of all of them, and it costs a fraction.
            if (++examined > WELL_CANDIDATES_EXAMINED) break;
            int cover = 0;
            for (BlockPos other : current.dry) {
                if (Math.abs(other.getX() - candidate.getX()) > HYDRATION_RANGE) continue;
                if (Math.abs(other.getZ() - candidate.getZ()) > HYDRATION_RANGE) continue;
                cover++;
            }
            if (cover > bestCover) {
                bestCover = cover;
                best = candidate;
            }
        }
        if (best == null) {
            deferred.clear();
            best = current.dry.get(0);
        }
        return best;
    }

    /** A well is one cell doing two jobs, so it is only free if BOTH are. */
    private boolean isDeferredWell(BlockPos pos) {
        return deferred.contains(new Cell(pos, Job.DIG_WELL))
            || deferred.contains(new Cell(pos, Job.POUR_WATER));
    }

    private Item carriedHoe(AltoClef mod) {
        for (Item hoe : HOES) {
            if (mod.getItemStorage().getItemCount(hoe) > 0) return hoe;
        }
        return null;
    }

    // ---------------------------------------------------------------- surveying

    /**
     * Read the whole plot back out of the world.
     *
     * Null means she cannot see it - the plot has not been derived yet, or its
     * chunks are not loaded - which is a different answer from "there is
     * nothing left to do" and must never be confused with it.
     */
    private Survey refreshSurvey(AltoClef mod, boolean force) {
        if (mod.getWorld() == null) return survey;
        long now = System.currentTimeMillis();
        if (!force && survey != null && now - surveyedAt < SURVEY_INTERVAL_MS) return survey;
        if (plot == null) {
            // EXPAND READS THE GROUND TO DECIDE ITS OWN SHAPE, so it has to be
            // able to SEE the ground first: an unloaded chunk answers air, and
            // farmland missed that way is farmland the plot is derived without.
            // That is a permanently undersized field, decided once and never
            // revisited - so the hunt waits until the whole box is in view.
            if (!boxLoaded(mod, center.getX(), center.getZ(),
                mode == Mode.EXPAND ? radius + EXPAND_SCAN_MARGIN : radius, center.getY())) {
                return survey;
            }
            plot = derivePlot(mod);
            if (plot == null) return survey;
        }
        if (!siteLoaded(mod)) return survey;

        Survey scanned = new Survey();
        List<BlockPos> water = scanWater(mod);
        for (int x = plot.minX; x <= plot.maxX; x++) {
            for (int z = plot.minZ; z <= plot.maxZ; z++) {
                BlockPos cell = new BlockPos(x, plot.y, z);
                classify(mod, cell, water, scanned);
            }
        }
        survey = scanned;
        surveyedAt = now;
        if (!warnedNoSoil && scanned.cells > 0 && scanned.cells == scanned.excluded) {
            warnedNoSoil = true;
            // SAY IT OUT LOUD. Otherwise a field on bare stone reports itself
            // finished the instant it starts, having planted nothing, and that
            // looks identical to a field she actually built.
            mod.logWarning("farm: nothing at " + plot.center().toShortString()
                + " can become farmland (" + scanned.cells + " cells, all bare rock,"
                + " fluid, or somebody else's build) - there is no field to make here");
        }
        return survey;
    }

    /** Where one cell of the plot stands, and what it therefore still owes. */
    private void classify(AltoClef mod, BlockPos cell, List<BlockPos> water, Survey out) {
        out.cells++;
        BlockState ground = mod.getWorld().getBlockState(cell);
        BlockState cover = mod.getWorld().getBlockState(cell.above());

        // Water inside the plot is the irrigation, not a hole in the field.
        if (isWater(ground)) {
            out.water++;
            return;
        }
        // A CROP AT ANY AGE IS DONE. `CollectCropTask.validCrop` only ever
        // accepts max-age wheat, and reading that as "anything else is free to
        // break" is how a re-till eats a field that was three days from
        // harvest. Present is not the same question as harvestable.
        //
        // ⚠ THIS RUNS BEFORE THE EXCLUSION, not after. Farmland is in
        // `isPlacedByPeople`, so a growing crop on farmland used to be tallied
        // as `excluded` - somebody else's construction - rather than as her own
        // standing field.
        if (cover.getBlock() instanceof CropBlock) {
            out.planted++;
            return;
        }

        // ⚠ FARMLAND IS THE THING SHE JUST MADE, so it cannot also be the
        // evidence that somebody else was here.
        //
        // `isPlacedByPeople` lists FARMLAND, and rightly - the site survey must
        // never bulldoze a villager's field. But this exclusion ran BEFORE the
        // farmland test below, so `farmland` was false on every path that
        // reached it and `out.toPlant.add(cell)` at the bottom of this method
        // was UNREACHABLE. The task cleared the plot, sank the well, poured the
        // water, tilled all 81 cells - and planted nothing. Every tilled cell
        // came back as `excluded`, which empties all four work lists, so
        // `Survey.complete()` went true, `percent()` returned 100, the task
        // reported success and she announced a wheat field with no wheat in it.
        // Downstream, the `wheat_farm` upgrade then filed that plot in the food
        // ledger, so she walked back to a field that could never grow anything.
        //
        // The COVER is still somebody's business either way: a torch or a path
        // block standing on the soil means this cell is not plantable.
        boolean farmland = ground.is(Blocks.FARMLAND);
        if (ExternalControlServer.isPlacedByPeople(cover)
            || (!farmland && ExternalControlServer.isPlacedByPeople(ground))) {
            out.excluded++;
            return;
        }
        if (!farmland && !TILLABLE.contains(ground.getBlock())) {
            // Bare rock, sand, gravel, a pond, or simply the wrong height on a
            // slope. A hoe will never make farmland of it, so it is not part of
            // the field - counted as excluded so the percentage stays honest
            // instead of being unreachable.
            out.excluded++;
            return;
        }
        // Something standing on it that she is not allowed to remove. Tilling
        // needs air above the soil, so this cell can never be farmland either.
        if (!cover.isAir() && !mayBreak(cover)) {
            out.excluded++;
            return;
        }

        // FROM HERE THE CELL WILL BE FARMLAND, so it needs water - and only
        // from here. Asking for hydration above this line put cells that can
        // never hold a crop into `dry`, which is an outstanding job nothing in
        // the ladder could ever finish.
        //
        // Dry farmland reverts to dirt, so this is real outstanding work in its
        // own right and not merely a precondition of the tilling.
        if (!hydrated(water, cell)) out.dry.add(cell);

        if (!cover.isAir()) {
            out.toClear.add(cell.above());
            return;
        }
        if (!farmland) {
            out.toTill.add(cell);
            return;
        }
        out.toPlant.add(cell);
    }

    /**
     * Every water block in reach of the plot, read ONCE per survey.
     *
     * Asking "is there water within four of me" per cell would be the whole box
     * again per cell - about thirteen thousand block reads for a 9x9 plot, on
     * the render thread, several times a second. One sweep of the box the plot
     * could possibly be hydrated from is under six hundred, and the per-cell
     * test is then arithmetic against a list that normally holds one entry.
     */
    private List<BlockPos> scanWater(AltoClef mod) {
        List<BlockPos> found = new ArrayList<>();
        for (int x = plot.minX - HYDRATION_RANGE; x <= plot.maxX + HYDRATION_RANGE; x++) {
            for (int z = plot.minZ - HYDRATION_RANGE; z <= plot.maxZ + HYDRATION_RANGE; z++) {
                // vanilla's box is the farmland's own level and the one above it.
                for (int y = plot.y; y <= plot.y + 1; y++) {
                    BlockPos pos = new BlockPos(x, y, z);
                    if (isWater(mod.getWorld().getBlockState(pos))) found.add(pos);
                }
            }
        }
        return found;
    }

    /** Vanilla {@code FarmBlock.isNearWater}, spelled out against a scanned list. */
    private static boolean hydrated(List<BlockPos> water, BlockPos cell) {
        for (BlockPos pos : water) {
            if (Math.abs(pos.getX() - cell.getX()) > HYDRATION_RANGE) continue;
            if (Math.abs(pos.getZ() - cell.getZ()) > HYDRATION_RANGE) continue;
            if (pos.getY() == cell.getY() || pos.getY() == cell.getY() + 1) return true;
        }
        return false;
    }

    /**
     * Anything a person put down stays where it is, and so does anything
     * growing. Fluids are excluded because breaking a source does not remove
     * the water - it flows back into the hole and the swing never lands, which
     * is the same eternal swing {@code Settlement.isYardObstruction} refuses
     * for the same reason.
     */
    private static boolean mayBreak(BlockState state) {
        if (state == null || state.isAir()) return false;
        if (!state.getFluidState().isEmpty()) return false;
        if (state.getBlock() instanceof CropBlock) return false;
        return !ExternalControlServer.isPlacedByPeople(state);
    }

    /**
     * Water, including the waterlogged blocks that hydrate just as well.
     *
     * Lava is the only other fluid a field can sit beside, so ruling it out
     * makes everything else that carries a fluid water without needing the
     * fluid tag.
     */
    private static boolean isWater(BlockState state) {
        if (state == null) return false;
        if (state.is(Blocks.LAVA)) return false;
        if (state.is(Blocks.WATER)) return true;
        return !state.getFluidState().isEmpty();
    }

    /** Is this block part of the farm itself? Used to keep her off her own crop. */
    private boolean isFarmMaterial(BlockPos pos) {
        Plot p = plot;
        if (p == null) return false;
        var level = Minecraft.getInstance().level;
        if (level == null) return false;
        if (pos.getX() < p.minX || pos.getX() > p.maxX) return false;
        if (pos.getZ() < p.minZ || pos.getZ() > p.maxZ) return false;
        if (pos.getY() == p.y) {
            BlockState here = level.getBlockState(pos);
            return here.is(Blocks.FARMLAND) || isWater(here);
        }
        if (pos.getY() == p.y + 1) {
            return level.getBlockState(pos).getBlock() instanceof CropBlock
                && level.getBlockState(pos.below()).is(Blocks.FARMLAND);
        }
        return false;
    }

    // ---------------------------------------------------------------- geometry

    /**
     * The square, worked out ONCE from the world.
     *
     * CREATE is the square she was asked for. EXPAND is not assumed at all: it
     * finds the farmland already in the ground, takes its bounding box and
     * grows that, which is the difference between enlarging a village's field
     * and paving a new one over the top of it.
     */
    private Plot derivePlot(AltoClef mod) {
        int y = soilLevel(mod, center);
        if (mode == Mode.CREATE) {
            return new Plot(center.getX() - radius, center.getX() + radius,
                center.getZ() - radius, center.getZ() + radius, y);
        }
        int reach = radius + EXPAND_SCAN_MARGIN;
        int minX = Integer.MAX_VALUE, maxX = Integer.MIN_VALUE;
        int minZ = Integer.MAX_VALUE, maxZ = Integer.MIN_VALUE;
        int foundY = y;
        double nearest = Double.MAX_VALUE;
        int found = 0;
        for (int x = center.getX() - reach; x <= center.getX() + reach; x++) {
            for (int z = center.getZ() - reach; z <= center.getZ() + reach; z++) {
                for (int dy = -EXPAND_SCAN_HEIGHT; dy <= EXPAND_SCAN_HEIGHT; dy++) {
                    BlockPos pos = new BlockPos(x, center.getY() + dy, z);
                    if (!mod.getWorld().getBlockState(pos).is(Blocks.FARMLAND)) continue;
                    found++;
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                    minZ = Math.min(minZ, z);
                    maxZ = Math.max(maxZ, z);
                    double distance = pos.distSqr(center);
                    if (distance < nearest) {
                        nearest = distance;
                        // ONE LEVEL. A field is flat, and mixing two of them
                        // into one plot would have her tilling a wall. The
                        // nearest farmland decides which one she is growing.
                        foundY = pos.getY();
                    }
                }
            }
        }
        if (found == 0) {
            // Nothing to grow. Building the square she asked for is more use
            // than refusing, but it is a different job from the one she asked
            // for, so it is said out loud rather than done quietly.
            Debug.logMessage("farm: no farmland within " + reach + " of "
                + center.toShortString() + " to expand - making a new "
                + (2 * radius + 1) + "x" + (2 * radius + 1) + " field here instead");
            return new Plot(center.getX() - radius, center.getX() + radius,
                center.getZ() - radius, center.getZ() + radius, y);
        }
        Plot grown = new Plot(
            Math.max(minX - radius, center.getX() - MAX_EXPAND_REACH),
            Math.min(maxX + radius, center.getX() + MAX_EXPAND_REACH),
            Math.max(minZ - radius, center.getZ() - MAX_EXPAND_REACH),
            Math.min(maxZ + radius, center.getZ() + MAX_EXPAND_REACH),
            foundY);
        Debug.logMessage("farm: found " + found + " farmland blocks near "
            + center.toShortString() + "; growing that field to "
            + grown.width() + "x" + grown.depth() + " at y=" + grown.y);
        return grown;
    }

    /**
     * The ground she MEANT, not the air she is standing in.
     *
     * A player's block position is the square their feet occupy, which above a
     * grass block is the empty one above it. Naming the soil directly still
     * works - the probe finds it on the first step.
     */
    private int soilLevel(AltoClef mod, BlockPos from) {
        for (int dy = 0; dy >= -SOIL_PROBE_DEPTH; dy--) {
            BlockPos pos = from.offset(0, dy, 0);
            BlockState state = mod.getWorld().getBlockState(pos);
            if (state.isAir()) continue;
            if (!state.getFluidState().isEmpty()) continue;
            return pos.getY();
        }
        return from.getY() - 1;
    }

    /**
     * Every corner, because the plot straddles chunk boundaries and a survey of
     * unloaded chunks is not evidence - the client answers air for all of it.
     */
    private boolean siteLoaded(AltoClef mod) {
        if (plot == null) return false;
        return mod.getChunkTracker().isChunkLoaded(new BlockPos(plot.minX, plot.y, plot.minZ))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(plot.maxX, plot.y, plot.minZ))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(plot.minX, plot.y, plot.maxZ))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(plot.maxX, plot.y, plot.maxZ));
    }

    /** All four corners of a square, plus its middle. */
    private static boolean boxLoaded(AltoClef mod, int x, int z, int reach, int y) {
        return mod.getChunkTracker().isChunkLoaded(new BlockPos(x, y, z))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(x - reach, y, z - reach))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(x + reach, y, z - reach))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(x - reach, y, z + reach))
            && mod.getChunkTracker().isChunkLoaded(new BlockPos(x + reach, y, z + reach));
    }

    /** One deferred piece of work: the block AND what she was trying to do to it. */
    private record Cell(BlockPos pos, Job job) {
    }

    /** The flat square of ground this task owns. */
    private record Plot(int minX, int maxX, int minZ, int maxZ, int y) {
        int width() {
            return maxX - minX + 1;
        }

        int depth() {
            return maxZ - minZ + 1;
        }

        BlockPos center() {
            return new BlockPos((minX + maxX) / 2, y, (minZ + maxZ) / 2);
        }
    }

    /**
     * One reading of the plot. Everything here came out of the world this tick;
     * nothing is carried over, and the deferral set is deliberately invisible
     * to it so a cell she has given up on still counts as outstanding.
     */
    private static final class Survey {
        final List<BlockPos> toClear = new ArrayList<>();
        final List<BlockPos> toTill = new ArrayList<>();
        final List<BlockPos> toPlant = new ArrayList<>();
        final List<BlockPos> dry = new ArrayList<>();
        int cells;
        int planted;
        int water;
        int excluded;

        boolean complete() {
            return dry.isEmpty() && toClear.isEmpty() && toTill.isEmpty() && toPlant.isEmpty();
        }

        int percent() {
            int workable = cells - excluded;
            if (workable <= 0) return 100;
            return Math.min(100, (100 * (planted + water)) / workable);
        }
    }
}
