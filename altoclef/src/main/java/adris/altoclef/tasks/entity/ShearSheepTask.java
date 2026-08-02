package adris.altoclef.tasks.entity;

import net.minecraft.world.phys.EntityHitResult;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.tasksystem.Task;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.animal.sheep.Sheep;
import net.minecraft.world.item.Items;
import net.minecraft.world.InteractionHand;

import java.util.Optional;

public class ShearSheepTask extends AbstractDoToEntityTask {

    public ShearSheepTask() {
        super(0, -1, -1);
    }

    @Override
    protected boolean isSubEqual(AbstractDoToEntityTask other) {
        return other instanceof ShearSheepTask;
    }

    @Override
    protected Task onEntityInteract(AltoClef mod, Entity entity) {
        if (!mod.getItemStorage().hasItem(Items.SHEARS)) {
            Debug.logWarning("Failed to shear sheep because you have no shears.");
            return null;
        }
        if (mod.getSlotHandler().forceEquipItem(Items.SHEARS)) {
            mod.getController().interact(mod.getPlayer(), entity, new EntityHitResult(entity, entity.getBoundingBox().getCenter()), InteractionHand.MAIN_HAND);
        }


        return null;
    }

    @Override
    protected Optional<Entity> getEntityTarget(AltoClef mod) {
        return mod.getEntityTracker().getClosestEntity(mod.getPlayer().position(),
                entity -> {
                    if (entity instanceof Sheep sheep) {
                        return sheep.readyForShearing() && !sheep.isSheared();
                    }
                    return false;
                }, Sheep.class
        );
    }

    @Override
    protected String toDebugString() {
        return "Shearing Sheep";
    }
}
