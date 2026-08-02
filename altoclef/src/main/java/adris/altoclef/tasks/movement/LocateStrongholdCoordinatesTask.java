package adris.altoclef.tasks.movement;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.Dimension;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.helpers.WorldHelper;
import adris.altoclef.util.time.TimerGame;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.item.Items;
import net.minecraft.world.InteractionHand;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;
import net.minecraft.core.Vec3i;

import java.util.List;
import java.util.Optional;

public class LocateStrongholdCoordinatesTask extends Task {

    private static final int EYE_RETHROW_DISTANCE = 10; // target distance to stronghold guess before rethrowing

    private static final int SECOND_EYE_THROW_DISTANCE = 30; // target distance between first throw and second throw

    private final int _targetEyes;
    private final int _minimumEyes;
    private final TimerGame _throwTimer = new TimerGame(5);
    private LocateStrongholdCoordinatesTask.EyeDirection _cachedEyeDirection = null;
    private LocateStrongholdCoordinatesTask.EyeDirection _cachedEyeDirection2 = null;
    private Entity _currentThrownEye = null;
    private Vec3i _strongholdEstimatePos = null;

    public LocateStrongholdCoordinatesTask(int targetEyes, int minimumEyes) {
        _targetEyes = targetEyes;
        _minimumEyes = minimumEyes;
    }

    public LocateStrongholdCoordinatesTask(int targetEyes) {
        this(targetEyes, 12);
    }


    @SuppressWarnings("UnnecessaryLocalVariable")
    static Vec3i calculateIntersection(Vec3 start1, Vec3 direction1, Vec3 start2, Vec3 direction2) {
        Vec3 s1 = start1;
        Vec3 s2 = start2;
        Vec3 d1 = direction1;
        Vec3 d2 = direction2;
        // Solved for s1 + d1 * t1 = s2 + d2 * t2
        double t2 = ((d1.z * s2.x) - (d1.z * s1.x) - (d1.x * s2.z) + (d1.x * s1.z)) / ((d1.x * d2.z) - (d1.z * d2.x));
        BlockPos blockPos = BlockPos.containing(start2.add(direction2.scale(t2)));
        return new Vec3i(blockPos.getX(), blockPos.getY(), blockPos.getZ());
    }

    @Override
    protected void onStart(AltoClef mod) {

    }

    public boolean isSearching() {
        return _cachedEyeDirection != null;
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (WorldHelper.getCurrentDimension() != Dimension.OVERWORLD) {
            setDebugState("Going to overworld");
            return new DefaultGoToDimensionTask(Dimension.OVERWORLD);
        }

        // Pick up eye if we need to/want to.
        if (mod.getItemStorage().getItemCount(Items.ENDER_EYE) < _minimumEyes && mod.getEntityTracker().itemDropped(Items.ENDER_EYE) &&
                !mod.getEntityTracker().entityFound(EyeOfEnder.class)) {
            setDebugState("Picking up dropped ender eye.");
            return new PickupDroppedItemTask(Items.ENDER_EYE, _targetEyes);
        }

        // Handle thrown eye
        if (mod.getEntityTracker().entityFound(EyeOfEnder.class)) {
            if (_currentThrownEye == null || !_currentThrownEye.isAlive()) {
                Debug.logMessage("New eye direction");
                List<EyeOfEnder> enderEyes = mod.getEntityTracker().getTrackedEntities(EyeOfEnder.class);
                if (!enderEyes.isEmpty()) {
                    for (EyeOfEnder enderEye : enderEyes) {
                        _currentThrownEye = enderEye;
                    }
                }
                if (_cachedEyeDirection2 != null) {
                    _cachedEyeDirection = null;
                    _cachedEyeDirection2 = null;
                } else if (_cachedEyeDirection == null) {
                    _cachedEyeDirection = new LocateStrongholdCoordinatesTask.EyeDirection(_currentThrownEye.position());
                } else {
                    _cachedEyeDirection2 = new LocateStrongholdCoordinatesTask.EyeDirection(_currentThrownEye.position());
                }
            }
            if (_cachedEyeDirection2 != null) {
                _cachedEyeDirection2.updateEyePos(_currentThrownEye.position());
            } else if (_cachedEyeDirection != null) {
                _cachedEyeDirection.updateEyePos(_currentThrownEye.position());
            }

            if (mod.getEntityTracker().getClosestEntity(EyeOfEnder.class).isPresent() &&
                    !mod.getClientBaritone().getPathingBehavior().isPathing()) {
                LookHelper.lookAt(mod,
                        mod.getEntityTracker().getClosestEntity(EyeOfEnder.class).get().getEyePosition());
            }

            setDebugState("Waiting for eye to travel.");
            return null;
        }

        // Calculate stronghold position
        if (_cachedEyeDirection2 != null && !mod.getEntityTracker().entityFound(EyeOfEnder.class) && _strongholdEstimatePos == null) {
            if (_cachedEyeDirection2.getAngle() >= _cachedEyeDirection.getAngle()) {
                Debug.logMessage("2nd eye thrown at wrong position, or points to different stronghold. Rethrowing");
                _cachedEyeDirection = _cachedEyeDirection2;
                _cachedEyeDirection2 = null;
            } else {
                Vec3 throwOrigin = _cachedEyeDirection.getOrigin();
                Vec3 throwOrigin2 = _cachedEyeDirection2.getOrigin();
                Vec3 throwDelta = _cachedEyeDirection.getDelta();
                Vec3 throwDelta2 = _cachedEyeDirection2.getDelta();


                _strongholdEstimatePos = calculateIntersection(throwOrigin, throwDelta, throwOrigin2, throwDelta2); // stronghold estimate
                Debug.logMessage("Stronghold is at " + (int) _strongholdEstimatePos.getX() + ", " + (int) _strongholdEstimatePos.getZ() + " (" + (int) mod.getPlayer().position().distanceTo(Vec3.atLowerCornerOf(_strongholdEstimatePos)) + " blocks away)");
            }
        }


        // Re-throw the eyes after reaching the estimation to get a more accurate estimate of where the stronghold is.
        if (_strongholdEstimatePos != null) {
            if (((mod.getPlayer().position().distanceTo(Vec3.atLowerCornerOf(_strongholdEstimatePos)) < EYE_RETHROW_DISTANCE) && WorldHelper.getCurrentDimension() == Dimension.OVERWORLD)) {
                _strongholdEstimatePos = null;
                _cachedEyeDirection = null;
                _cachedEyeDirection2 = null;
            }
        }


        // Throw the eye since we don't have any eye info.
        if (!mod.getEntityTracker().entityFound(EyeOfEnder.class) && _strongholdEstimatePos == null) {
            if (WorldHelper.getCurrentDimension() == Dimension.NETHER) {
                setDebugState("Going to overworld.");
                return new DefaultGoToDimensionTask(Dimension.OVERWORLD);
            }
            if (!mod.getItemStorage().hasItem(Items.ENDER_EYE)) {
                setDebugState("Collecting eye of ender.");
                return TaskCatalogue.getItemTask(Items.ENDER_EYE, 1);
            }

            // First get to a proper throwing height
            if (_cachedEyeDirection == null) {
                setDebugState("Throwing first eye.");
            } else {
                setDebugState("Throwing second eye.");
                double sqDist = mod.getPlayer().distanceToSqr(_cachedEyeDirection.getOrigin());
                // If first eye thrown, go perpendicular from eye direction until a good distance away
                if (sqDist < SECOND_EYE_THROW_DISTANCE * SECOND_EYE_THROW_DISTANCE && _cachedEyeDirection != null) {
                    return new GoInDirectionXZTask(_cachedEyeDirection.getOrigin(), _cachedEyeDirection.getDelta().yRot(Mth.PI / 2), 1);
                }
            }
            // Throw it
            if (mod.getSlotHandler().forceEquipItem(Items.ENDER_EYE)) {
                assert Minecraft.getInstance().gameMode != null;
                if (_throwTimer.elapsed()) {
                    if (LookHelper.tryAvoidingInteractable(mod)) {
                        Minecraft.getInstance().gameMode.useItem(mod.getPlayer(), InteractionHand.MAIN_HAND);
                        //Minecraft.getInstance().options.keyUse.setDown(true);
                        _throwTimer.reset();
                    }
                } else {
                    Minecraft.getInstance().gameMode.releaseUsingItem(mod.getPlayer());
                    //Minecraft.getInstance().options.keyUse.setDown(false);
                }
            } else {
                Debug.logWarning("Failed to equip eye of ender to throw.");
            }
            return null;
        } else if (_cachedEyeDirection != null && !_cachedEyeDirection.hasDelta() ||
                _cachedEyeDirection2 != null && !_cachedEyeDirection2.hasDelta()) {
            setDebugState("Waiting for thrown eye to appear...");
            return null;
        }
        return null;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
    }

    public Optional<BlockPos> getStrongholdCoordinates() {
        if (_strongholdEstimatePos == null) {
            return Optional.empty();
        }
        return Optional.of(new BlockPos(_strongholdEstimatePos));
    }

    @Override
    protected boolean isEqual(Task other) {
        return other instanceof LocateStrongholdCoordinatesTask;
    }

    @Override
    protected String toDebugString() {
        return "Locating stronghold coordinates";
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return _strongholdEstimatePos != null;
    }

    // Represents the direction we need to travel to get to the stronghold.
    private static class EyeDirection {
        private final Vec3 _start;
        private Vec3 _end;

        public EyeDirection(Vec3 startPos) {
            _start = startPos;
        }

        public void updateEyePos(Vec3 endPos) {
            _end = endPos;
        }

        public Vec3 getOrigin() {
            return _start;
        }

        public Vec3 getDelta() {
            if (_end == null) return Vec3.ZERO;
            return _end.subtract(_start);
        }

        public double getAngle() {
            if (_end == null) return 0;
            return Math.atan2(getDelta().x(), getDelta().z());
        }

        @SuppressWarnings("BooleanMethodIsAlwaysInverted")
        public boolean hasDelta() {
            return _end != null && getDelta().lengthSqr() > 0.00001;
        }
    }
}
