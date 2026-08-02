package adris.altoclef.control;

import adris.altoclef.AltoClef;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.helpers.StlHelper;
import adris.altoclef.util.helpers.StorageHelper;
import adris.altoclef.util.slots.PlayerSlot;
import adris.altoclef.util.slots.Slot;
import adris.altoclef.util.time.TimerGame;
import baritone.api.utils.input.Input;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.wither.WitherBoss;
import net.minecraft.world.entity.*;
import net.minecraft.world.entity.ai.sensing.*;
import net.minecraft.world.entity.ambient.*;
import net.minecraft.world.entity.monster.*;
import net.minecraft.world.entity.monster.breeze.*;
import net.minecraft.world.entity.monster.hoglin.*;
import net.minecraft.world.entity.monster.piglin.*;
import net.minecraft.world.entity.monster.warden.*;
import net.minecraft.world.entity.projectile.*;
import net.minecraft.world.entity.projectile.hurtingprojectile.LargeFireball;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.inventory.ContainerInput;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import net.minecraft.world.entity.monster.skeleton.Skeleton;
import net.minecraft.world.entity.monster.illager.Pillager;
import net.minecraft.world.entity.monster.skeleton.Stray;
import net.minecraft.core.component.DataComponents;
import adris.altoclef.util.helpers.ItemVersionHelper;
import net.minecraft.world.entity.projectile.throwableitemprojectile.AbstractThrownPotion;

/**
 * Controls and applies killaura
 */
public class KillAura {
    // Smart aura data
    private final List<Entity> _targets = new ArrayList<>();
    private final TimerGame _hitDelay = new TimerGame(0.2);
    boolean _shielding = false;
    private double _forceFieldRange = Double.POSITIVE_INFINITY;
    private Entity _forceHit = null;

    public static void equipWeapon(AltoClef mod) {
        List<ItemStack> invStacks = mod.getItemStorage().getItemStacksPlayerInventory(true);
        if (!invStacks.isEmpty()) {
            float handDamage = Float.NEGATIVE_INFINITY;
            for (ItemStack invStack : invStacks) {
                Item item = invStack.getItem();
                if (ItemVersionHelper.isSword(item)) {
                    float itemDamage = ItemVersionHelper.getAttackDamage(item);
                    Item handItem = StorageHelper.getItemStackInSlot(PlayerSlot.getEquipSlot()).getItem();
                    if (ItemVersionHelper.isSword(handItem)) {
                        handDamage = ItemVersionHelper.getAttackDamage(handItem);
                    }
                    if (itemDamage > handDamage) {
                        mod.getSlotHandler().forceEquipItem(item);
                    } else {
                        mod.getSlotHandler().forceEquipItem(handItem);
                    }
                }
            }
        }
    }

    public void tickStart() {
        _targets.clear();
        _forceHit = null;
    }

    public void applyAura(Entity entity) {
        _targets.add(entity);
        // Always hit ghast balls.
        if (entity instanceof LargeFireball) _forceHit = entity;
    }

    public void setRange(double range) {
        _forceFieldRange = range;
    }

    public void tickEnd(AltoClef mod) {
        Optional<Entity> entities = _targets.stream().min(StlHelper.compareValues(entity -> entity.distanceToSqr(mod.getPlayer())));
        if (entities.isPresent() && mod.getPlayer().getHealth() >= 10 &&
                !mod.getEntityTracker().entityFound(AbstractThrownPotion.class) && !mod.getFoodChain().needsToEat() &&
                (Double.isInfinite(_forceFieldRange) || entities.get().distanceToSqr(mod.getPlayer()) < _forceFieldRange * _forceFieldRange ||
                        entities.get().distanceToSqr(mod.getPlayer()) < 40) &&
                !mod.getMLGBucketChain().isFallingOhNo(mod) && mod.getMLGBucketChain().doneMLG() &&
                !mod.getMLGBucketChain().isChorusFruiting()) {
            PlayerSlot offhandSlot = PlayerSlot.OFFHAND_SLOT;
            Item offhandItem = StorageHelper.getItemStackInSlot(offhandSlot).getItem();
            if (entities.get().getClass() != Creeper.class && entities.get().getClass() != Hoglin.class &&
                    entities.get().getClass() != Zoglin.class && entities.get().getClass() != Warden.class &&
                    entities.get().getClass() != WitherBoss.class
                    && (mod.getItemStorage().hasItem(Items.SHIELD) || mod.getItemStorage().hasItemInOffhand(Items.SHIELD))
                    && !mod.getPlayer().getCooldowns().isOnCooldown(new ItemStack(offhandItem))
                    && mod.getClientBaritone().getPathingBehavior().isSafeToCancel()) {
                LookHelper.lookAt(mod, entities.get().getEyePosition());
                ItemStack shieldSlot = StorageHelper.getItemStackInSlot(PlayerSlot.OFFHAND_SLOT);
                if (shieldSlot.getItem() != Items.SHIELD) {
                    mod.getSlotHandler().forceEquipItemToOffhand(Items.SHIELD);
                } else {
                    startShielding(mod);
                }
            }
            performDelayedAttack(mod);
        } else {
            stopShielding(mod);
        }
        // Run force field on map
        switch (mod.getModSettings().getForceFieldStrategy()) {
            case FASTEST:
                performFastestAttack(mod);
                break;
            case SMART:
                if (_targets.size() <= 2 || _targets.stream().allMatch(entity -> entity instanceof Skeleton) ||
                        _targets.stream().allMatch(entity -> entity instanceof Witch) ||
                        _targets.stream().allMatch(entity -> entity instanceof Pillager) ||
                        _targets.stream().allMatch(entity -> entity instanceof Piglin) ||
                        _targets.stream().allMatch(entity -> entity instanceof Stray) ||
                        _targets.stream().allMatch(entity -> entity instanceof Blaze)) {
                    performDelayedAttack(mod);
                } else {
                    if (!mod.getFoodChain().needsToEat() && !mod.getMLGBucketChain().isFallingOhNo(mod) &&
                            mod.getMLGBucketChain().doneMLG() && !mod.getMLGBucketChain().isChorusFruiting()) {
                        // Attack force mobs ALWAYS.
                        if (_forceHit != null) {
                            attack(mod, _forceHit, true);
                        }
                        if (_hitDelay.elapsed()) {
                            _hitDelay.reset();

                            Optional<Entity> toHit = _targets.stream().min(StlHelper.compareValues(entity -> entity.distanceToSqr(mod.getPlayer())));

                            toHit.ifPresent(entity -> attack(mod, entity, true));
                        }
                    }
                }
                break;
            case DELAY:
                performDelayedAttack(mod);
                break;
            case OFF:
                break;
        }
    }

    private void performDelayedAttack(AltoClef mod) {
        if (!mod.getFoodChain().needsToEat() && !mod.getMLGBucketChain().isFallingOhNo(mod) &&
                mod.getMLGBucketChain().doneMLG() && !mod.getMLGBucketChain().isChorusFruiting()) {
            if (_forceHit != null) {
                attack(mod, _forceHit, true);
            }
            // wait for the attack delay
            if (_targets.isEmpty()) {
                return;
            }

            Optional<Entity> toHit = _targets.stream().min(StlHelper.compareValues(entity -> entity.distanceToSqr(mod.getPlayer())));

            if (mod.getPlayer() == null || mod.getPlayer().getAttackStrengthScale(0) < 1) {
                return;
            }

            toHit.ifPresent(entity -> attack(mod, entity, true));
        }
    }

    private void performFastestAttack(AltoClef mod) {
        if (!mod.getFoodChain().needsToEat() && !mod.getMLGBucketChain().isFallingOhNo(mod) &&
                mod.getMLGBucketChain().doneMLG() && !mod.getMLGBucketChain().isChorusFruiting()) {
            // Just attack whenever you can
            for (Entity entity : _targets) {
                attack(mod, entity);
            }
        }
    }

    private void attack(AltoClef mod, Entity entity) {
        attack(mod, entity, false);
    }

    private void attack(AltoClef mod, Entity entity, boolean equipSword) {
        if (entity == null) return;
        if (!(entity instanceof LargeFireball)) {
            LookHelper.lookAt(mod, entity.getEyePosition());
        }
        if (Double.isInfinite(_forceFieldRange) || entity.distanceToSqr(mod.getPlayer()) < _forceFieldRange * _forceFieldRange ||
                entity.distanceToSqr(mod.getPlayer()) < 40) {
            if (entity instanceof LargeFireball) {
                mod.getControllerExtras().attack(entity);
            }
            boolean canAttack;
            if (equipSword) {
                equipWeapon(mod);
                canAttack = true;
            } else {
                // Equip non-tool
                canAttack = mod.getSlotHandler().forceDeequipHitTool();
            }
            if (canAttack) {
                if (mod.getPlayer().onGround() || mod.getPlayer().getDeltaMovement().y() < 0 || mod.getPlayer().isInWater()) {
                    mod.getControllerExtras().attack(entity);
                }
            }
        }
    }

    public void startShielding(AltoClef mod) {
        _shielding = true;
        mod.getInputControls().hold(Input.SNEAK);
        mod.getInputControls().hold(Input.CLICK_RIGHT);
        mod.getClientBaritone().getPathingBehavior().requestPause();
        mod.getExtraBaritoneSettings().setInteractionPaused(true);
        if (!mod.getPlayer().isBlocking()) {
            ItemStack handItem = StorageHelper.getItemStackInSlot(PlayerSlot.getEquipSlot());
            if (handItem.has(DataComponents.FOOD)) {
                List<ItemStack> spaceSlots = mod.getItemStorage().getItemStacksPlayerInventory(false);
                if (!spaceSlots.isEmpty()) {
                    for (ItemStack spaceSlot : spaceSlots) {
                        if (spaceSlot.isEmpty()) {
                            mod.getSlotHandler().clickSlot(PlayerSlot.getEquipSlot(), 0, ContainerInput.QUICK_MOVE);
                            return;
                        }
                    }
                }
                Optional<Slot> garbage = StorageHelper.getGarbageSlot(mod);
                garbage.ifPresent(slot -> mod.getSlotHandler().forceEquipItem(StorageHelper.getItemStackInSlot(slot).getItem()));
            }
        }
    }

    public void stopShielding(AltoClef mod) {
        if (_shielding) {
            ItemStack cursor = StorageHelper.getItemStackInCursorSlot();
            if (cursor.has(DataComponents.FOOD)) {
                Optional<Slot> toMoveTo = mod.getItemStorage().getSlotThatCanFitInPlayerInventory(cursor, false).or(() -> StorageHelper.getGarbageSlot(mod));
                if (toMoveTo.isPresent()) {
                    Slot garbageSlot = toMoveTo.get();
                    mod.getSlotHandler().clickSlot(garbageSlot, 0, ContainerInput.PICKUP);
                }
            }
            mod.getInputControls().release(Input.SNEAK);
            mod.getInputControls().release(Input.CLICK_RIGHT);
            mod.getInputControls().release(Input.JUMP);
            mod.getExtraBaritoneSettings().setInteractionPaused(false);
            _shielding = false;
        }
    }

    public enum Strategy {
        OFF,
        FASTEST,
        DELAY,
        SMART
    }
}
