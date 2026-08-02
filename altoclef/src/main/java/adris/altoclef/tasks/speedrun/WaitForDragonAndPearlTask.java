package adris.altoclef.tasks.speedrun;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.TaskCatalogue;
import adris.altoclef.tasks.entity.DoToClosestEntityTask;
import adris.altoclef.tasks.entity.KillEntitiesTask;
import adris.altoclef.tasks.movement.GetToBlockTask;
import adris.altoclef.tasks.movement.GetToXZTask;
import adris.altoclef.tasks.movement.GetToYTask;
import adris.altoclef.tasks.movement.ThrowEnderPearlSimpleProjectileTask;
import adris.altoclef.tasks.resources.GetBuildingMaterialsTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.helpers.WorldHelper;
import net.minecraft.world.entity.AreaEffectCloud;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.entity.monster.EnderMan;
import net.minecraft.world.entity.projectile.hurtingprojectile.DragonFireball;
import net.minecraft.world.item.Items;
import net.minecraft.core.BlockPos;

import java.util.Optional;
import java.util.function.Predicate;

// TODO:
// The 10 Portal pillars form a 43 block radius, but the angle offset/cycle is random.
// Have an internal "cycle" value or something to keep track of where that cycle is
// Detect that value by scrolling around the 43 block radius in search of obsidian and finding
// the "midpoint" between two spots of obsidian and anything else
// Then, when pillaring, make sure we move to one of those areas (so we can move further out without
// risking hitting an obsidian tower)
public class WaitForDragonAndPearlTask extends Task implements IDragonWaiter {

    // How far to travel away from the portal, in XZ
    private static final double XZ_RADIUS = 30;
    private static final double XZ_RADIUS_TOO_FAR = 38;
    // How high to pillar
    private static final int HEIGHT = 42; //Increase height because this too low

    private static final int CLOSE_ENOUGH_DISTANCE = 15;

    private final int Y_COORDINATE = 75;

    private static final double DRAGON_FIREBALL_TOO_CLOSE_RANGE = 40;
    private final Task _buildingMaterialsTask = new GetBuildingMaterialsTask(HEIGHT + 10);
    boolean inCenter;
    private Task _heightPillarTask;
    private Task _throwPearlTask;
    private BlockPos _targetToPearl;
    private boolean _dragonIsPerching;
    // To avoid dragons breath
    private Task _pillarUpFurther;

    private boolean _hasPillar = false;

    @Override
    public void setExitPortalTop(BlockPos top) {
        BlockPos actualTarget = top.below();
        if (!actualTarget.equals(_targetToPearl)) {
            _targetToPearl = actualTarget;
            _throwPearlTask = new ThrowEnderPearlSimpleProjectileTask(actualTarget);
        }
    }

    @Override
    public void setPerchState(boolean perching) {
        _dragonIsPerching = perching;
    }

    @Override
    protected void onStart(AltoClef mod) {
    }

    @Override
    protected Task onTick(AltoClef mod) {
        Optional<Entity> enderMen = mod.getEntityTracker().getClosestEntity(EnderMan.class);
        if (enderMen.isPresent() && (enderMen.get() instanceof EnderMan endermanEntity) &&
                endermanEntity.isAngry()) {
            setDebugState("Killing angry endermen");
            Predicate<Entity> angry = entity -> endermanEntity.isAngry();
            return new KillEntitiesTask(angry, enderMen.get().getClass());
        }
        if (_throwPearlTask != null && _throwPearlTask.isActive() && !_throwPearlTask.isFinished(mod)) {
            setDebugState("Throwing pearl!");
            return _throwPearlTask;
        }

        if (_pillarUpFurther != null && _pillarUpFurther.isActive() && !_pillarUpFurther.isFinished(mod) && (mod.getEntityTracker().getClosestEntity(AreaEffectCloud.class).isPresent())) {

            Optional<Entity> cloud = mod.getEntityTracker().getClosestEntity(AreaEffectCloud.class);

            if (cloud.isPresent() && cloud.get().closerThan(mod.getPlayer(), 4)) {
                setDebugState("PILLAR UP FURTHER to avoid dragon's breath");
                return _pillarUpFurther;
            }

            Optional<Entity> fireball = mod.getEntityTracker().getClosestEntity(DragonFireball.class);

            if (isFireballDangerous(mod, fireball)) {
                setDebugState("PILLAR UP FURTHER to avoid dragon's breath");
                return _pillarUpFurther;
            }
        }

        if (!mod.getItemStorage().hasItem(Items.ENDER_PEARL) && inCenter) {
            setDebugState("First get ender pearls.");
            return TaskCatalogue.getItemTask(Items.ENDER_PEARL, 1);
        }

        int minHeight = _targetToPearl.getY() + HEIGHT - 3;

        int deltaY = minHeight - mod.getPlayer().blockPosition().getY();
        if (StorageHelper.getBuildingMaterialCount(mod) < Math.min(deltaY - 10, HEIGHT - 5) || _buildingMaterialsTask.isActive() && !_buildingMaterialsTask.isFinished(mod)) {
            setDebugState("Collecting building materials...");
            return _buildingMaterialsTask;
        }

        // Our trigger to throw is that the dragon starts perching. We can be an arbitrary distance and we'll still do it lol
        if (_dragonIsPerching && LookHelper.cleanLineOfSight(mod.getPlayer(), _targetToPearl.above(), 300)) {
            Debug.logMessage("THROWING PEARL!!");
            return _throwPearlTask;
        }
        if (mod.getPlayer().blockPosition().getY() < minHeight) {
            if (mod.getEntityTracker().entityFound(entity ->
                    mod.getPlayer().position().closerThan(entity.position(), 4), AreaEffectCloud.class)) {
                if (mod.getEntityTracker().getClosestEntity(EnderDragon.class).isPresent() &&
                        !mod.getClientBaritone().getPathingBehavior().isPathing()) {
                    LookHelper.lookAt(mod, mod.getEntityTracker().getClosestEntity(EnderDragon.class).get().getEyePosition());
                }
                return null;
            }
            if (_heightPillarTask != null && _heightPillarTask.isActive() && !_heightPillarTask.isFinished(mod)) {
                setDebugState("Pillaring up!");
                inCenter = true;
                if (mod.getEntityTracker().entityFound(EndCrystal.class)) {
                    return new DoToClosestEntityTask(
                            (toDestroy) -> {
                                if (toDestroy.closerThan(mod.getPlayer(), 7)) {
                                    mod.getControllerExtras().attack(toDestroy);
                                }
                                if (mod.getPlayer().blockPosition().getY() < minHeight) {
                                    return _heightPillarTask;
                                } else {
                                    if (mod.getEntityTracker().getClosestEntity(EnderDragon.class).isPresent() &&
                                            !mod.getClientBaritone().getPathingBehavior().isPathing()) {
                                        LookHelper.lookAt(mod, mod.getEntityTracker().getClosestEntity(EnderDragon.class).get().getEyePosition());
                                    }
                                    return null;
                                }
                            },
                            EndCrystal.class
                    );
                }
                return _heightPillarTask;
            }
        } else {
            setDebugState("We're high enough.");
            // If a fireball is too close, run UP
            Optional<Entity> dragonFireball = mod.getEntityTracker().getClosestEntity(DragonFireball.class);
            if (dragonFireball.isPresent() && dragonFireball.get().closerThan(mod.getPlayer(), DRAGON_FIREBALL_TOO_CLOSE_RANGE) && LookHelper.cleanLineOfSight(mod.getPlayer(), dragonFireball.get().position(), DRAGON_FIREBALL_TOO_CLOSE_RANGE)) {
                _pillarUpFurther = new GetToYTask(mod.getPlayer().getBlockY() + 5);
                Debug.logMessage("HOLDUP");
                return _pillarUpFurther;
            }
            if (mod.getEntityTracker().entityFound(EndCrystal.class)) {
                return new DoToClosestEntityTask(
                        (toDestroy) -> {
                            if (toDestroy.closerThan(mod.getPlayer(), 7)) {
                                mod.getControllerExtras().attack(toDestroy);
                            }
                            if (mod.getPlayer().blockPosition().getY() < minHeight) {
                                return _heightPillarTask;
                            } else {
                                if (mod.getEntityTracker().getClosestEntity(EnderDragon.class).isPresent() &&
                                        !mod.getClientBaritone().getPathingBehavior().isPathing()) {
                                    LookHelper.lookAt(mod, mod.getEntityTracker().getClosestEntity(EnderDragon.class).get().getEyePosition());
                                }
                                return null;
                            }
                        },
                        EndCrystal.class
                );
            }
            if (mod.getEntityTracker().getClosestEntity(EnderDragon.class).isPresent() &&
                    !mod.getClientBaritone().getPathingBehavior().isPathing()) {
                LookHelper.lookAt(mod, mod.getEntityTracker().getClosestEntity(EnderDragon.class).get().getEyePosition());
            }
            return null;
        }
        if (!WorldHelper.inRangeXZ(mod.getPlayer(), _targetToPearl, XZ_RADIUS_TOO_FAR) && mod.getPlayer().position().y() < minHeight && !_hasPillar) {
            if (mod.getEntityTracker().entityFound(entity ->
                    mod.getPlayer().position().closerThan(entity.position(), 4), AreaEffectCloud.class)) {
                if (mod.getEntityTracker().getClosestEntity(EnderDragon.class).isPresent() &&
                        !mod.getClientBaritone().getPathingBehavior().isPathing()) {
                    LookHelper.lookAt(mod, mod.getEntityTracker().getClosestEntity(EnderDragon.class).get().getEyePosition());
                }
                return null;
            }
            setDebugState("Moving in (too far, might hit pillars)");
            return new GetToXZTask(0, 0);
        }
        // We're far enough, pillar up!
        if (!_hasPillar) {
            _hasPillar = true;
        }
        _heightPillarTask = new GetToBlockTask(new BlockPos(0, minHeight, Y_COORDINATE));
        return _heightPillarTask;
    }

    private boolean isFireballDangerous(AltoClef mod, Optional<Entity> fireball) {
        if (!fireball.isPresent())
            return false;

        boolean fireballTooClose = fireball.get().closerThan(mod.getPlayer(), DRAGON_FIREBALL_TOO_CLOSE_RANGE);
        boolean fireballInSight = LookHelper.cleanLineOfSight(mod.getPlayer(), fireball.get().position(), DRAGON_FIREBALL_TOO_CLOSE_RANGE);

        return fireballTooClose && fireballInSight;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {

    }

    @Override
    protected boolean isEqual(Task other) {
        return other instanceof WaitForDragonAndPearlTask;
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return _dragonIsPerching
                && ((_throwPearlTask == null || (_throwPearlTask.isActive() && _throwPearlTask.isFinished(mod)))
                || WorldHelper.inRangeXZ(mod.getPlayer(), _targetToPearl, CLOSE_ENOUGH_DISTANCE));
    }

    @Override
    protected String toDebugString() {
        return "Waiting for Dragon Perch + Pearling";
    }
}