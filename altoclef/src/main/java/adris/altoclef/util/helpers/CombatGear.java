package adris.altoclef.util.helpers;

import adris.altoclef.AltoClef;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.List;

/**
 * "what can she actually bring to this fight?"
 * <p>
 * ⚠ THE BUG THIS FILE EXISTS FOR: every combat judgement in the codebase measured the
 * loadout she happened to be WEARING, and nothing anywhere ever put gear on before a
 * fight. {@code MobDefenseChain.canSafelyFight} reads {@code getArmorValue()} (worn) and
 * scores a shield in the offhand at +0.75 but the same shield in her bag at +0.20 - so it
 * KNEW the difference and never acted on it. A bot carrying a full iron set and a shield
 * was scored as naked, decided it could not win, and ran. Fleeing is also what stopped
 * her ever getting the gear on. A fresh spawn owns nothing, so "carrying but not wearing"
 * is the NORMAL case, not an edge one.
 * <p>
 * So there are two different questions and they had been collapsed into one:
 * <ul>
 *   <li>{@link #wornCapacityArmor} - what she has on RIGHT NOW. governs this tick.</li>
 *   <li>{@link #reachableArmor} - what she would have after a few slot clicks. governs
 *       whether "run away" or "put your armour on" is the better answer.</li>
 * </ul>
 * <p>
 * {@link #readyUp} closes the gap WITHOUT a task. That is the whole design constraint:
 * MobDefenseChain (70-80) outranks UserTaskChain (50), so the moment she most needs to
 * gear up is the moment nothing can own the task slot - and every freeze in that file's
 * long history came from a second contender for that slot. Slot clicks are not tasks.
 * KillAura already equips a shield to the offhand mid-fight by exactly this route, so
 * the pattern is proven under the conditions it has to survive.
 */
public final class CombatGear {

    /** arrows she can actually loose. tipped/spectral count - they are strictly better. */
    public static final Item[] ARROWS = {Items.ARROW, Items.TIPPED_ARROW, Items.SPECTRAL_ARROW};

    /**
     * armor slots worth filling, best-payoff first. chest and legs carry the most armor
     * points per piece, so when only one click lands before the next hit, it should be
     * the chestplate - not whichever piece happened to sort first.
     */
    private static final EquipmentSlot[] ARMOR_SLOTS = {
            EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.HEAD, EquipmentSlot.FEET
    };

    private CombatGear() {
    }

    // ------------------------------------------------------------------
    // melee
    // ------------------------------------------------------------------

    /**
     * the hardest-hitting melee weapon she is carrying, of ANY kind.
     * <p>
     * ⚠ the old answer scanned a hardcoded SWORDS[] ladder, so an axe was invisible -
     * and a netherite axe (10 damage) beats a netherite sword (8). She fled fights while
     * holding the better weapon. See {@link ItemVersionHelper#isMeleeWeapon}.
     */
    public static Item bestMeleeWeapon(AltoClef mod) {
        if (mod == null || mod.getPlayer() == null) return null;
        Item best = null;
        float bestDamage = Float.NEGATIVE_INFINITY;
        for (ItemStack stack : allCarried(mod)) {
            if (stack == null || stack.isEmpty()) continue;
            Item item = stack.getItem();
            if (!ItemVersionHelper.isMeleeWeapon(item)) continue;
            float damage = ItemVersionHelper.getAttackDamage(item);
            if (damage > bestDamage) {
                bestDamage = damage;
                best = item;
            }
        }
        return best;
    }

    /** attack damage of {@link #bestMeleeWeapon}, or 0 when she is genuinely bare-handed. */
    public static double bestMeleeDamage(AltoClef mod) {
        Item best = bestMeleeWeapon(mod);
        return best == null ? 0 : ItemVersionHelper.getAttackDamage(best);
    }

    // ------------------------------------------------------------------
    // ranged
    // ------------------------------------------------------------------

    public static boolean hasBow(AltoClef mod) {
        return mod != null && mod.getItemStorage().hasItem(Items.BOW);
    }

    public static int arrowCount(AltoClef mod) {
        return mod == null ? 0 : mod.getItemStorage().getItemCount(ARROWS);
    }

    /** a bow with nothing to put in it is not a ranged option. */
    public static boolean canShoot(AltoClef mod) {
        return hasBow(mod) && arrowCount(mod) > 0;
    }

    // ------------------------------------------------------------------
    // shield
    // ------------------------------------------------------------------

    public static boolean shieldInOffhand(AltoClef mod) {
        return mod != null && mod.getItemStorage().hasItemInOffhand(Items.SHIELD);
    }

    public static boolean hasShield(AltoClef mod) {
        return mod != null && (shieldInOffhand(mod) || mod.getItemStorage().hasItem(Items.SHIELD));
    }

    // ------------------------------------------------------------------
    // armor
    // ------------------------------------------------------------------

    /** armor points she is wearing right now. */
    public static double wornCapacityArmor(AltoClef mod) {
        return mod == null || mod.getPlayer() == null ? 0 : mod.getPlayer().getArmorValue();
    }

    /**
     * armor points she would have after putting on everything she is carrying - per slot,
     * never a downgrade. This is the number that decides whether running is really her
     * best option or whether she is one slot click away from winning.
     */
    public static double reachableArmor(AltoClef mod) {
        if (mod == null || mod.getPlayer() == null) return 0;
        double total = 0;
        for (EquipmentSlot slot : ARMOR_SLOTS) {
            ItemStack worn = mod.getPlayer().getItemBySlot(slot);
            double best = worn == null || worn.isEmpty() ? 0 : ItemVersionHelper.getArmorProtection(worn.getItem());
            Item upgrade = bestCarriedForSlot(mod, slot);
            if (upgrade != null) best = Math.max(best, ItemVersionHelper.getArmorProtection(upgrade));
            total += best;
        }
        return total;
    }

    /** best piece in her BAG for this slot (ignores what is already on her). */
    public static Item bestCarriedForSlot(AltoClef mod, EquipmentSlot slot) {
        if (mod == null || slot == null) return null;
        Item best = null;
        double bestProtection = 0;
        for (ItemStack stack : allCarried(mod)) {
            if (stack == null || stack.isEmpty()) continue;
            Item item = stack.getItem();
            if (!ItemVersionHelper.isArmor(item)) continue;
            if (ItemVersionHelper.getArmorSlot(item) != slot) continue;
            double protection = ItemVersionHelper.getArmorProtection(item);
            if (protection > bestProtection) {
                bestProtection = protection;
                best = item;
            }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // the readiness gap
    // ------------------------------------------------------------------

    /**
     * is there a strictly better loadout a few slot clicks away? This is the question
     * that turns "I cannot win this" into "I cannot win this YET".
     */
    public static boolean hasUnusedGear(AltoClef mod) {
        if (mod == null || mod.getPlayer() == null) return false;
        if (!shieldInOffhand(mod) && mod.getItemStorage().hasItem(Items.SHIELD)) return true;
        if (reachableArmor(mod) > wornCapacityArmor(mod) + 0.01) return true;
        Item best = bestMeleeWeapon(mod);
        if (best != null) {
            ItemStack held = mod.getPlayer().getMainHandItem();
            double heldDamage = held == null || held.isEmpty() ? 0 : ItemVersionHelper.getAttackDamage(held.getItem());
            if (ItemVersionHelper.getAttackDamage(best) > heldDamage + 0.01) return true;
        }
        return false;
    }

    /**
     * Do ONE step of getting ready. Call it every tick while she is retreating or about
     * to commit to a fight; the slot handler rate-limits the clicks itself.
     * <p>
     * Order is deliberate: weapon first (it is one click and it is what she swings),
     * then the shield (worth +0.55 of capacity over merely owning one), then armor
     * heaviest piece first - because the run may be interrupted at any point and
     * whatever landed first is what she fights in.
     *
     * @param wantMeleeKit false while the fight is RANGED. ⚠ THIS GATES THE WEAPON AS
     *                     WELL AS THE SHIELD, and gating only the shield made the entire
     *                     ranged feature non-functional: a bow carries no ATTACK_DAMAGE
     *                     modifier, so getAttackDamage(BOW) is 0 and ANY sword beats it.
     *                     The chain equipped the sword from here while BowCombatTask
     *                     equipped the bow, both through clickSlotForce (which bypasses
     *                     the slot-action rate limit), roughly forty times a second.
     *                     Swapping the held stack calls stopUsingItem(), so
     *                     getTicksUsingItem() reset every tick and the draw could never
     *                     complete - she never loosed a single arrow. Armor is unaffected
     *                     and still goes on during a ranged fight.
     * @return true when there is nothing left to put on.
     */
    public static boolean readyUp(AltoClef mod, boolean wantMeleeKit) {
        if (mod == null || mod.getPlayer() == null) return true;
        boolean done = true;

        // ⚠ NOT WHILE SHE IS EATING. The single-Item forceEquipItem overload is the one
        // WITHOUT the needsToEat guard that the varargs form carries, and MobDefenseChain
        // deliberately keeps defending while eating in danger - so this ran mid-meal and
        // swapped the food out of her hand. Eating needs ~32 uninterrupted ticks; it was
        // getting one, and she could never heal in a fight. KillAura avoids this by
        // gating every one of its equip call sites the same way.
        Item weapon = wantMeleeKit && !mod.getFoodChain().needsToEat() ? bestMeleeWeapon(mod) : null;
        if (weapon != null) {
            ItemStack held = mod.getPlayer().getMainHandItem();
            double heldDamage = held == null || held.isEmpty() ? 0 : ItemVersionHelper.getAttackDamage(held.getItem());
            if (ItemVersionHelper.getAttackDamage(weapon) > heldDamage + 0.01) {
                mod.getSlotHandler().forceEquipItem(weapon);
                done = false;
            }
        }

        if (wantMeleeKit && !shieldInOffhand(mod) && mod.getItemStorage().hasItem(Items.SHIELD)) {
            mod.getSlotHandler().forceEquipItemToOffhand(Items.SHIELD);
            done = false;
        }

        // ⚠⚠ FINISH THE MOVE THAT IS ALREADY IN FLIGHT, BEFORE LOOKING IN THE BAG.
        //
        // forceEquipArmorPiece is a TWO-CLICK dance: the first call picks the piece
        // up into the cursor, a LATER call sees it there and places it into the
        // armor slot. But the loop below asks bestCarriedForSlot, which is built on
        // allCarried -> getItemStacksPlayerInventory(FALSE), i.e. deliberately
        // WITHOUT the cursor. So the instant click 1 landed, the piece was in the
        // cursor and out of the bag, the upgrade read as null, the loop `continue`d,
        // and CLICK 2 WAS NEVER ISSUED. One second later PlayerInteractionFixChain
        // put the cursor stack back in the inventory, the loop saw it again, and
        // picked it up again - forever, at 1 Hz, two container packets a second,
        // _gearingUp flickering on the wire, and not one piece of armor ever going
        // on. Which means wornCapacityArmor never rose, couldTakeItIfGeared stayed
        // true, and canSafelyFight kept saying run: the whole "retreat and re-arm"
        // feature this class exists for was a no-op for armor. (It worked by
        // accident only when she carried a DUPLICATE of the same piece.)
        //
        // The offhand leg never had this bug because its callers re-poll the
        // DESTINATION slot. This does the same: ask what the cursor is holding.
        ItemStack cursor = StorageHelper.getItemStackInCursorSlot();
        if (cursor != null && !cursor.isEmpty() && ItemVersionHelper.getArmorSlot(cursor.getItem()) != null) {
            mod.getSlotHandler().forceEquipArmorPiece(cursor.getItem());
            return false;   // the place lands on the next call; still not ready
        }

        for (EquipmentSlot slot : ARMOR_SLOTS) {
            Item upgrade = bestCarriedForSlot(mod, slot);
            if (upgrade == null) continue;
            ItemStack worn = mod.getPlayer().getItemBySlot(slot);
            double wornProtection = worn == null || worn.isEmpty() ? 0 : ItemVersionHelper.getArmorProtection(worn.getItem());
            if (ItemVersionHelper.getArmorProtection(upgrade) <= wornProtection + 0.01) continue;
            mod.getSlotHandler().forceEquipArmorPiece(upgrade);
            done = false;
            // ONE piece per call. Each equip is a two-click pickup/place dance and
            // issuing four of them in one tick makes them fight over the cursor.
            break;
        }

        return done;
    }

    // ------------------------------------------------------------------

    private static List<ItemStack> allCarried(AltoClef mod) {
        // false = no CURSOR slot. A stack in the cursor is mid-move and asking about it
        // races whatever is moving it.
        //
        // ⚠ this DOES include the four worn armor pieces and the offhand - only the
        // cursor is excluded - so "carried" here means "on her person", not "in the bag".
        // Harmless everywhere it is used, but only by accident, so do not lean on it:
        // reachableArmor takes max(worn, upgrade) and readyUp skips anything not strictly
        // better than what is worn, so a worn piece appearing as its own "upgrade"
        // neither double-counts nor loops. A future caller that assumes bag-only will be
        // wrong.
        return mod.getItemStorage().getItemStacksPlayerInventory(false);
    }
}
