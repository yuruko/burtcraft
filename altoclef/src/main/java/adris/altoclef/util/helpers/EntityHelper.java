package adris.altoclef.util.helpers;

import adris.altoclef.AltoClef;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.damagesource.CombatRules;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.damagesource.DamageTypes;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.*;
import net.minecraft.world.entity.ai.sensing.*;
import net.minecraft.world.entity.ambient.*;
import net.minecraft.world.entity.monster.*;
import net.minecraft.world.entity.monster.breeze.*;
import net.minecraft.world.entity.monster.hoglin.*;
import net.minecraft.world.entity.monster.piglin.*;
import net.minecraft.world.entity.monster.warden.*;
import net.minecraft.world.entity.projectile.*;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.tags.DamageTypeTags;
import net.minecraft.world.entity.monster.spider.Spider;
import net.minecraft.world.entity.monster.zombie.ZombifiedPiglin;

/**
 * Helper functions to interpret entity state
 */
public class EntityHelper {
    public static final double ENTITY_GRAVITY = 0.08; // per second

    public static boolean isAngryAtPlayer(AltoClef mod, Entity mob) {
        boolean hostile = isGenerallyHostileToPlayer(mod, mob);
        if (mob instanceof LivingEntity entity) {
            return hostile && entity.hasLineOfSight(mod.getPlayer());
        }
        return hostile;
    }

    public static boolean isGenerallyHostileToPlayer(AltoClef mod, Entity hostile) {
        // This is only temporary.
        if (hostile instanceof Mob entity) {
            if (entity instanceof Enemy entity1) {
                // 26.1: Enemy is a pure marker interface now, so ask the Mob about aggression
                return entity.isAggressive() || !(entity1 instanceof EnderMan || entity1 instanceof Piglin ||
                        entity1 instanceof Spider || entity1 instanceof ZombifiedPiglin);
            }
            if (entity instanceof Slime entity1) {
                return entity1.hasLineOfSight(mod.getPlayer());
            }
            return entity.isAggressive();
        }
        return !isTradingPiglin(hostile);
    }

    public static boolean isTradingPiglin(Entity entity) {
        if (entity instanceof Piglin pig) {
            // 26.1: getHandSlots() is gone, the hands are just two equipment slots now.
            for (EquipmentSlot hand : new EquipmentSlot[]{EquipmentSlot.MAINHAND, EquipmentSlot.OFFHAND}) {
                if (pig.getItemBySlot(hand).getItem().equals(Items.GOLD_INGOT)) {
                    // We're trading with this one, ignore it.
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Calculate the resulting damage dealt to a player as a result of some damage.
     * If this player were to receive this damage, the player's health will be subtracted by the resulting value.
     */
    public static double calculateResultingPlayerDamage(Player player, DamageSource source, double damageAmount) {
        // Copied logic from `Player.applyDamage`

        // 26.1: Player#isInvulnerableTo needs a ServerLevel we don't have on the client,
        // so check the two things that actually matter to us from here.
        if (player.isInvulnerable() && !source.is(DamageTypeTags.BYPASSES_INVULNERABILITY))
            return 0;

        // Armor Base
        if (!source.is(DamageTypeTags.BYPASSES_ARMOR)) {
            damageAmount = CombatRules.getDamageAfterAbsorb(player, (float) damageAmount, source, (float) player.getArmorValue(), (float) player.getAttributeValue(Attributes.ARMOR_TOUGHNESS));
        }

        // Enchantments & Potions
        if (!source.is(DamageTypeTags.BYPASSES_SHIELD)) {
            int k;
            if (player.hasEffect(MobEffects.RESISTANCE) && source.is(DamageTypes.FELL_OUT_OF_WORLD)) {
                //noinspection ConstantConditions
                k = (player.getEffect(MobEffects.RESISTANCE).getAmplifier() + 1) * 5;
                int j = 25 - k;
                double f = damageAmount * (double) j;
                double g = damageAmount;
                damageAmount = Math.max(f / 25.0F, 0.0F);
            }

            if (damageAmount <= 0.0) {
                damageAmount = 0.0;
            }
            // 26.1: EnchantmentHelper#getDamageProtection needs a ServerLevel, which the client
            // doesn't have. dropping the protection term only ever OVER-estimates incoming damage,
            // and every caller uses this to decide "am i about to die" - erring high is the safe way.
        }

        // Absorption
        damageAmount = Math.max(damageAmount - player.getAbsorptionAmount(), 0.0F);
        return damageAmount;
    }
}
