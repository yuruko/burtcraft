package adris.altoclef.tasks.entity;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.tasks.speedrun.BeatMinecraft2Task;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.time.TimerGame;
import baritone.api.utils.Rotation;
import baritone.api.utils.input.Input;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.arrow.Arrow;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

import java.util.Arrays;
import java.util.List;

public class ShootArrowSimpleProjectileTask extends Task {

    private final Entity target;
    private boolean shooting = false;
    private boolean shot = false;

    private final TimerGame shotTimer = new TimerGame(1);

    public ShootArrowSimpleProjectileTask(Entity target) {
        this.target = target;
    }

    @Override
    protected void onStart(AltoClef mod) {
        shooting = false;
    }

    /**
     * gravity-corrected aim for a bow at the given charge. public because
     * {@link BowCombatTask} fights a whole engagement with it and a second copy of
     * ballistics is a second place for it to drift.
     */
    public static Rotation calculateThrowLook(AltoClef mod, Entity target) {
        // Velocity based on bow charge.
        float velocity = (mod.getPlayer().getTicksUsingItem() - mod.getPlayer().getUseItemRemainingTicks()) / 20f;
        velocity = (velocity * velocity + velocity * 2) / 3;
        if (velocity > 1) velocity = 1;

        // Find the position of the center
        Vec3 targetCenter = target.getBoundingBox().getCenter();

        double posX = targetCenter.x();
        double posY = targetCenter.y();
        double posZ = targetCenter.z();

        // Adjusting for hitbox heights
        posY -= 1.9f - target.getBbHeight();

        double relativeX = posX - mod.getPlayer().getX();
        double relativeY = posY - mod.getPlayer().getY();
        double relativeZ = posZ - mod.getPlayer().getZ();

        // Calculate the pitch
        double hDistance = Math.sqrt(relativeX * relativeX + relativeZ * relativeZ);
        double hDistanceSq = hDistance * hDistance;
        final float g = 0.006f;
        float velocitySq = velocity * velocity;
        float pitch = (float) -Math.toDegrees(Math.atan((velocitySq - Math.sqrt(velocitySq * velocitySq - g * (g * hDistanceSq + 2 * relativeY * velocitySq))) / (g * hDistance)));

        // Set player rotation
        if (Float.isNaN(pitch)) {
            return new Rotation(target.getYRot(), target.getXRot());
        } else {
            return new Rotation(Vec3dToYaw(mod, new Vec3(posX, posY, posZ)), pitch);
        }
    }

    private static float Vec3dToYaw(AltoClef mod, Vec3 vec) {
        return (mod.getPlayer().getYRot() +
                Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(vec.z() - mod.getPlayer().getZ(), vec.x() - mod.getPlayer().getX())) - 90f - mod.getPlayer().getYRot()));
    }

    @Override
    protected Task onTick(AltoClef mod) {
        setDebugState("Shooting projectile");
        List<Item> requiredArrows = Arrays.asList(Items.ARROW, Items.SPECTRAL_ARROW, Items.TIPPED_ARROW);

        if (!(mod.getItemStorage().hasItem(Items.BOW) &&
                requiredArrows.stream().anyMatch(mod.getItemStorage()::hasItem))) {
            Debug.logMessage("Missing items, stopping.");
            return null;
        }

        Rotation lookTarget = calculateThrowLook(mod, target);
        LookHelper.lookAt(mod, lookTarget);

        // check if we are holding a bow
        boolean charged = mod.getPlayer().getTicksUsingItem() > 20 && mod.getPlayer().getUseItem().getItem() == Items.BOW;

        mod.getSlotHandler().forceEquipItem(Items.BOW);

        if (LookHelper.isLookingAt(mod, lookTarget) && !shooting) {
            mod.getInputControls().hold(Input.CLICK_RIGHT);
            shooting = true;
            shotTimer.reset();
        }
        if (shooting && charged) {
            List<Arrow> arrows = mod.getEntityTracker().getTrackedEntities(Arrow.class);
            // If any of the arrows belong to us and are moving, do not shoot yet
            // Prevents from shooting multiple arrows to the same target
            for (Arrow arrow : arrows) {
                if (arrow.getOwner() == mod.getPlayer()) {
                    Vec3 velocity = arrow.getDeltaMovement();
                    Vec3 delta = target.position().subtract(arrow.position());
                    boolean isMovingTowardsTarget = velocity.dot(delta) > 0;
                    if (isMovingTowardsTarget) {
                        return null;
                    }
                }
            }

            if (BeatMinecraft2Task.getConfig().renderDistanceManipulation && Minecraft.getInstance().options.simulationDistance().get() < 32) {
                // For farther entities, the arrow may get stuck in the air, so we need to increase the simulation distance
                Minecraft.getInstance().options.simulationDistance().set(20);
            }
            mod.getInputControls().release(Input.CLICK_RIGHT); // Release the arrow
            shot = true;
        }
        return null;
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        mod.getInputControls().release(Input.CLICK_RIGHT);
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return shot;
    }

    /**
     * ⚠ this used to be a flat {@code return false}, which is a live landmine for any
     * caller inside a chain: {@code SingleTaskChain.setTask()} keeps the OLD task when
     * the replacement {@code isEqual}, so "never equal" means every tick mints a fresh
     * instance, tears the sub-task tree down and force-cancels baritone. That is the
     * exact shape of every freeze in MobDefenseChain's history. Harmless while the only
     * caller was Playground; not harmless now that ranged combat is real.
     */
    @Override
    protected boolean isEqual(Task other) {
        return other instanceof ShootArrowSimpleProjectileTask task && task.target == target;
    }

    @Override
    protected String toDebugString() {
        return "Shooting arrow at " + target.getType().getDescriptionId();
    }
}