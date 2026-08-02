package adris.altoclef.chains;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.control.KillAura;
import adris.altoclef.tasks.entity.KillEntitiesTask;
import adris.altoclef.tasks.movement.CustomBaritoneGoalTask;
import adris.altoclef.tasks.movement.DodgeProjectilesTask;
import adris.altoclef.tasks.movement.RunAwayFromCreepersTask;
import adris.altoclef.tasks.movement.RunAwayFromHostilesTask;
import adris.altoclef.tasks.speedrun.DragonBreathTracker;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.tasksystem.TaskRunner;
import adris.altoclef.util.baritone.CachedProjectile;
import adris.altoclef.util.helpers.*;
import adris.altoclef.util.slots.PlayerSlot;
import adris.altoclef.util.slots.Slot;
import adris.altoclef.util.time.TimerGame;
import baritone.Baritone;
import baritone.api.utils.Rotation;
import baritone.api.utils.input.Input;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.wither.WitherBoss;
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
import net.minecraft.world.entity.projectile.*;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

import java.util.*;

import static java.lang.Math.abs;
import net.minecraft.world.entity.monster.skeleton.AbstractSkeleton;
import net.minecraft.world.entity.monster.skeleton.Skeleton;
import net.minecraft.world.entity.monster.illager.Pillager;
import net.minecraft.world.entity.monster.skeleton.Stray;
import net.minecraft.world.entity.monster.skeleton.WitherSkeleton;
import net.minecraft.world.entity.monster.illager.Vindicator;
import net.minecraft.world.entity.projectile.hurtingprojectile.LargeFireball;
import net.minecraft.world.entity.projectile.hurtingprojectile.DragonFireball;
import net.minecraft.world.entity.projectile.arrow.Arrow;
import net.minecraft.world.entity.projectile.arrow.SpectralArrow;
import net.minecraft.world.entity.projectile.hurtingprojectile.SmallFireball;
import net.minecraft.core.component.DataComponents;
import adris.altoclef.util.helpers.ItemVersionHelper;
import net.minecraft.world.entity.projectile.throwableitemprojectile.AbstractThrownPotion;

public class MobDefenseChain extends SingleTaskChain {
    private static final double DANGER_KEEP_DISTANCE = 30;
    private static final double CREEPER_KEEP_DISTANCE = 10;
    private static final double ARROW_KEEP_DISTANCE_HORIZONTAL = 2;//4;
    private static final double ARROW_KEEP_DISTANCE_VERTICAL = 10;//15;
    private static final double SAFE_KEEP_DISTANCE = 8;
    // hysteresis: engage at SAFE_KEEP_DISTANCE, disengage only past this.
    // TaskRunner re-picks the highest-priority chain EVERY tick and calls onInterrupt on
    // the loser, and Task.stop() sets _first = true all the way down the sub-task tree. so
    // a single flicker of "angry hostile within 8 blocks" tears the ENTIRE user task tree
    // down and rebuilds it, which ends in a fresh baritone path calculation (~2s). flapping
    // faster than that means she never finishes pathing, never moves, and stands in place
    // until something kills her. holding the engagement until the danger is actually gone
    // is what stops the teardown/rebuild cycle.
    private static final double DISENGAGE_KEEP_DISTANCE = 16;
    // below this, running really is the right call even from one zombie
    private static final float STAND_AND_FIGHT_MIN_HEALTH = 8;
    // how long a chosen defensive answer is held before a sibling answer may replace
    // it. must comfortably exceed a baritone path calculation (~1s at these ranges)
    // or the answer never gets far enough to be one. see commitTo().
    private static final double DEFENSE_COMMIT_SECONDS = 2.5;
    private static boolean _shielding = false;
    private final DragonBreathTracker _dragonBreathTracker = new DragonBreathTracker();
    private final KillAura _killAura = new KillAura();
    private final HashMap<Entity, TimerGame> _closeAnnoyingEntities = new HashMap<>();
    private Entity _targetEntity;
    private boolean _doingFunkyStuff = false;
    private boolean _wasPuttingOutFire = false;
    private CustomBaritoneGoalTask _runAwayTask;

    private float _cachedLastPriority;

    // the answers this chain can give. they are SIBLINGS inside ONE chain, so
    // TaskChain priority arbitrates none of them against each other - see commitTo().
    private enum DefenseMode {NONE, DODGE, FIGHT, FLEE}

    private DefenseMode _defenseMode = DefenseMode.NONE;
    private final TimerGame _defenseCommitment = new TimerGame(DEFENSE_COMMIT_SECONDS);
    private Class<?> _committedFightTarget;

    public MobDefenseChain(TaskRunner runner) {
        super(runner);
    }

    /**
     * Hold a chosen defensive answer long enough for it to actually happen.
     * <p>
     * dodge / fight / flee all live in THIS chain and all return 65-80, so the
     * chain-level hysteresis (DISENGAGE_KEEP_DISTANCE) never arbitrates between
     * them: whichever branch matches on a given tick just calls setTask(), and
     * SingleTaskChain.setTask() stops and resets the entire sub-task tree whenever
     * the new task isn't equal() to the old one. isProjectileClose() flickers as
     * arrows fly and land, so "arrow inbound -> dodge" and "no arrow -> kill the
     * skeleton" traded the task back and forth about once a second. every trade
     * restarts baritone pathing, which takes ~1s+ at these ranges, so she never
     * finished a single path - she stood still in a crowd and was beaten to death
     * (2026-08-01: killed by an enderman after flipping dodge/kill/flee 19 times in
     * her last 20 seconds).
     * <p>
     * so: once an answer is picked, keep it. real escalations (fusing creeper,
     * warden-class mob) bypass this via forceMode().
     * <p>
     * BEWARE isFinished() ON THESE TASKS. it does NOT mean "the work is done" - for a
     * CustomBaritoneGoalTask it is {@code _cachedGoal.isInGoal(playerPos)}, i.e. "the
     * condition happens to hold on THIS tick". GoalDodgeProjectiles is satisfied the
     * instant no arrow is inbound; a run-away goal the instant she is briefly far
     * enough. both flicker every tick as arrows and mobs move. a first version of this
     * method released the commitment whenever the running task was "finished", which
     * fired precisely when the sibling branch wanted the slot - dodge and flee then
     * traded the task ~1x/sec and she died a second time (2026-08-01 22:17:57, shot by
     * a Pillager she never got away from). the finished-check therefore only ever
     * applies ACROSS answer classes, never between two evasions.
     *
     * @return true if the caller may (re)set its task, false if we are mid-commitment
     * to a different answer and the caller must leave the running task alone.
     */
    private boolean commitTo(AltoClef mod, DefenseMode mode) {
        if (_defenseMode == mode) return true;
        if (_defenseMode == DefenseMode.NONE) {
            forceMode(mode);
            return true;
        }
        // DODGE and FLEE are the SAME ANSWER: get away. swapping between them buys
        // nothing and costs a full task-tree teardown plus a fresh path calculation.
        if (isEvasion(_defenseMode) && isEvasion(mode)) {
            // one-way escalation only. fleeing hostiles subsumes dodging their arrows,
            // so dodge may become flee; flee must NEVER fall back to dodge, because a
            // two-way door here is exactly the ping-pong this whole mechanism exists
            // to stop.
            if (_defenseMode == DefenseMode.DODGE && mode == DefenseMode.FLEE) {
                forceMode(mode);
                return true;
            }
            return false;
        }
        if (_defenseCommitment.elapsed() || currentTaskDone(mod)) {
            forceMode(mode);
            return true;
        }
        return false;
    }

    private static boolean isEvasion(DefenseMode m) {
        return m == DefenseMode.DODGE || m == DefenseMode.FLEE;
    }

    private boolean currentTaskDone(AltoClef mod) {
        Task current = getCurrentTask();
        return current == null || current.stopped() || current.isFinished(mod);
    }

    private void forceMode(DefenseMode mode) {
        if (_defenseMode != mode) {
            _defenseMode = mode;
            _committedFightTarget = null;
        }
        _defenseCommitment.reset();
    }

    private void releaseDefenseMode() {
        _defenseMode = DefenseMode.NONE;
        _committedFightTarget = null;
    }

    /**
     * Pick ONE hostile to commit to, and keep picking it.
     * <p>
     * the old loop had two identical branches, so it always took toDealWith.get(0) -
     * whose order comes from the entity tracker and reorders freely. a skeleton and
     * an enderman standing together therefore swapped the kill target, and with it
     * the whole task tree, on alternate ticks. hold the target while it is alive and
     * still a problem; otherwise take the closest, since that is what is hitting her.
     */
    private Class<?> pickFightTarget(AltoClef mod, List<Entity> toDealWith) {
        if (_committedFightTarget != null) {
            for (Entity e : toDealWith) {
                if (e.getClass() == _committedFightTarget && e.isAlive()) return _committedFightTarget;
            }
        }
        Entity closest = null;
        double best = Double.POSITIVE_INFINITY;
        for (Entity e : toDealWith) {
            double d = e.distanceToSqr(mod.getPlayer());
            if (d < best) {
                best = d;
                closest = e;
            }
        }
        _committedFightTarget = (closest != null ? closest : toDealWith.get(0)).getClass();
        return _committedFightTarget;
    }

    public static double getCreeperSafety(Vec3 pos, Creeper creeper) {
        double distance = creeper.distanceToSqr(pos);
        float fuse = creeper.getSwelling(1);

        // Not fusing.
        if (fuse <= 0.001f) return distance;
        return distance * 0.2; // less is WORSE
    }

    private static void startShielding(AltoClef mod) {
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

    @Override
    public float getPriority(AltoClef mod) {
        _cachedLastPriority = getPriorityInner(mod);
        return _cachedLastPriority;
    }

    private void stopShielding(AltoClef mod) {
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
            mod.getExtraBaritoneSettings().setInteractionPaused(false);
            _shielding = false;
        }
    }

    private boolean escapeDragonBreath(AltoClef mod) {
        _dragonBreathTracker.updateBreath(mod);
        for (BlockPos playerIn : WorldHelper.getBlocksTouchingPlayer(mod)) {
            if (_dragonBreathTracker.isTouchingDragonBreath(playerIn)) {
                return true;
            }
        }
        return false;
    }

    public float getPriorityInner(AltoClef mod) {
        if (!AltoClef.inGame()) {
            return Float.NEGATIVE_INFINITY;
        }

        if (!mod.getModSettings().isMobDefense()) {
            return Float.NEGATIVE_INFINITY;
        }

        // Apply avoidance if we're vulnerable, avoiding mobs if at all possible.
        // mod.getClientBaritoneSettings().avoidance.value = isVulnurable(mod);
        // Doing you a favor by disabling avoidance


        // Pause if we're not loaded into a world.
        if (!AltoClef.inGame()) return Float.NEGATIVE_INFINITY;

        // Put out fire if we're standing on one like an idiot
        BlockPos fireBlock = isInsideFireAndOnFire(mod);
        if (fireBlock != null) {
            putOutFire(mod, fireBlock);
            _wasPuttingOutFire = true;
        } else {
            // Stop putting stuff out if we no longer need to put out a fire.
            mod.getClientBaritone().getInputOverrideHandler().setInputForceState(Input.CLICK_LEFT, false);
            _wasPuttingOutFire = false;
        }

        // MLG bucket / chorus fruit genuinely own the controls - stand down.
        if (mod.getMLGBucketChain().isFallingOhNo(mod) || !mod.getMLGBucketChain().doneMLG() ||
                mod.getMLGBucketChain().isChorusFruiting()) {
            _killAura.stopShielding(mod);
            stopShielding(mod);
            releaseDefenseMode();
            return Float.NEGATIVE_INFINITY;
        }
        // eating used to stand defense down the same way, and that is what let the
        // enderman finish her on 2026-08-01: needsToEat() turns on at health <= 10,
        // i.e. exactly while she is being hit, and this early return then cancelled
        // dodging, fleeing AND the force field for the whole chew. eating does not
        // need the chain to yield at all - FoodChain.getPriority() returns
        // NEGATIVE_INFINITY and eats asynchronously by holding right-click. so only
        // stand down when nothing is actually attacking; in danger, defend and let
        // the meal be interrupted. being alive beats being fed.
        if (mod.getFoodChain().needsToEat() && !isInDanger(mod)) {
            _killAura.stopShielding(mod);
            stopShielding(mod);
            releaseDefenseMode();
            return Float.NEGATIVE_INFINITY;
        }

        // Force field
        doForceField(mod);


        // Tell baritone to avoid mobs if we're vulnurable.
        // Costly.
        //mod.getClientBaritoneSettings().avoidance.value = isVulnurable(mod);

        // Run away if a weird mob is close by.
        Optional<Entity> universallyDangerous = getUniversallyDangerousMob(mod);
        if (universallyDangerous.isPresent() && mod.getPlayer().getHealth() <= 10) {
            // a warden-class mob at low health outranks any commitment.
            forceMode(DefenseMode.FLEE);
            _runAwayTask = new RunAwayFromHostilesTask(DANGER_KEEP_DISTANCE, true);
            setTask(_runAwayTask);
            return 70;
        }

        _doingFunkyStuff = false;
        PlayerSlot offhandSlot = PlayerSlot.OFFHAND_SLOT;
        Item offhandItem = StorageHelper.getItemStackInSlot(offhandSlot).getItem();
        // Run away from creepers
        Creeper blowingUp = getClosestFusingCreeper(mod);
        if (blowingUp != null) {
            if (!mod.getFoodChain().needsToEat() && (mod.getItemStorage().hasItem(Items.SHIELD) ||
                    mod.getItemStorage().hasItemInOffhand(Items.SHIELD)) &&
                    !mod.getEntityTracker().entityFound(AbstractThrownPotion.class) && _runAwayTask == null
                    && !mod.getPlayer().getCooldowns().isOnCooldown(new ItemStack(offhandItem))
                    && mod.getClientBaritone().getPathingBehavior().isSafeToCancel()) {
                _doingFunkyStuff = true;
                LookHelper.lookAt(mod, blowingUp.getEyePosition());
                ItemStack shieldSlot = StorageHelper.getItemStackInSlot(PlayerSlot.OFFHAND_SLOT);
                if (shieldSlot.getItem() != Items.SHIELD) {
                    mod.getSlotHandler().forceEquipItemToOffhand(Items.SHIELD);
                } else {
                    startShielding(mod);
                }
            } else {
                _doingFunkyStuff = true;
                //Debug.logMessage("RUNNING AWAY!");
                // a lit creeper always wins the argument.
                forceMode(DefenseMode.FLEE);
                _runAwayTask = new RunAwayFromCreepersTask(CREEPER_KEEP_DISTANCE);
                setTask(_runAwayTask);
                return 50 + blowingUp.getSwelling(1) * 50;
            }
        } else {
            if (!isProjectileClose(mod)) {
                stopShielding(mod);
            }
        }
        // Block projectiles with shield
        if (!mod.getFoodChain().needsToEat() && mod.getModSettings().isDodgeProjectiles() && isProjectileClose(mod) &&
                (mod.getItemStorage().hasItem(Items.SHIELD) || mod.getItemStorage().hasItemInOffhand(Items.SHIELD)) &&
                !mod.getEntityTracker().entityFound(AbstractThrownPotion.class) && _runAwayTask == null
                && !mod.getPlayer().getCooldowns().isOnCooldown(new ItemStack(offhandItem))
                && mod.getClientBaritone().getPathingBehavior().isSafeToCancel()) {
            ItemStack shieldSlot = StorageHelper.getItemStackInSlot(PlayerSlot.OFFHAND_SLOT);
            if (shieldSlot.getItem() != Items.SHIELD) {
                mod.getSlotHandler().forceEquipItemToOffhand(Items.SHIELD);
            } else {
                startShielding(mod);
            }
        } else {
            if (blowingUp == null) {
                stopShielding(mod);
            }
        }
        // Dodge projectiles
        if (mod.getPlayer().getHealth() <= 10 || _runAwayTask != null || mod.getEntityTracker().entityFound(AbstractThrownPotion.class) ||
                (!mod.getItemStorage().hasItem(Items.SHIELD) && !mod.getItemStorage().hasItemInOffhand(Items.SHIELD))) {
            if (!mod.getFoodChain().needsToEat() && mod.getModSettings().isDodgeProjectiles() && isProjectileClose(mod)) {
                _doingFunkyStuff = true;
                //Debug.logMessage("DODGING");
                // refused = we are mid-fight/mid-flight; return the priority anyway so
                // the running answer keeps the chain and keeps ticking.
                if (commitTo(mod, DefenseMode.DODGE)) {
                    _runAwayTask = new DodgeProjectilesTask(ARROW_KEEP_DISTANCE_HORIZONTAL, ARROW_KEEP_DISTANCE_VERTICAL);
                    setTask(_runAwayTask);
                }
                return 65;
            }
        }
        // Dodge all mobs cause we boutta die son
        // ...unless it is a single melee mob she can actually take. see
        // shouldStandAndFight: without that check she flees from the first hit onward
        // and dies with her back turned, which is how she lost a fight to one zombie.
        if (isInDanger(mod) && !escapeDragonBreath(mod) && !mod.getFoodChain().isShouldStop()
            && !shouldStandAndFight(mod)) {
            if (_targetEntity == null) {
                if (commitTo(mod, DefenseMode.FLEE)) {
                    _runAwayTask = new RunAwayFromHostilesTask(DANGER_KEEP_DISTANCE, true);
                    setTask(_runAwayTask);
                }
                return 70;
            }
        }

        if (mod.getModSettings().shouldDealWithAnnoyingHostiles()) {
            // Deal with hostiles because they are annoying.
            List<Entity> hostiles = mod.getEntityTracker().getHostiles();
            // TODO: I don't think this lock is necessary at all.

            Item bestSword = null;
            Item[] SWORDS = new Item[]{Items.NETHERITE_SWORD, Items.DIAMOND_SWORD, Items.IRON_SWORD, Items.GOLDEN_SWORD,
                    Items.STONE_SWORD, Items.WOODEN_SWORD};
            for (Item item : SWORDS) {
                if (mod.getItemStorage().hasItem(item)) {
                    bestSword = item;
                }
            }

            List<Entity> toDealWith = new ArrayList<>();

            // TODO: I don't think this lock is necessary at all.
            if (!hostiles.isEmpty()) {
                synchronized (BaritoneHelper.MINECRAFT_LOCK) {
                    for (Entity hostile : hostiles) {
                        // AbstractSkeleton, not Skeleton. Bogged and Parched are SIBLINGS of
                        // Skeleton under AbstractSkeleton, so `instanceof Skeleton` never matched
                        // them and a ranged mob got the 8-block melee range. a Bogged shoots from
                        // 15, i.e. from outside the range that would have made her react at all -
                        // that is what killed her on 2026-08-01. Stray/WitherSkeleton come along
                        // for free since they share the same parent.
                        int annoyingRange = (hostile instanceof AbstractSkeleton || hostile instanceof Witch || hostile
                                instanceof Pillager || hostile instanceof Piglin) ? 15 : 8;
                        boolean isClose = hostile.closerThan(mod.getPlayer(), annoyingRange);

                        if (isClose) {
                            isClose = LookHelper.seesPlayer(hostile, mod.getPlayer(), annoyingRange);
                        }

                        // Give each hostile a timer, if they're close for too long deal with them.
                        if (isClose) {
                            if (!_closeAnnoyingEntities.containsKey(hostile)) {
                                boolean wardenAttacking = hostile instanceof Warden;
                                boolean witherAttacking = hostile instanceof WitherBoss;
                                boolean endermanAttacking = hostile instanceof EnderMan;
                                boolean blazeAttacking = hostile instanceof Blaze;
                                boolean witherSkeletonAttacking = hostile instanceof WitherSkeleton;
                                boolean hoglinAttacking = hostile instanceof Hoglin;
                                boolean zoglinAttacking = hostile instanceof Zoglin;
                                boolean piglinBruteAttacking = hostile instanceof PiglinBrute;
                                boolean vindicatorAttacking = hostile instanceof Vindicator;
                                if (blazeAttacking || witherSkeletonAttacking || hoglinAttacking || zoglinAttacking ||
                                        piglinBruteAttacking || endermanAttacking || witherAttacking || wardenAttacking || vindicatorAttacking) {
                                    if (mod.getPlayer().getHealth() <= 10) {
                                        _closeAnnoyingEntities.put(hostile, new TimerGame(0));
                                    } else {
                                        _closeAnnoyingEntities.put(hostile, new TimerGame(Float.POSITIVE_INFINITY));
                                    }
                                } else {
                                    _closeAnnoyingEntities.put(hostile, new TimerGame(0));
                                }
                                _closeAnnoyingEntities.get(hostile).reset();
                            }
                            if (_closeAnnoyingEntities.get(hostile).elapsed()) {
                                toDealWith.add(hostile);
                            }
                        } else {
                            _closeAnnoyingEntities.remove(hostile);
                        }
                    }
                }
            }

            // Clear dead/non existing hostiles
            List<Entity> toRemove = new ArrayList<>();
            if (!_closeAnnoyingEntities.keySet().isEmpty()) {
                for (Entity check : _closeAnnoyingEntities.keySet()) {
                    if (!check.isAlive()) {
                        toRemove.add(check);
                    }
                }
            }
            if (!toRemove.isEmpty()) {
                for (Entity remove : toRemove) _closeAnnoyingEntities.remove(remove);
            }
            int numberOfProblematicEntities = toDealWith.size();
            if (!toDealWith.isEmpty()) {
                for (Entity ToDealWith : toDealWith) {
                    if (ToDealWith.getClass() == Slime.class || ToDealWith.getClass() == MagmaCube.class) {
                        numberOfProblematicEntities = 1;
                        break;
                    }
                }
            }
            if (numberOfProblematicEntities > 0) {

                // Depending on our weapons/armor, we may chose to straight up kill hostiles if we're not dodging their arrows.

                // wood 0 : 1 skeleton
                // stone 1 : 1 skeleton
                // iron 2 : 2 hostiles
                // diamond 3 : 3 hostiles
                // netherite 4 : 4 hostiles

                // Armor: (do the math I'm not boutta calculate this)
                // leather: ?1 skeleton
                // iron: ?2 hostiles
                // diamond: ?3 hostiles

                // 7 is full set of leather
                // 15 is full set of iron.
                // 20 is full set of diamond.
                // Diamond+netherite have bonus "toughness" parameter (we can simply add them I think, for now.)
                // full diamond has 8 bonus toughness
                // full netherite has 12 bonus toughness
                int armor = mod.getPlayer().getArmorValue();
                float damage = bestSword == null ? 0 : (1 + ItemVersionHelper.getAttackDamage(bestSword));
                boolean hasShield = mod.getItemStorage().hasItem(Items.SHIELD) ||
                        mod.getItemStorage().hasItemInOffhand(Items.SHIELD);
                int shield = hasShield ? 20 : 0;
                int canDealWith = (int) Math.ceil((armor * 3.6 / 20.0) + (damage * 0.8) + (shield));
                canDealWith += 1;
                // bare-handed floor. with no armor, no sword and no shield the formula above is
                // exactly 1, and the test below is `canDealWith > numberOfProblematicEntities`,
                // so 1 > 1 is false and she runs from a SINGLE zombie - forever, because running
                // is what stops her ever gathering the gear that would change the answer. a fresh
                // spawn owns nothing, so "nothing equipped" is the normal case, not the edge case.
                // let a reasonably healthy bot punch ONE ordinary melee mob; anything ranged or
                // explosive still gets fled from, and 2+ mobs still gets fled from.
                if (toDealWith.size() == 1 && numberOfProblematicEntities == 1
                        && mod.getPlayer().getHealth() > STAND_AND_FIGHT_MIN_HEALTH
                        && !outrangesUs(toDealWith.get(0))) {
                    canDealWith = 2;
                }
                if (canDealWith > numberOfProblematicEntities) {
                    // We can deal with it.
                    if (commitTo(mod, DefenseMode.FIGHT)) {
                        _runAwayTask = null;
                        setTask(new KillEntitiesTask(pickFightTarget(mod, toDealWith)));
                    }
                    return 65;
                } else {
                    // We can't deal with it
                    if (commitTo(mod, DefenseMode.FLEE)) {
                        _runAwayTask = new RunAwayFromHostilesTask(DANGER_KEEP_DISTANCE, true);
                        setTask(_runAwayTask);
                    }
                    return 80;
                }
            }
        }
        // By default if we aren't "immediately" in danger but were running away, keep running away until we're good.
        if (_runAwayTask != null && !_runAwayTask.isFinished(mod)) {
            setTask(_runAwayTask);
            return _cachedLastPriority;
        } else {
            _runAwayTask = null;
        }
        // nothing left to defend against - drop the commitment so the NEXT threat is
        // answered on the tick it appears rather than after a stale hold expires.
        releaseDefenseMode();
        return 0;
    }

    private BlockPos isInsideFireAndOnFire(AltoClef mod) {
        boolean onFire = mod.getPlayer().isOnFire();
        if (!onFire) return null;
        BlockPos p = mod.getPlayer().blockPosition();
        BlockPos[] toCheck = new BlockPos[]{
                p,
                p.offset(1, 0, 0),
                p.offset(1, 0, -1),
                p.offset(0, 0, -1),
                p.offset(-1, 0, -1),
                p.offset(-1, 0, 0),
                p.offset(-1, 0, 1),
                p.offset(0, 0, 1),
                p.offset(1, 0, 1)
        };
        for (BlockPos check : toCheck) {
            Block b = mod.getWorld().getBlockState(check).getBlock();
            if (b instanceof BaseFireBlock) {
                return check;
            }
        }
        return null;
    }

    private void putOutFire(AltoClef mod, BlockPos pos) {
        Optional<Rotation> reach = LookHelper.getReach(pos);
        if (reach.isPresent()) {
            Baritone b = mod.getClientBaritone();
            if (LookHelper.isLookingAt(mod, pos)) {
                b.getPathingBehavior().requestPause();
                b.getInputOverrideHandler().setInputForceState(Input.CLICK_LEFT, true);
                return;
            }
            LookHelper.lookAt(mod, reach.get());
        }
    }

    private void doForceField(AltoClef mod) {

        _killAura.tickStart();

        // Hit all hostiles close to us.
        List<Entity> entities = mod.getEntityTracker().getCloseEntities();
        try {
            if (!entities.isEmpty()) {
                for (Entity entity : entities) {
                    boolean shouldForce = false;
                    if (mod.getBehaviour().shouldExcludeFromForcefield(entity)) continue;
                    if (entity instanceof Mob) {
                        if (EntityHelper.isGenerallyHostileToPlayer(mod, entity)) {
                            if (LookHelper.seesPlayer(entity, mod.getPlayer(), 10)) {
                                shouldForce = true;
                            }
                        }
                    } else if (entity instanceof LargeFireball) {
                        // Ghast ball
                        shouldForce = true;
                    } else if (entity instanceof Player player && mod.getBehaviour().shouldForceFieldPlayers()) {
                        if (!player.equals(mod.getPlayer())) {
                            String name = player.getName().getString();
                            if (!mod.getButler().isUserAuthorized(name)) {
                                shouldForce = true;
                            }
                        }
                    }
                    if (shouldForce) {
                        applyForceField(entity);
                    }
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
        _killAura.tickEnd(mod);
    }

    private void applyForceField(Entity entity) {
        _killAura.applyAura(entity);
    }

    private Creeper getClosestFusingCreeper(AltoClef mod) {
        double worstSafety = Float.POSITIVE_INFINITY;
        Creeper target = null;
        try {
            List<Creeper> creepers = mod.getEntityTracker().getTrackedEntities(Creeper.class);
            if (!creepers.isEmpty()) {
                for (Creeper creeper : creepers) {
                    if (creeper == null) continue;
                    if (creeper.getSwelling(1) < 0.001) continue;

                    // We want to pick the closest creeper, but FIRST pick creepers about to blow
                    // At max fuse, the cost goes to basically zero.
                    double safety = getCreeperSafety(mod.getPlayer().position(), creeper);
                    if (safety < worstSafety) {
                        target = creeper;
                    }
                }
            }
        } catch (ConcurrentModificationException | ArrayIndexOutOfBoundsException | NullPointerException e) {
            // IDK why but these exceptions happen sometimes. It's extremely bizarre and I have no idea why.
            Debug.logWarning("Weird Exception caught and ignored while scanning for creepers: " + e.getMessage());
            return target;
        }
        return target;
    }

    private boolean isProjectileClose(AltoClef mod) {
        List<CachedProjectile> projectiles = mod.getEntityTracker().getProjectiles();
        try {
            if (!projectiles.isEmpty()) {
                for (CachedProjectile projectile : projectiles) {
                    if (projectile.position.distanceToSqr(mod.getPlayer().position()) < 150) {
                        boolean isGhastBall = projectile.projectileType == LargeFireball.class;
                        if (isGhastBall) {
                            Optional<Entity> ghastBall = mod.getEntityTracker().getClosestEntity(LargeFireball.class);
                            Optional<Entity> ghast = mod.getEntityTracker().getClosestEntity(Ghast.class);
                            if (ghastBall.isPresent() && ghast.isPresent() && _runAwayTask == null
                                    && mod.getClientBaritone().getPathingBehavior().isSafeToCancel()) {
                                mod.getClientBaritone().getPathingBehavior().requestPause();
                                LookHelper.lookAt(mod, ghast.get().getEyePosition());
                            }
                            return false;
                            // Ignore ghast balls
                        }
                        if (projectile.projectileType == DragonFireball.class) {
                            // Ignore dragon fireballs
                            return false;
                        }
                        if (projectile.projectileType == Arrow.class || projectile.projectileType == SpectralArrow.class || projectile.projectileType == SmallFireball.class) {
                            // check if the velocity of the projectile is going away from us
                            // oh no fancy math
                            Vec3 velocity = projectile.velocity;
                            Vec3 delta = mod.getPlayer().position().subtract(projectile.position);
                            double epsilon = 0.25;
                            if (abs(velocity.dot(delta)) <= epsilon) {
                                // Arrow is going away from us, ignore it.
                                continue;
                            }
                        }

                        Vec3 expectedHit = ProjectileHelper.calculateArrowClosestApproach(projectile, mod.getPlayer());

                        Vec3 delta = mod.getPlayer().position().subtract(expectedHit);

                        //Debug.logMessage("EXPECTED HIT OFFSET: " + delta + " ( " + projectile.gravity + ")");

                        double horizontalDistanceSq = delta.x * delta.x + delta.z * delta.z;
                        double verticalDistance = abs(delta.y);
                        if (horizontalDistanceSq < ARROW_KEEP_DISTANCE_HORIZONTAL * ARROW_KEEP_DISTANCE_HORIZONTAL && verticalDistance < ARROW_KEEP_DISTANCE_VERTICAL) {
                            if (_runAwayTask == null && mod.getClientBaritone().getPathingBehavior().isSafeToCancel()) {
                                mod.getClientBaritone().getPathingBehavior().requestPause();
                                LookHelper.lookAt(mod, projectile.position);
                            }
                            return true;
                        }
                    }
                }
            }
        } catch (ConcurrentModificationException ignored) {
        }
        return false;
    }

    private Optional<Entity> getUniversallyDangerousMob(AltoClef mod) {
        // Wither skeletons are dangerous because of the wither effect. Oof kinda obvious.
        // If we merely force field them, we will run into them and get the wither effect which will kill us.
        Optional<Entity> warden = mod.getEntityTracker().getClosestEntity(Warden.class);
        if (warden.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (warden.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, warden.get())) {
                return warden;
            }
        }
        Optional<Entity> wither = mod.getEntityTracker().getClosestEntity(WitherBoss.class);
        if (wither.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (wither.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, wither.get())) {
                return wither;
            }
        }
        Optional<Entity> witherSkeleton = mod.getEntityTracker().getClosestEntity(WitherSkeleton.class);
        if (witherSkeleton.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (witherSkeleton.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, witherSkeleton.get())) {
                return witherSkeleton;
            }
        }
        // Hoglins are dangerous because we can't push them with the force field.
        // If we merely force field them and stand still our health will slowly be chipped away until we die
        Optional<Entity> hoglin = mod.getEntityTracker().getClosestEntity(Hoglin.class);
        if (hoglin.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (hoglin.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, hoglin.get())) {
                return hoglin;
            }
        }
        Optional<Entity> zoglin = mod.getEntityTracker().getClosestEntity(Zoglin.class);
        if (zoglin.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (zoglin.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, zoglin.get())) {
                return zoglin;
            }
        }
        Optional<Entity> piglinBrute = mod.getEntityTracker().getClosestEntity(PiglinBrute.class);
        if (piglinBrute.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (piglinBrute.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, piglinBrute.get())) {
                return piglinBrute;
            }
        }
        Optional<Entity> vindicator = mod.getEntityTracker().getClosestEntity(Vindicator.class);
        if (vindicator.isPresent()) {
            double range = SAFE_KEEP_DISTANCE - 2;
            if (vindicator.get().distanceToSqr(mod.getPlayer()) < range * range && EntityHelper.isAngryAtPlayer(mod, vindicator.get())) {
                return vindicator;
            }
        }
        return Optional.empty();
    }

    private boolean isInDanger(AltoClef mod) {
        Optional<Entity> witch = mod.getEntityTracker().getClosestEntity(Witch.class);
        boolean hasFood = mod.getFoodChain().hasFood();
        float health = mod.getPlayer().getHealth();
        if (health <= 10 && hasFood && witch.isEmpty()) {
            return true;
        }
        if (mod.getPlayer().hasEffect(MobEffects.WITHER) ||
                (mod.getPlayer().hasEffect(MobEffects.POISON) && witch.isEmpty())) {
            return true;
        }
        if (isVulnurable(mod)) {
            // if hostile mobs are nearby...
            // already running away? then stay in danger until they are properly far, so the
            // chain does not release the instant the mob steps outside 8 blocks and drag the
            // whole user task tree through a stop/start cycle.
            double keepDistance = _runAwayTask != null ? DISENGAGE_KEEP_DISTANCE : SAFE_KEEP_DISTANCE;
            try {
                LocalPlayer player = mod.getPlayer();
                List<Entity> hostiles = mod.getEntityTracker().getHostiles();
                if (!hostiles.isEmpty()) {
                    synchronized (BaritoneHelper.MINECRAFT_LOCK) {
                        for (Entity entity : hostiles) {
                            if (entity.closerThan(player, keepDistance) && !mod.getBehaviour().shouldExcludeFromForcefield(entity) && EntityHelper.isAngryAtPlayer(mod, entity)) {
                                return true;
                            }
                        }
                    }
                }
            } catch (Exception e) {
                Debug.logWarning("Weird multithread exception. Will fix later.");
            }
        }
        return false;
    }

    // mobs that punish running away, because they hit you from further than you can
    // hit back (or explode). fleeing these is correct; fleeing a zombie is not.
    private boolean outrangesUs(Entity e) {
        return e instanceof AbstractSkeleton || e instanceof Witch
            || e instanceof Pillager || e instanceof Creeper;
    }

    // COMMIT TO THE FIGHT.
    // isVulnurable() is `armor < 5 && health < 18`, which for a bot with no armour is
    // true after ONE HIT. so from first blood the panic flee (70) outranks the decision
    // to fight (65): she swings once, turns, and a melee mob follows her and beats her
    // to death from behind. a fresh spawn owns no armour, so that is the NORMAL case.
    // if the entire threat is one ordinary melee mob and she can still take a few hits,
    // stand and finish it.
    private boolean shouldStandAndFight(AltoClef mod) {
        if (mod.getPlayer().getHealth() <= STAND_AND_FIGHT_MIN_HEALTH) return false;
        int close = 0;
        try {
            synchronized (BaritoneHelper.MINECRAFT_LOCK) {
                for (Entity h : mod.getEntityTracker().getHostiles()) {
                    if (!h.closerThan(mod.getPlayer(), SAFE_KEEP_DISTANCE)) continue;
                    if (!EntityHelper.isAngryAtPlayer(mod, h)) continue;
                    if (outrangesUs(h)) return false;   // running IS right against these
                    if (++close > 1) return false;      // a crowd is not a fight
                }
            }
        } catch (Exception e) {
            return false;
        }
        return close == 1;
    }

    private boolean isVulnurable(AltoClef mod) {
        int armor = mod.getPlayer().getArmorValue();
        float health = mod.getPlayer().getHealth();
        if (armor <= 15 && health < 3) return true;
        if (armor < 10 && health < 10) return true;
        return armor < 5 && health < 18;
    }

    public void setTargetEntity(Entity entity) {
        _targetEntity = entity;
    }

    public void resetTargetEntity() {
        _targetEntity = null;
    }

    public void setForceFieldRange(double range) {
        _killAura.setRange(range);
    }

    public void resetForceField() {
        _killAura.setRange(Double.POSITIVE_INFINITY);
    }

    public boolean isDoingAcrobatics() {
        return _doingFunkyStuff;
    }

    public boolean isPuttingOutFire() {
        return _wasPuttingOutFire;
    }

    @Override
    public boolean isActive() {
        // We're always checking for mobs
        return true;
    }

    @Override
    protected void onTaskFinish(AltoClef mod) {
        // Task is done, so I guess we move on?
    }

    @Override
    public String getName() {
        return "Mob Defense";
    }
}