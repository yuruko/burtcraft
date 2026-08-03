package adris.altoclef.tasks.movement;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.tasks.entity.KillEntitiesTask;
import adris.altoclef.tasks.speedrun.MarvionBeatMinecraftTask;
import adris.altoclef.tasksystem.ITaskRequiresGrounded;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.ItemHelper;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.helpers.WorldHelper;
import adris.altoclef.util.progresscheck.MovementProgressChecker;
import adris.altoclef.util.slots.Slot;
import adris.altoclef.util.time.TimerGame;
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
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Optional;

/**
 * Call this when the place you're currently at is bad for some reason and you just wanna get away.
 */
public class TimeoutWanderTask extends Task implements ITaskRequiresGrounded {
    private final MovementProgressChecker stuckCheck = new MovementProgressChecker();
    private final float _distanceToWander;
    private final MovementProgressChecker _progressChecker = new MovementProgressChecker();
    private final boolean _increaseRange;
    private final TimerGame _timer = new TimerGame(60);
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
    private Vec3 _origin;
    //private DistanceProgressChecker _distanceProgressChecker = new DistanceProgressChecker(10, 0.1f);
    private boolean _forceExplore;
    private Task _unstuckTask = null;
    private int _failCounter;
    private double _wanderDistanceExtension;

    public TimeoutWanderTask(float distanceToWander, boolean increaseRange) {
        _distanceToWander = distanceToWander;
        _increaseRange = increaseRange;
        _forceExplore = false;
    }

    public TimeoutWanderTask(float distanceToWander) {
        this(distanceToWander, false);
    }

    public TimeoutWanderTask() {
        this(Float.POSITIVE_INFINITY, false);
    }

    public TimeoutWanderTask(boolean forceExplore) {
        this();
        _forceExplore = forceExplore;
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

    public void resetWander() {
        _wanderDistanceExtension = 0;
    }

    // This happens all the time in mineshafts and swamps/jungles
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
        _timer.reset();
        mod.getClientBaritone().getPathingBehavior().forceCancel();
        _origin = mod.getPlayer().position();
        _progressChecker.reset();
        stuckCheck.reset();
        _failCounter = 0;
        ItemStack cursorStack = StorageHelper.getItemStackInCursorSlot();
        if (!cursorStack.isEmpty()) {
            Optional<Slot> moveTo = mod.getItemStorage().getSlotThatCanFitInPlayerInventory(cursorStack, false);
            moveTo.ifPresent(slot -> mod.getSlotHandler().clickSlot(slot, 0, ContainerInput.PICKUP));
            if (ItemHelper.canThrowAwayStack(mod, cursorStack)) {
                mod.getSlotHandler().clickSlot(Slot.UNDEFINED, 0, ContainerInput.PICKUP);
            }
            Optional<Slot> garbage = StorageHelper.getGarbageSlot(mod);
            // Try throwing away cursor slot if it's garbage
            garbage.ifPresent(slot -> mod.getSlotHandler().clickSlot(slot, 0, ContainerInput.PICKUP));
            mod.getSlotHandler().clickSlot(Slot.UNDEFINED, 0, ContainerInput.PICKUP);
        } else {
            StorageHelper.closeScreen();
        }
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (mod.getClientBaritone().getPathingBehavior().isPathing()) {
            _progressChecker.reset();
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
            if (mod.getClientBaritone().getPathingBehavior().isPathing()) {
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
        if (!_progressChecker.check(mod) || !stuckCheck.check(mod)) {
            List<Entity> closeEntities = mod.getEntityTracker().getCloseEntities();
            for (Entity CloseEntities : closeEntities) {
                if (CloseEntities instanceof Mob &&
                        CloseEntities.position().closerThan(mod.getPlayer().position(), 1)) {
                    setDebugState("Killing annoying entity.");
                    return new KillEntitiesTask(CloseEntities.getClass());
                }
            }
            BlockPos blockStuck = stuckInBlock(mod);
            if (blockStuck != null) {
                _failCounter++;
                _unstuckTask = getFenceUnstuckTask();
                return _unstuckTask;
            }
            stuckCheck.reset();
        }
        setDebugState("Exploring.");
        switch (WorldHelper.getCurrentDimension()) {
            case END -> {
                if (_timer.getDuration() >= 30) {
                    if (MarvionBeatMinecraftTask.getConfig().renderDistanceManipulation) {
                        Minecraft.getInstance().options.renderDistance().set(12);
                        Minecraft.getInstance().options.entityDistanceScaling().set(1.0);
                    }
                    _timer.reset();
                }
            }
            case OVERWORLD, NETHER -> {
                if (_timer.getDuration() >= 30) {
                    if (MarvionBeatMinecraftTask.getConfig().renderDistanceManipulation) {
                        Minecraft.getInstance().options.renderDistance().set(12);
                        Minecraft.getInstance().options.entityDistanceScaling().set(1.0);
                    }
                }
                if (_timer.elapsed()) {
                    if (MarvionBeatMinecraftTask.getConfig().renderDistanceManipulation) {
                        Minecraft.getInstance().options.renderDistance().set(16);
                        Minecraft.getInstance().options.entityDistanceScaling().set(5.0);
                    }
                    _timer.reset();
                }
            }
        }
        if (!mod.getClientBaritone().getExploreProcess().isActive()) {
            mod.getClientBaritone().getExploreProcess().explore((int) _origin.x(), (int) _origin.z());
        }
        if (!_progressChecker.check(mod)) {
            // ExploreProcess may remain "active" forever while producing no
            // path. Reset it so the next tick makes a fresh exploration request.
            mod.getClientBaritone().getExploreProcess().onLostControl();
            mod.getClientBaritone().getPathingBehavior().forceCancel();
            _origin = mod.getPlayer().position();
            _progressChecker.reset();
            if (!_forceExplore) {
                _failCounter++;
                Debug.logMessage("Failed exploring.");
            } else {
                _failCounter++;
                Debug.logMessage("Exploration produced no movement; restarting it.");
            }
        }
        return null;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        mod.getClientBaritone().getPathingBehavior().forceCancel();
        if (isFinished(mod)) {
            if (_increaseRange) {
                _wanderDistanceExtension += _distanceToWander;
                Debug.logMessage("Increased wander range");
            }
        }
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        // Why the heck did I add this in?
        //if (_origin == null) return true;

        // If we fail 10 times or more, we may as well try the previous task again.
        // Search tasks use infinite wander, so failure must be checked before
        // the infinite-distance shortcut or the counter is dead code.
        if (_failCounter > 10) {
            return true;
        }

        if (Float.isInfinite(_distanceToWander)) return false;

        if (mod.getPlayer() != null && mod.getPlayer().position() != null && (mod.getPlayer().onGround() ||
                mod.getPlayer().isInWater())) {
            double sqDist = mod.getPlayer().position().distanceToSqr(_origin);
            double toWander = _distanceToWander + _wanderDistanceExtension;
            return sqDist > toWander * toWander;
        } else {
            return false;
        }
    }

    @Override
    protected boolean isEqual(Task other) {
        if (other instanceof TimeoutWanderTask task) {
            if (Float.isInfinite(task._distanceToWander) || Float.isInfinite(_distanceToWander)) {
                return Float.isInfinite(task._distanceToWander) == Float.isInfinite(_distanceToWander);
            }
            return Math.abs(task._distanceToWander - _distanceToWander) < 0.5f;
        }
        return false;
    }

    @Override
    protected String toDebugString() {
        return "Wander for " + (_distanceToWander + _wanderDistanceExtension) + " blocks";
    }
}
