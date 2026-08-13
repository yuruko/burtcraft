package adris.altoclef.tasks.entity;

import adris.altoclef.AltoClef;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.slots.PlayerSlot;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import java.util.List;
import adris.altoclef.util.helpers.ItemVersionHelper;
import adris.altoclef.util.helpers.CombatGear;

/**
 * Attacks an entity, but the target entity must be specified.
 */
public abstract class AbstractKillEntityTask extends AbstractDoToEntityTask {
    private static final double OTHER_FORCE_FIELD_RANGE = 2;

    // Not the "striking" distance, but the "ok we're close enough, lower our guard for other mobs and focus on this one" range.
    private static final double CONSIDER_COMBAT_RANGE = 10;

    public AbstractKillEntityTask() {
        this(CONSIDER_COMBAT_RANGE, OTHER_FORCE_FIELD_RANGE);
    }

    public AbstractKillEntityTask(double combatGuardLowerRange, double combatGuardLowerFieldRadius) {
        super(combatGuardLowerRange, combatGuardLowerFieldRadius);
    }

    public AbstractKillEntityTask(double maintainDistance, double combatGuardLowerRange, double combatGuardLowerFieldRadius) {
        super(maintainDistance, combatGuardLowerRange, combatGuardLowerFieldRadius);
    }

    /**
     * ⚠ TWO BUGS, ONE LINE OF INTENT. The old body scanned only {@code isSword}, so an
     * axe - which out-damages the sword of the same material - was invisible and she went
     * into fights bare-handed while carrying one. And it reassigned {@code bestItem} on
     * every iteration, so the answer was never a maximum: it was "the LAST sword the
     * inventory happened to yield, compared against her hand". A wooden sword sorted after
     * a diamond one won.
     * <p>
     * {@link CombatGear#bestMeleeWeapon} is a real max over everything the game marks as a
     * weapon.
     */
    public static Item bestWeapon(AltoClef mod) {
        return CombatGear.bestMeleeWeapon(mod);
    }

    public static boolean equipWeapon(AltoClef mod) {
        Item bestWeapon = bestWeapon(mod);
        Item equipedWeapon = StorageHelper.getItemStackInSlot(PlayerSlot.getEquipSlot()).getItem();
        if (bestWeapon != null && bestWeapon != equipedWeapon) {
            mod.getSlotHandler().forceEquipItem(bestWeapon);
            return true;
        }
        return false;
    }

    @Override
    protected Task onEntityInteract(AltoClef mod, Entity entity) {
        // Equip weapon
        if (!equipWeapon(mod)) {
            float hitProg = mod.getPlayer().getAttackStrengthScale(0);
            if (hitProg >= 1) {
                if (mod.getPlayer().onGround() || mod.getPlayer().getDeltaMovement().y() < 0 || mod.getPlayer().isInWater()) {
                    LookHelper.lookAt(mod, entity.getEyePosition());
                    mod.getControllerExtras().attack(entity);
                }
            }
        }
        return null;
    }
}