package adris.altoclef.tasks.movement;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.chains.MobDefenseChain;
import adris.altoclef.tasksystem.ITaskRequiresGrounded;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.WorldHelper;
import adris.altoclef.util.progresscheck.MovementProgressChecker;
import baritone.api.pathing.goals.Goal;
import baritone.api.utils.input.Input;
import net.minecraft.world.*;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.entity.*;
import net.minecraft.world.level.block.grower.*;
import net.minecraft.world.level.block.piston.*;
import net.minecraft.world.level.block.state.*;
import net.minecraft.world.level.block.state.properties.*;
import net.minecraft.world.level.material.*;
import net.minecraft.world.phys.shapes.*;
import net.minecraft.core.BlockPos;

/**
 * Turns a baritone goal into a task.
 */
public abstract class CustomBaritoneGoalTask extends Task implements ITaskRequiresGrounded {
    private final Task _wanderTask = new TimeoutWanderTask(5, true);
    private final MovementProgressChecker stuckCheck = new MovementProgressChecker();
    private final boolean _wander;
    protected MovementProgressChecker _checker = new MovementProgressChecker();
    protected Goal _cachedGoal = null;
    // how far she must actually travel before "baritone is pathing" is allowed to
    // vouch for her again. one lazy step is ~0.2 blocks, so this clears on real
    // walking and never on a statue being jostled by physics.
    private static final double PATHING_PROGRESS_EPSILON = 0.15;
    private double _lastPathingX = Double.NaN;
    private double _lastPathingY = Double.NaN;
    private double _lastPathingZ = Double.NaN;
    Block[] annoyingBlocks = new Block[]{
            Blocks.VINE,
            Blocks.NETHER_SPROUTS,
            Blocks.CAVE_VINES,
            Blocks.CAVE_VINES_PLANT,
            Blocks.TWISTING_VINES,
            Blocks.TWISTING_VINES_PLANT,
            Blocks.WEEPING_VINES_PLANT,
            Blocks.LADDER,
            Blocks.BIG_DRIPLEAF,
            Blocks.BIG_DRIPLEAF_STEM,
            Blocks.SMALL_DRIPLEAF,
            Blocks.TALL_GRASS,
            Blocks.GRASS_BLOCK,
            Blocks.SWEET_BERRY_BUSH
    };
    private Task _unstuckTask = null;

    // This happens all the time in mineshafts and swamps/jungles

    public CustomBaritoneGoalTask(boolean wander) {
        _wander = wander;
    }

    public CustomBaritoneGoalTask() {
        this(true);
    }

    private static BlockPos[] generateSides(BlockPos pos) {
        return new BlockPos[]{
                pos.offset(1, 0, 0),
                pos.offset(-1, 0, 0),
                pos.offset(0, 0, 1),
                pos.offset(0, 0, -1),
                pos.offset(1, 0, -1),
                pos.offset(1, 0, 1),
                pos.offset(-1, 0, -1),
                pos.offset(-1, 0, 1)
        };
    }

    private boolean isAnnoying(AltoClef mod, BlockPos pos) {
        for (Block AnnoyingBlocks : annoyingBlocks) {
            return mod.getWorld().getBlockState(pos).getBlock() == AnnoyingBlocks ||
                    mod.getWorld().getBlockState(pos).getBlock() instanceof DoorBlock ||
                    mod.getWorld().getBlockState(pos).getBlock() instanceof FenceBlock ||
                    mod.getWorld().getBlockState(pos).getBlock() instanceof FenceGateBlock ||
                    mod.getWorld().getBlockState(pos).getBlock() instanceof FlowerBlock;
        }
        return false;
    }

    private BlockPos stuckInBlock(AltoClef mod) {
        BlockPos p = mod.getPlayer().blockPosition();
        if (isAnnoying(mod, p)) return p;
        if (isAnnoying(mod, p.above())) return p.above();
        BlockPos[] toCheck = generateSides(p);
        for (BlockPos check : toCheck) {
            if (isAnnoying(mod, check)) {
                return check;
            }
        }
        BlockPos[] toCheckHigh = generateSides(p.above());
        for (BlockPos check : toCheckHigh) {
            if (isAnnoying(mod, check)) {
                return check;
            }
        }
        return null;
    }

    private Task getFenceUnstuckTask() {
        return new SafeRandomShimmyTask();
    }

    @Override
    protected void onStart(AltoClef mod) {
        mod.getClientBaritone().getPathingBehavior().forceCancel();
        _checker.reset();
        stuckCheck.reset();
        _lastPathingX = Double.NaN;
        _lastPathingY = Double.NaN;
        _lastPathingZ = Double.NaN;
    }

    // `isPathing()` is "a path object exists", NOT "she is moving", and during a
    // failed-calculation retry loop it is true the whole time: baritone fails the
    // calc, CustomGoalProcess drops itself (onLostControl), the bottom of this tick
    // re-issues setGoalAndPath on the very next tick, and round it goes - forever,
    // while she stands perfectly still. resetting the progress checker on that
    // signal disarmed the ONLY escape an unreachable goal has (the 6s no-movement
    // check below), so she stayed a statue with the debug state parked on
    // "Completing goal." and NOTHING in the log to show for it - measured at 91s to
    // 359s across the game logs, escaping only when a mob happened to interrupt her.
    // this is the same shape as the craft-oscillation bug: a liveness signal that
    // the wedge itself keeps perturbing. so pathing may only vouch for her while it
    // is actually carrying her somewhere - the reset now costs real displacement.
    private boolean pathingIsActuallyMovingHer(AltoClef mod) {
        double x = mod.getPlayer().getX();
        double y = mod.getPlayer().getY();
        double z = mod.getPlayer().getZ();
        if (Double.isNaN(_lastPathingX)) {
            _lastPathingX = x;
            _lastPathingY = y;
            _lastPathingZ = z;
            return true;
        }
        double dx = x - _lastPathingX;
        double dy = y - _lastPathingY;
        double dz = z - _lastPathingZ;
        if (dx * dx + dy * dy + dz * dz < PATHING_PROGRESS_EPSILON * PATHING_PROGRESS_EPSILON) {
            // deliberately does NOT re-anchor: the anchor has to stay put across the
            // whole retry loop or every dropped path would re-arm the benefit of the
            // doubt and the checker would never age.
            return false;
        }
        _lastPathingX = x;
        _lastPathingY = y;
        _lastPathingZ = z;
        return true;
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (mod.getClientBaritone().getPathingBehavior().isPathing() && pathingIsActuallyMovingHer(mod)) {
            _checker.reset();
        }
        if (WorldHelper.isInNetherPortal(mod)) {
            if (!mod.getClientBaritone().getPathingBehavior().isPathing()) {
                setDebugState("Getting out from nether portal");
                mod.getInputControls().hold(Input.SNEAK);
                mod.getInputControls().hold(Input.MOVE_FORWARD);
                return null;
            } else {
                mod.getInputControls().release(Input.SNEAK);
                mod.getInputControls().release(Input.MOVE_BACK);
                mod.getInputControls().release(Input.MOVE_FORWARD);
            }
        } else {
            // ...unless the anti-freeze watchdog is driving. it only takes the keys when
            // she has not actually moved for FROZEN_SECONDS with something hostile on
            // her, and "baritone is pathing" is exactly the state it stops trusting -
            // a path that keeps getting recalculated reports isPathing() forever while
            // she stands still. releasing here would undo the rescue one tick after it
            // started, which is how she stood still for 47 seconds and died on 2026-08-04.
            if (mod.getClientBaritone().getPathingBehavior().isPathing()
                    && !MobDefenseChain.isPanicDriving()) {
                mod.getInputControls().release(Input.SNEAK);
                mod.getInputControls().release(Input.MOVE_BACK);
                mod.getInputControls().release(Input.MOVE_FORWARD);
            }
        }
        if (_unstuckTask != null && _unstuckTask.isActive() && !_unstuckTask.isFinished(mod) && stuckInBlock(mod) != null) {
            setDebugState("Getting unstuck from block.");
            stuckCheck.reset();
            // Stop other tasks, we are JUST shimmying
            mod.getClientBaritone().getCustomGoalProcess().onLostControl();
            mod.getClientBaritone().getExploreProcess().onLostControl();
            return _unstuckTask;
        }
        if (!_checker.check(mod) || !stuckCheck.check(mod)) {
            BlockPos blockStuck = stuckInBlock(mod);
            if (blockStuck != null) {
                _unstuckTask = getFenceUnstuckTask();
                return _unstuckTask;
            }
            stuckCheck.reset();
        }
        if (_cachedGoal == null) {
            _cachedGoal = newGoal(mod);
        }

        if (_wander) {
            if (isFinished(mod)) {
                // Don't wander if we've reached our goal.
                _checker.reset();
            } else {
                if (_wanderTask.isActive() && !_wanderTask.isFinished(mod)) {
                    setDebugState("Wandering...");
                    _checker.reset();
                    return _wanderTask;
                }
                if (!_checker.check(mod)) {
                    Debug.logMessage("Failed to make progress on goal, wandering.");
                    onWander(mod);
                    return _wanderTask;
                }
            }
        }
        if (!mod.getClientBaritone().getCustomGoalProcess().isActive()
                && mod.getClientBaritone().getPathingBehavior().isSafeToCancel()) {
            mod.getClientBaritone().getCustomGoalProcess().setGoalAndPath(_cachedGoal);
        }
        setDebugState("Completing goal.");
        return null;
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        if (_cachedGoal == null) {
            _cachedGoal = newGoal(mod);
        }
        return _cachedGoal != null && _cachedGoal.isInGoal(mod.getPlayer().blockPosition());
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        mod.getClientBaritone().getPathingBehavior().forceCancel();
    }

    protected abstract Goal newGoal(AltoClef mod);

    protected void onWander(AltoClef mod) {
    }
}
