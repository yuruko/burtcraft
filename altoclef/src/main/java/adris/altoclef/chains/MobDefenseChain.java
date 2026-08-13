package adris.altoclef.chains;

import adris.altoclef.AltoClef;
import adris.altoclef.Debug;
import adris.altoclef.control.KillAura;
import adris.altoclef.external.ExternalControlServer;
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
import adris.altoclef.util.helpers.CombatGear;
import adris.altoclef.tasks.entity.BowCombatTask;
import net.minecraft.world.entity.projectile.throwableitemprojectile.AbstractThrownPotion;

public class MobDefenseChain extends SingleTaskChain {
    private static final double DANGER_KEEP_DISTANCE = 30;
    private static final double CREEPER_KEEP_DISTANCE = 10;
    private static final double ARROW_KEEP_DISTANCE_HORIZONTAL = 2;//4;
    private static final double ARROW_KEEP_DISTANCE_VERTICAL = 10;//15;
    private static final double SAFE_KEEP_DISTANCE = 8;
    // Include ranged mobs and the rest of a nearby pack in one risk decision. A fight
    // is not "one zombie" when two skeletons just outside melee range are also shooting.
    private static final double COMBAT_RISK_DISTANCE = 16;
    // Survival gets a margin instead of accepting a fight whose estimated cost exactly
    // equals our equipment score. Baritone is not a perfect duelist.
    private static final double COMBAT_SAFETY_MARGIN = 1.25;
    // hysteresis: engage at SAFE_KEEP_DISTANCE, disengage only past this.
    // TaskRunner re-picks the highest-priority chain EVERY tick and calls onInterrupt on
    // the loser, and Task.stop() sets _first = true all the way down the sub-task tree. so
    // a single flicker of "angry hostile within 8 blocks" tears the ENTIRE user task tree
    // down and rebuilds it, which ends in a fresh baritone path calculation (~2s). flapping
    // faster than that means she never finishes pathing, never moves, and stands in place
    // until something kills her. holding the engagement until the danger is actually gone
    // is what stops the teardown/rebuild cycle.
    private static final double DISENGAGE_KEEP_DISTANCE = 16;
    /**
     * How many separate escapes inside FLEE_CHURN_WINDOW_MS mean running is not
     * working. See fightBecauseFleeingIsNotWorking. TWO, not the original four: a
     * second escape from the same thing already IS the treadmill, and four of them
     * cost about forty seconds of on-stream running before she was allowed to swing
     * at one pillager (2026-08-06). A flee that works is still only ever one flee -
     * the count reaches two precisely when the first one did not work.
     */
    private static final int FLEE_CHURN_LIMIT = 2;
    private static final long FLEE_CHURN_WINDOW_MS = 90_000L;
    /** Below this, running is the right answer however badly it is going. */
    private static final float FLEE_CHURN_MIN_HEALTH = 7;
    /** A crowd is a real reason to run; this only overrules running from a few. */
    private static final int FLEE_CHURN_MAX_MOBS = 2;
    /**
     * How long a committed kill may hold the chain before we admit it is not
     * happening and give her real work the tick back. Generous - crossing
     * COMBAT_RISK_DISTANCE and killing an ordinary mob is a handful of seconds, so
     * anything approaching this is a fight that has gone wrong - but bounded,
     * because a mob she can never reach must not own the chain all night.
     */
    private static final double FIGHT_HOLD_SECONDS = 30;
    /**
     * How far the committed target may drift before the fight is declared over.
     *
     * MUST EXCEED THE RANGE THE FIGHT WAS PICKED AT (DISENGAGE_KEEP_DISTANCE). It
     * used to be COMBAT_RISK_DISTANCE, which is the same 16 - so a skeleton chosen
     * at 15.9 blocks failed the hold the instant it drifted to 16.1, and the whole
     * commitment lasted one tick. A latch whose release threshold equals its
     * trigger threshold is not a latch; it is a coin flip on sensor noise.
     */
    private static final double FIGHT_HOLD_DISTANCE = 24;
    // below this, running really is the right call even from one zombie
    private static final float STAND_AND_FIGHT_MIN_HEALTH = 8;
    // ---- ranged combat (see shouldFightAtRange / BowCombatTask) ----
    // committing to a bow fight on the last arrow means running dry mid-engagement and
    // falling back to melee anyway, having spent the opening trading shots she cannot make.
    private static final int RANGED_MIN_ARROWS = 4;
    // already this close: hit it. backing up to draw while something swings at her is
    // strictly worse than swinging back.
    private static final double RANGED_CONTACT_DISTANCE = 4;
    // an arrow does full damage whatever is in her hand, so below a real weapon's worth
    // of melee damage the bow is simply the better attack. a stone sword is 4.
    private static final double RANGED_WEAK_MELEE_DAMAGE = 4;
    // how long a chosen defensive answer is held before a sibling answer may replace
    // it. must comfortably exceed a baritone path calculation (~1s at these ranges)
    // or the answer never gets far enough to be one. see commitTo().
    private static final double DEFENSE_COMMIT_SECONDS = 2.5;
    // once anything real happens, defense HOLDS the chain for at least this long past
    // the last sign of trouble. see the engagement latch at the end of getPriorityInner.
    private static final double ENGAGEMENT_RELEASE_SECONDS = 5;
    // beats UserTaskChain's flat 50 and nothing else. deliberately NOT 60: WorldSurvival
    // uses 60 for the portal-stuck shimmy and MLG uses it mid-bucket, TaskRunner breaks
    // ties by insertion order, and this chain is registered before both - so a tie here
    // would silently outrank being stuck in a nether portal. the real answers (65-80)
    // still win whenever they fire.
    private static final float ENGAGED_PRIORITY = 58;
    // a hit landing this recently still counts as "something is attacking me".
    private static final double RECENT_DAMAGE_SECONDS = 4;
    // a hostile seen this recently still counts as present, even if the line-of-sight
    // raycast fails on this particular tick.
    private static final int LOS_GRACE_TICKS = 60;
    // engaged, something in reach, and this long without actually moving = frozen,
    // whatever the task tree believes. panicTick() then takes the controls.
    private static final double FROZEN_SECONDS = 1.5;
    // ...and this long without moving overrides even "baritone says it is pathing".
    // deliberately longer than a block break with a sane tool (stone with a stone pick is
    // ~1.15s) so the watchdog does not fight baritone digging its way out of a hillside,
    // and far shorter than dying: she stood still for 47 seconds on 2026-08-04.
    private static final double FROZEN_HARD_SECONDS = 3.5;
    private static final double FROZEN_MOVE_EPSILON = 0.9;
    private static final double PANIC_TRIGGER_DISTANCE = 7;
    private static final double PANIC_HOLD_SECONDS = 1.2;
    // (the old hardcoded SWORDS[] ladder lived here. It is gone on purpose: it was the
    // reason a netherite AXE - which hits harder than the netherite sword - scored as
    // bare hands and turned winnable fights into retreats. Ask CombatGear instead, which
    // reads the game's own WEAPON marker, so the answer does not need a literal list
    // somebody has to remember to extend.)
    private static boolean _shielding = false;
    private final DragonBreathTracker _dragonBreathTracker = new DragonBreathTracker();
    private final KillAura _killAura = new KillAura();
    private final HashMap<Entity, TimerGame> _closeAnnoyingEntities = new HashMap<>();
    private Entity _targetEntity;
    private boolean _doingFunkyStuff = false;
    private boolean _wasPuttingOutFire = false;
    private CustomBaritoneGoalTask _runAwayTask;
    /** Start times of recent escapes, pruned to FLEE_CHURN_WINDOW_MS. */
    private final java.util.ArrayDeque<Long> _fleeEpisodes = new java.util.ArrayDeque<>();
    /**
     * The mob she actually said she would kill - the ENTITY, not just its class, so
     * the commitment can be checked against something that can die and walk away.
     * See fightStillStands.
     */
    private Entity _fightTargetEntity;
    private final TimerGame _fightHold = new TimerGame(FIGHT_HOLD_SECONDS);
    /** True while the anti-treadmill override is deliberately standing its ground. */
    private boolean _fightingItOut = false;
    /**
     * THE LEDGER MUST NOT COUNT THE REBOUNDS THE LEDGER CAUSED.
     *
     * installKill() puts a KillEntitiesTask in the chain slot. beginOrAdoptFlee()
     * decides "is this a new escape?" by looking at what is IN that slot - so the
     * very next flee, which exists only because the override's own kill task was
     * torn down, failed the adopt test and was recorded as fresh evidence that
     * running is not working. Each fight/flee round trip therefore added one
     * episode, escapes could never fall back under FLEE_CHURN_LIMIT, and the
     * override re-fired forever. Observed live on 2026-08-08 as
     * "running from Skeleton isn't working (N escapes)" with N climbing 2 -> 14
     * monotonically in about five seconds, at roughly 2Hz.
     *
     * So once the override has fired, subsequent escapes from the same episode-set
     * are REBOUNDS, not independent evidence, and are not counted. This latch
     * outlives _fightingItOut deliberately: _fightingItOut drops on the flicker
     * that starts the rebound, which is precisely when the miscount happened.
     */
    private boolean _overrideEngaged = false;

    /**
     * MELEE OR BOW, DECIDED ONCE PER TARGET AND THEN LEFT ALONE.
     * <p>
     * The decision inputs (distance, arrow count, line of sight) all move constantly, so
     * re-asking every tick would swap the task in the chain slot at roughly the tick rate
     * - which is the precise mechanism behind every freeze in this file's history. It is
     * therefore latched when {@link #rememberFightTarget} sees a genuinely NEW target,
     * and it is a ONE-WAY DOOR: ranged may fall back to melee (out of arrows, cannot line
     * the shot up), melee never escalates to ranged mid-fight. A two-way door between two
     * answers to the same question is the ping-pong, by construction.
     */
    private boolean _rangedEngagement = false;
    /**
     * The live bow task, kept so the fight branch can notice it has given up.
     * <p>
     * ⚠ this reference is load-bearing, not a convenience. SingleTaskChain neither ticks
     * nor clears a FINISHED task, and setTask() is a no-op against an .equals() twin - so
     * a bow task that ran out of arrows would sit in the slot forever while the chain
     * held priority 65 and she stood still. That is the 2026-08-02 corpse-in-the-slot
     * freeze wearing a new hat.
     */
    private BowCombatTask _bowTask;
    /** true while she still has gear in the bag she has not managed to put on yet. */
    private boolean _gearingUp = false;
    /**
     * "I would win this if I were wearing what I am carrying" - COMPUTED ON THE TICK
     * THREAD, read by the companion poll.
     * <p>
     * ⚠ THE COMPANION POLL IS ITS OWN THREAD ("altoclef-state-poll", a 2s scheduled
     * executor), NOT the client tick. The first version of the combat readout had the
     * getter call combatThreats() -> threats() live, which WRITES the tick-keyed scan
     * cache (_threatScanTick then _threatScan). Landing on the same tick number as the
     * task runner hands the tick thread a list the poll thread is still appending to, and
     * a ConcurrentModificationException escaping getPriority() takes down
     * TaskRunner.tick() for EVERY chain - the exact hazard the comment inside threats()
     * already warns about. So the verdict is computed where the fight is decided and
     * merely READ across the thread boundary. volatile for publication.
     */
    private volatile boolean _couldWinIfGeared = false;

    private float _cachedLastPriority;

    // the answers this chain can give. they are SIBLINGS inside ONE chain, so
    // TaskChain priority arbitrates none of them against each other - see commitTo().
    private enum DefenseMode {NONE, DODGE, FIGHT, FLEE}

    private DefenseMode _defenseMode = DefenseMode.NONE;
    private final TimerGame _defenseCommitment = new TimerGame(DEFENSE_COMMIT_SECONDS);
    private Class<?> _committedFightTarget;

    // engagement latch - "am i in a fight", held across the flicker of every predicate
    // below. see the block at the end of getPriorityInner.
    private boolean _engaged = false;
    private final TimerGame _engagementRelease = new TimerGame(ENGAGEMENT_RELEASE_SECONDS);
    private final TimerGame _sinceDamage = new TimerGame(RECENT_DAMAGE_SECONDS);
    private float _lastHealth = -1;
    // anti-freeze watchdog state
    private final TimerGame _stillTimer = new TimerGame(FROZEN_SECONDS);
    private final TimerGame _hardStillTimer = new TimerGame(FROZEN_HARD_SECONDS);
    private final TimerGame _panicCommitment = new TimerGame(PANIC_HOLD_SECONDS);
    private Vec3 _lastStillPos;
    private final Set<Input> _panicHeld = new HashSet<>();
    // STATIC so the movement tasks can see it. CustomBaritoneGoalTask releases
    // MOVE_FORWARD/MOVE_BACK/SNEAK on every tick baritone claims to be pathing, and
    // TaskRunner computes chain priorities (where panicTick runs) BEFORE it ticks the
    // winning chain's task - so without this the task would quietly undo the rescue keys
    // one tick after they were pressed, on exactly the freeze this watchdog now catches:
    // pathing, but not actually moving.
    private static boolean _panicDriving = false;
    // when each hostile was last actually SEEN close, for the line-of-sight grace period
    private final HashMap<Entity, Integer> _lastCloseTick = new HashMap<>();
    // one loose threat scan per tick, shared by every caller. see threats().
    private int _threatScanTick = -1;
    private List<Entity> _threatScan = new ArrayList<>();

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
        // An incoming arrow is too transient to tear down a live combat path. The
        // dodge goal is commonly already satisfied by the time it gets its first tick;
        // replacing FIGHT with it only cancels pathing and then rebuilds the same fight.
        if (_defenseMode == DefenseMode.FIGHT && mode == DefenseMode.DODGE
                && !currentTaskDone(mod)) {
            return false;
        }
        // Finish an escape before turning around to fight. Otherwise the strict hostile
        // count briefly shrinking swaps FLEE -> FIGHT every commitment interval.
        if (_defenseMode == DefenseMode.FLEE && mode == DefenseMode.FIGHT
                && !currentTaskDone(mod)) {
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

    /**
     * Start a flee, or ADOPT the one already running - never mint a twin of it.
     * <p>
     * commitTo() returns true the instant the mode already matches, so the FLEE branches
     * ran `_runAwayTask = new RunAwayFromHostilesTask(...); setTask(_runAwayTask)` on
     * EVERY tick of an escape. SingleTaskChain.setTask() then discarded the newcomer -
     * it is a no-op whenever the replacement .equals() the incumbent, and
     * RunAwayFromHostilesTask.isEqual calls any two runs of the same distance equal - so
     * _mainTask kept the original while _runAwayTask pointed at an orphan that was never
     * started and never ticked.
     * <p>
     * That split matters because the chain then asks the ORPHAN whether the escape is
     * over (the `_runAwayTask != null && !_runAwayTask.isFinished(mod)` gate below), and
     * a goal task builds its goal lazily inside isFinished(). Until that lazy build
     * stopped force-cancelling baritone, this was a dead path calculation per tick; it is
     * now merely a wasted allocation and a lie about which task is running. Keeping the
     * two references identical costs nothing and removes the whole class.
     */
    private void beginOrAdoptFlee(AltoClef mod) {
        // adopt only a LIVE one. a finished flee left in the slot is the 2026-08-02
        // corpse freeze: SingleTaskChain neither ticks nor clears a finished task, it
        // just calls onTaskFinish, while isActive() is hardcoded true - so the chain
        // keeps winning ticks and running nothing. we can reach that state honestly by
        // losing a tick to a higher chain (MLG, WorldSurvival) before onTaskFinish ran.
        if (getCurrentTask() instanceof RunAwayFromHostilesTask running
                && !running.stopped() && !running.isFinished(mod)) {
            _runAwayTask = running;
            return;
        }
        // clear FIRST. setTask() is a no-op whenever the replacement .equals() the
        // incumbent, and isEqual calls any two runs of the same distance equal - so
        // handing it a fresh flee while a finished one occupies the slot changes
        // precisely nothing, and the corpse keeps the seat.
        setTask(null);
        _runAwayTask = new RunAwayFromHostilesTask(DANGER_KEEP_DISTANCE, true);
        setTask(_runAwayTask);
        // only a genuinely NEW escape is an episode - an adopted one is the same
        // run continuing, and counting it would trip the churn rule on one flee.
        //
        // and a REBOUND is not new either. once the override has taken the fight,
        // the flee that follows it exists because the override's kill task was
        // displaced from this slot, not because running failed again. counting it
        // is what let the ledger feed itself. see _overrideEngaged.
        if (!_overrideEngaged) noteFleeEpisode();
    }

    /** Remember that she started running, so it can be judged on whether it worked. */
    private void noteFleeEpisode() {
        _fleeEpisodes.addLast(System.currentTimeMillis());
        recentFleeCount();
    }

    /**
     * Escapes inside the window. Prunes on READ as well as on write - pruning only
     * when a new episode arrives would let three escapes from an hour ago sit in
     * the deque and make the next single flee look like a treadmill.
     */
    private int recentFleeCount() {
        long now = System.currentTimeMillis();
        while (!_fleeEpisodes.isEmpty() && now - _fleeEpisodes.peekFirst() > FLEE_CHURN_WINDOW_MS) {
            _fleeEpisodes.removeFirst();
        }
        return _fleeEpisodes.size();
    }

    /**
     * SHE HAS RUN FROM THIS THING FOUR TIMES AND IT IS STILL THERE.
     *
     * Fleeing is correct in the small and can still be a treadmill in the large.
     * The escape ends at DANGER_KEEP_DISTANCE and the chain releases at
     * DISENGAGE_KEEP_DISTANCE - and then her real task walks her straight back to
     * whatever she was building, which is exactly where the mob is. Neither half
     * is wrong on its own. Together they are: flee, resume, get shot, flee.
     * Watched live as "nigerundayoo" &lt;-&gt; "walking_to_quarry" every three
     * seconds against ONE skeleton.
     *
     * So running gets judged on whether it worked. When it plainly has not, take
     * the fight instead. Note this deliberately does NOT ask canSafelyFight: that
     * is what said no and started the treadmill, and an unarmoured burnt beats one
     * skeleton far more often than she beats an infinite loop. The guards that
     * remain are the ones where fighting is genuinely the wrong answer - a
     * creeper, a warden-class mob, a crowd, or being nearly dead.
     */
    private Task fightBecauseFleeingIsNotWorking(AltoClef mod) {
        // THE DECISION HAS TO OUTLIVE THE TICK THAT MADE IT.
        //
        // the first version cleared _fleeEpisodes right here, and that destroyed the
        // only evidence the override rests on: one tick later recentFleeCount() was 0,
        // this method declined, and the `overmatched` arm below forceMode(FLEE)'d the
        // kill task straight back off her. on 2026-08-06 that read, in the log, as
        // "killing it instead" and a fresh nigerundayoo IN THE SAME SECOND - three
        // times, against one pillager, which lived through all of it. so the ledger
        // stays put and the decision gets a latch of its own.
        if (_fightingItOut) {
            // the crowd test gets the same hysteresis the distance test does: entry
            // refuses at > FLEE_CHURN_MAX_MOBS, so survival must tolerate one more or
            // a mob drifting in and out of combatThreats() drops the commitment on
            // exactly the boundary that granted it.
            if (mod.getPlayer().getHealth() > FLEE_CHURN_MIN_HEALTH
                    && combatThreats(mod, _fightTargetEntity).size() <= FLEE_CHURN_MAX_MOBS + 1
                    && fightStillStands(mod)) {
                Task running = getCurrentTask();
                if (running != null && !running.stopped()) return running;
                return installKill(mod, _fightTargetEntity);
            }
            _fightingItOut = false;
            // ⚠⚠ CLEAR IT ON EVERY EXIT, NOT ONLY WHEN THE TARGET IS GONE.
            //
            // There are two ways out of the commitment and they both end the
            // override, but only one of them used to say so. If it died or left,
            // running is no longer failing. If instead FIGHT_HOLD_SECONDS simply
            // elapsed with the mob still alive, the override TRIED and DID NOT
            // WORK - and leaving the ledger up meant `escapes` was still over the
            // limit two lines below, so the override re-fired on the very same
            // tick. Worse, commitToKilling then sees the mode is already FIGHT, so
            // it neither clears the target nor resets the hold, while installKill
            // does setTask(null) + setTask(new KillEntitiesTask) - tearing down and
            // rebuilding the whole task tree, cancelling baritone, 20 times a
            // second, until the 90s flee window ages out. That is the 2026-08-08
            // freeze signature with N pinned instead of climbing: standing still in
            // a crowd, logging "killing it instead" on every tick.
            //
            // Dropping the ledger here makes the failed override a bounded attempt:
            // she goes back to running, and if running keeps failing the count
            // rebuilds and she commits again - later, once, instead of forever.
            clearFleeLedger();
        }
        int escapes = recentFleeCount();
        if (escapes < FLEE_CHURN_LIMIT) return null;
        // at death's door running really is right, however badly it is going.
        if (mod.getPlayer().getHealth() <= FLEE_CHURN_MIN_HEALTH) return null;
        Entity threat = nearestThreat(mod, DISENGAGE_KEEP_DISTANCE);
        if (threat == null) return null;
        if (threat instanceof Creeper || isScaryToPickAFightWith(threat)) return null;
        // a crowd is a real reason to run, and running from it is not the failure
        // this is here to break.
        if (combatThreats(mod, threat).size() > FLEE_CHURN_MAX_MOBS) return null;
        Debug.logMessage("running from " + threat.getClass().getSimpleName()
            + " isn't working (" + escapes + " escapes); killing it instead");
        _fightingItOut = true;
        _overrideEngaged = true;
        return installKill(mod, threat);
    }

    /**
     * Drop the escape ledger AND the rebound latch together.
     *
     * They describe one situation - "running from this thing is not working" - so
     * one may never outlive the other. Keeping the ledger while clearing the latch
     * re-arms the override on stale evidence; clearing the ledger while keeping the
     * latch makes the next genuine treadmill invisible.
     */
    private void clearFleeLedger() {
        _fleeEpisodes.clear();
        _overrideEngaged = false;
    }

    /**
     * SHE SAID SHE WOULD KILL THIS THING, SO SHE IS STILL IN A FIGHT.
     * <p>
     * The engagement latch holds the chain for a threat within SAFE_KEEP_DISTANCE (8),
     * and that range was chosen so a zombie loitering sixteen blocks away could not
     * pin her all night. But the branch that DECIDES to fight uses a 15-block range
     * for ranged mobs - a skeleton, pillager, witch or piglin - so she would commit
     * to killing something at 15, and then on the very next tick fail the latch's
     * 8-block test the instant EntityTracker's aggression flag or line-of-sight
     * raycast blinked. The chain then dropped to 0, UserTaskChain (50) took the tick
     * back, and she turned around and walked two hundred blocks toward a furnace with
     * a crossbow pointed at her.
     * <p>
     * Live on 2026-08-06 that was thirty-six aborted kills on ONE pillager in two
     * minutes, at about 1Hz, each one a full task-tree teardown and a fresh baritone
     * path. Every ranged mob in the game was unkillable by construction: the range at
     * which she picks a fight was longer than the range at which she is allowed to
     * still be in one.
     * <p>
     * So a fight is a COMMITMENT, like fleeing already was. It holds until the target
     * is dead, has left COMBAT_RISK_DISTANCE, or FIGHT_HOLD_SECONDS says it is plainly
     * not happening - and not one tick less.
     */
    private boolean fightStillStands(AltoClef mod) {
        if (_defenseMode != DefenseMode.FIGHT) return false;
        if (_fightTargetEntity == null || !_fightTargetEntity.isAlive()) return false;
        if (_fightHold.elapsed()) return false;
        double distanceSq = _fightTargetEntity.distanceToSqr(mod.getPlayer());
        return distanceSq <= FIGHT_HOLD_DISTANCE * FIGHT_HOLD_DISTANCE;
    }

    /**
     * Point every piece of fight state at ONE mob and hand back the task that kills
     * it. Does not install the task: callers differ on whether they already own the
     * slot, and defaultAnswer's caller installs it itself.
     */
    private Task commitToKilling(AltoClef mod, Entity target) {
        if (target == null) return null;
        forceMode(DefenseMode.FIGHT);   // clears the old target, so remember AFTER it
        _runAwayTask = null;
        rememberFightTarget(mod, target);
        return attackTaskFor(mod, target);
    }

    /**
     * The task that actually fights the chosen target - bow or blade.
     * <p>
     * ⚠ reads the LATCHED {@link #_rangedEngagement}, never re-deciding: this is called
     * on every tick of a live fight (the branch re-mints its task each tick and relies on
     * setTask() discarding the .equals() twin), so a per-call decision would swap the
     * chain's task at tick rate.
     * <p>
     * ⚠ a bow task that has given up must NOT be handed back. SingleTaskChain neither
     * ticks nor clears a finished task, and setTask() refuses an equal replacement, so it
     * would hold the slot forever while the chain kept priority 65 - she would stand
     * still, out of arrows, "in a fight". Falling back to melee is one-way and permanent
     * for this target.
     * <p>
     * ⚠ THERE IS DELIBERATELY NO "the mob got close, switch to melee" RULE HERE, and it
     * looks like an omission twice over. Both cases that would want one are already
     * covered, and adding it would break the case ranged exists for:
     * <ul>
     *   <li>the anti-treadmill override (fightBecauseFleeingIsNotWorking) reaches this
     *       through commitToKilling, which calls forceMode(FIGHT) FIRST - and that clears
     *       the latch, so rememberFightTarget re-asks shouldFightAtRange, which already
     *       answers "no" inside RANGED_CONTACT_DISTANCE. The override gets a fresh,
     *       correct decision without any help from here.</li>
     *   <li>a mob closing on a live ranged fight is KITING, not a mistake: BowCombatTask
     *       opens the range and keeps shooting, and ENGAGEMENT_MAX_SECONDS bounds it if
     *       that stops working.</li>
     * </ul>
     * A contact-range drop would fire at exactly the moment a CREEPER reaches her - and
     * meleeing a creeper is the single thing this whole ranged layer exists to stop.
     */
    private Task attackTaskFor(AltoClef mod, Entity target) {
        if (_rangedEngagement) {
            if (_bowTask != null && (_bowTask.gaveUp() || _bowTask.isFinished(mod))) {
                _rangedEngagement = false;
                _bowTask = null;
                // the corpse has to leave the slot or the melee task cannot get in.
                setTask(null);
                // ⚠⚠ ...BUT NOT INTO A CREEPER. The javadoc above reasons only about a
                // mob CLOSING on a live ranged fight; this is the other way out -
                // BowCombatTask gives up when the arrows RUN OUT. She had chosen the
                // bow precisely because this target must not be met with a sword, and
                // dropping through to melee here charged her straight at it. (The
                // anti-treadmill override refuses creepers too, so nothing downstream
                // would have broken the approach/swell/flee oscillation that follows.)
                // Let the commitment go instead: the flee and shield branches own a
                // creeper, and next tick they get it.
                if (target instanceof Creeper) {
                    releaseDefenseMode();
                    return null;
                }
            } else {
                if (_bowTask == null) _bowTask = new BowCombatTask(target);
                return _bowTask;
            }
        }
        return new KillEntitiesTask(target.getClass());
    }

    /** commitToKilling, for the callers that do own the slot. */
    private Task installKill(AltoClef mod, Entity target) {
        Task kill = commitToKilling(mod, target);
        if (kill == null) return null;
        // clear FIRST - setTask() is a no-op whenever the replacement .equals() the
        // incumbent, which is how a finished task keeps the seat elsewhere in this file.
        setTask(null);
        setTask(kill);
        return kill;
    }

    /**
     * Only a genuinely NEW target restarts the deadline. Re-confirming the same mob
     * every tick - which pickFightTarget does by design - must not extend the hold
     * forever, or FIGHT_HOLD_SECONDS bounds nothing at all.
     */
    private void rememberFightTarget(AltoClef mod, Entity target) {
        if (target == null) return;
        if (_fightTargetEntity != target) {
            _fightTargetEntity = target;
            _fightHold.reset();
            // A NEW TARGET IS THE ONE MOMENT THE MELEE/RANGED QUESTION IS ASKED. Asking
            // it per tick would swap the chain's task at tick rate - see _rangedEngagement.
            _rangedEngagement = shouldFightAtRange(mod, target);
            _bowTask = null;
        }
        _committedFightTarget = target.getClass();
    }

    /**
     * Is this a fight to have from across the room?
     * <p>
     * Called ONCE per target (see {@link #rememberFightTarget}), never per tick.
     * <p>
     * public because HeroTask needs the SAME answer: `@hero` is what burnt's `attack` and
     * `defend` verbs and every viewer "kill that skeleton" actually run, and if only this
     * chain knew about the bow then she could shoot reflexively but never on purpose.
     * Two copies of "is this a ranged fight" would drift, which is this codebase's
     * most-repeated bug.
     */
    public boolean shouldFightAtRange(AltoClef mod, Entity target) {
        if (target == null || !CombatGear.canShoot(mod)) return false;
        // Keep a few arrows back. Committing to a ranged fight on the last arrow means
        // running dry mid-engagement and falling back to melee anyway, having spent the
        // opening on it.
        if (CombatGear.arrowCount(mod) < RANGED_MIN_ARROWS) return false;
        double distanceSq = target.distanceToSqr(mod.getPlayer());
        // A CREEPER IS THE WHOLE POINT. Walking up to a bomb is not a plan, and every
        // other branch in this file can only run away from one - nothing could ever
        // KILL one safely. An arrow can.
        if (target instanceof Creeper) return true;
        // Already breathing on her: hit it, do not back up drawing a bow while it swings.
        if (distanceSq <= RANGED_CONTACT_DISTANCE * RANGED_CONTACT_DISTANCE) return false;
        // Things that shoot back, and things it is stupid to let reach her. A Ghast is
        // named outright because melee against one is not a fight, it is a wish.
        if (outrangesUs(target) || isScaryToPickAFightWith(target) || target instanceof Ghast) return true;
        // Under-armed for melee: an arrow does full damage no matter what is in her hand.
        return CombatGear.bestMeleeDamage(mod) < RANGED_WEAK_MELEE_DAMAGE;
    }

    private void forceMode(DefenseMode mode) {
        if (_defenseMode != mode) {
            _defenseMode = mode;
            _committedFightTarget = null;
            _fightTargetEntity = null;
            // clearing the target clears the choice made ABOUT that target. this runs
            // before rememberFightTarget on the commitToKilling path, so the new target
            // gets a fresh bow-or-blade decision rather than inheriting the last one.
            _rangedEngagement = false;
            _bowTask = null;
        }
        _defenseCommitment.reset();
    }

    private void releaseDefenseMode() {
        _defenseMode = DefenseMode.NONE;
        _committedFightTarget = null;
        _fightTargetEntity = null;
        _fightingItOut = false;
        // the ranged choice belongs to ONE target. carrying it into the next fight would
        // mean the answer to "bow or blade" was decided about a mob that is already dead.
        _rangedEngagement = false;
        _bowTask = null;
        // and the readout must not keep claiming there is a fight she could win dressed.
        _couldWinIfGeared = false;
        // the ledger is evidence about a fight that no longer has a target. leaving it
        // behind while dropping the latch is what let the override re-fire on stale
        // counts the instant this ran (it is reachable from the eat branch, the MLG
        // branch and the priority-0 fallthrough - i.e. constantly).
        clearFleeLedger();
    }

    /**
     * Pick ONE hostile to commit to, and keep picking it.
     * <p>
     * the old loop had two identical branches, so it always took toDealWith.get(0) -
     * whose order comes from the entity tracker and reorders freely. a skeleton and
     * an enderman standing together therefore swapped the kill target, and with it
     * the whole task tree, on alternate ticks. hold the target while it is alive and
     * still a problem; otherwise take the most DANGEROUS one, not merely the nearest.
     * <p>
     * ⚠ "nearest" was the whole ranking, everywhere - here, in KillAura, and in HeroTask.
     * threatWeight() has always known that a creeper is worth 2.75 zombies and a warden is
     * worth a hundred, and no targeting decision anywhere consulted it. So she would punch
     * the zombie in front of her while the creeper two blocks behind it finished swelling.
     * Ranking by threat-per-distance keeps proximity mattering (something on top of her is
     * more urgent than the same mob across the room) while letting a genuinely worse mob
     * win from further out.
     */
    private Class<?> pickFightTarget(AltoClef mod, List<Entity> toDealWith) {
        if (_committedFightTarget != null) {
            // ⚠ THE EXACT ENTITY FIRST, NOT MERELY ONE OF ITS CLASS. This loop used to
            // return the first mob whose CLASS matched, so with two skeletons in the list
            // it handed back whichever the entity tracker happened to order first - and
            // rememberFightTarget reads that as a NEW target: it resets _fightHold (so
            // FIGHT_HOLD_SECONDS never actually arrives), re-runs shouldFightAtRange, and
            // nulls _bowTask.
            //
            // That wobble was harmless while the fight task was keyed on the CLASS
            // (KillEntitiesTask), because setTask() then discarded the twin. BowCombatTask
            // is keyed on the ENTITY, so the same wobble now genuinely swaps the chain's
            // task - full sub-task teardown plus a baritone force-cancel, at tracker
            // reorder rate. Introducing the bow is what converted this into a real bug.
            if (_fightTargetEntity != null && _fightTargetEntity.isAlive()
                    && toDealWith.contains(_fightTargetEntity)) {
                rememberFightTarget(mod, _fightTargetEntity);
                return _committedFightTarget;
            }
            for (Entity e : toDealWith) {
                if (e.getClass() == _committedFightTarget && e.isAlive()) {
                    rememberFightTarget(mod, e);
                    return _committedFightTarget;
                }
            }
        }
        // ⚠⚠ RANKING BY THREAT MAKES A CREEPER THE MOST ATTRACTIVE TARGET IN THE GAME,
        // and walking a sword into a creeper is how you lose a base, not a fight. It is
        // the single highest-weight ordinary mob (2.75 and climbing as it swells), so
        // switching this ranking from distance to threat - without this guard - would
        // have actively made the creeper problem WORSE than the naive "nearest" it
        // replaced. A creeper is only a target she may CHOOSE when she can answer it from
        // range; otherwise the flee/shield branches above own it and she leaves it alone.
        // ⚠ THE GUARD AND THE DECISION MUST ASK THE SAME QUESTION. This used to be
        // bare canShoot() (a bow and >0 arrows), while shouldFightAtRange refuses
        // below RANGED_MIN_ARROWS. With 1-3 arrows the two disagreed: the creeper
        // was admitted to the ranking, won it (highest-weight ordinary mob), and
        // then shouldFightAtRange said no - so attackTaskFor handed back a MELEE
        // KillEntitiesTask and walked her into it. Admitted only if the ranged
        // answer is actually available.
        boolean mayHuntCreepers = CombatGear.canShoot(mod) && CombatGear.arrowCount(mod) >= RANGED_MIN_ARROWS;
        Entity worst = null;
        double best = Double.NEGATIVE_INFINITY;
        for (Entity e : toDealWith) {
            if (!mayHuntCreepers && e instanceof Creeper) continue;
            // +1 so a mob standing ON her does not divide by zero and swamp the ranking.
            double score = threatWeight(mod, e) / (1 + Math.sqrt(e.distanceToSqr(mod.getPlayer())));
            if (score > best) {
                best = score;
                worst = e;
            }
        }
        if (worst == null) {
            // every candidate was a creeper she has no ranged answer for. Fall back to
            // the nearest of them rather than returning null: the caller needs a class,
            // and the creeper-specific branches above are what actually keep her alive.
            double nearest = Double.POSITIVE_INFINITY;
            for (Entity e : toDealWith) {
                double d = e.distanceToSqr(mod.getPlayer());
                if (d < nearest) {
                    nearest = d;
                    worst = e;
                }
            }
        }
        rememberFightTarget(mod, worst != null ? worst : toDealWith.get(0));
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
        float priority = getPriorityInner(mod);
        // FINAL SAFETY NET.
        // this chain overrides isActive() to true, so TaskRunner hands it the tick on
        // priority alone - and SingleTaskChain neither clears nor re-runs a task once it
        // reports finished, it just calls onTaskFinish and ticks nothing. so winning the
        // tick with no task means winning it and standing perfectly still, with everything
        // below locked out. that is the entire bug class this file exists to prevent, so
        // make it unrepresentable: no answer to run, no claim on the tick.
        if (priority > 0 && priority < Float.POSITIVE_INFINITY && getCurrentTask() == null) {
            priority = 0;
        }
        _cachedLastPriority = priority;
        return priority;
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
            releasePanic(mod);
            return Float.NEGATIVE_INFINITY;
        }

        if (!mod.getModSettings().isMobDefense()) {
            releasePanic(mod);
            return Float.NEGATIVE_INFINITY;
        }

        // ---- combat bookkeeping, before any branch ----
        // TaskRunner calls getPriority() on every active chain every tick and this chain
        // is always active, so this is the one place guaranteed to see every tick whether
        // defense is winning or not.
        trackDamage(mod);

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
            releasePanic(mod);
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
            releasePanic(mod);
            releaseDefenseMode();
            return Float.NEGATIVE_INFINITY;
        }

        // Force field
        doForceField(mod);

        // last-resort anti-freeze. runs after the force field so she is already swinging,
        // and before every branch so it applies no matter which answer is running.
        panicTick(mod);


        // Tell baritone to avoid mobs if we're vulnurable.
        // Costly.
        //mod.getClientBaritoneSettings().avoidance.value = isVulnurable(mod);

        // Run away if a weird mob is close by.
        Optional<Entity> universallyDangerous = getUniversallyDangerousMob(mod);
        if (universallyDangerous.isPresent() && mod.getPlayer().getHealth() <= 10) {
            // a warden-class mob at low health outranks any commitment.
            forceMode(DefenseMode.FLEE);
            beginOrAdoptFlee(mod);
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
        // A requested kill target is permission to try, not permission to die. The old
        // `_targetEntity == null` gate disabled retreat for every explicit combat task,
        // including HeroTask, so it kept chasing while outnumbered or nearly dead.
        boolean overmatched = shouldRetreatFromCombat(mod, _targetEntity);
        boolean ordinaryDanger = isInDanger(mod) && !shouldStandAndFight(mod);
        // ...and last, because it prunes the ledger: there must be something to run FROM.
        //
        // both arms above can fire on evidence the flee task cannot see. `overmatched`
        // admits any loose species-scan mob within 16 blocks once tookDamageRecently() is
        // true, and canSafelyFight() returns false outright on poison or wither - so a
        // cave spider that poisons her and then DE-AGGROS (spiders are on the
        // isAggressive()-only branch of isGenerallyHostileToPlayer, so a calm one is
        // never in getHostiles()) drives this branch for the whole poison duration.
        // `ordinaryDanger` can fire on health <= 10 with no mob in the world at all.
        // Installing an escape then gives baritone an empty entity list, a goal already
        // satisfied where she stands, and nowhere to path - so she holds the chain at
        // priority 80 or 70, locks out her real work, and rebuilds the task every
        // ESCAPE_SETTLE_SECONDS until the poison wears off. Falling through instead lets
        // the branches below (and ultimately the latch, which declines the same way in
        // defaultAnswer) reach an answer that can actually move her.
        if ((overmatched || ordinaryDanger) && !escapeDragonBreath(mod)
                && (overmatched || !mod.getFoodChain().isShouldStop())
                && (overmatched || _targetEntity == null)
                && RunAwayFromHostilesTask.hasSomethingToFleeFrom(mod)) {
            // ...unless running has already been tried and did not work. this sits
            // above BOTH arms on purpose: the treadmill is driven by whichever one
            // happens to fire, and an override only one of them respects is not an
            // override. it declines by returning null in every case where running
            // is still the right answer, so the normal paths below are untouched.
            Task insteadOfRunning = fightBecauseFleeingIsNotWorking(mod);
            if (insteadOfRunning != null) return 75;
            // ---- RETREAT AND RE-ARM ----
            // She is running anyway; running is not a reason to still be naked when she
            // stops. Every previous version of this branch let her flee a fight she owned
            // the gear to win, because capacity is measured off WORN armour and nothing in
            // the defense path had ever put a piece on.
            //
            // ⚠ THIS IS A SLOT-FREE SIDE EFFECT, NOT A TASK, AND THAT IS THE ENTIRE
            // DESIGN. EquipArmorTask would need the task slot, which this chain is
            // currently holding at priority 70-80 for the escape - and a second contender
            // for that slot is the mechanism behind every freeze in this file's history.
            // Slot clicks are not tasks, and KillAura already equips a shield mid-fight
            // by exactly this route. Nothing about the escape changes: same task, same
            // priority, same commitment. She just arrives dressed.
            //
            // The fight branch below then flips on its own as the numbers improve - there
            // is deliberately no new "PREPARE" mode, because a new mode is a new sibling
            // for the existing three to trade the slot with.
            _gearingUp = !CombatGear.readyUp(mod, true);
            // Published for the readout, computed HERE because this runs on the TICK
            // thread. The getter must never scan entities - see _couldWinIfGeared.
            List<Entity> fleeingFrom = combatThreats(mod, _targetEntity);
            _couldWinIfGeared = !fleeingFrom.isEmpty()
                    && !canSafelyFight(mod, fleeingFrom) && couldWinIfGeared(mod, fleeingFrom);
            if (overmatched) {
                // Worsening health or a newly arrived mob is an emergency escalation;
                // do not wait out a previous fight commitment.
                if (_defenseMode != DefenseMode.FLEE) {
                    forceMode(DefenseMode.FLEE);
                }
                beginOrAdoptFlee(mod);
                return 80;
            }
            if (commitTo(mod, DefenseMode.FLEE)) {
                beginOrAdoptFlee(mod);
            }
            return 70;
        }

        if (mod.getModSettings().shouldDealWithAnnoyingHostiles()) {
            // Deal with hostiles because they are annoying.
            List<Entity> hostiles = mod.getEntityTracker().getHostiles();
            // TODO: I don't think this lock is necessary at all.

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
                        int annoyingRange = outrangesUs(hostile) ? 15 : 8;
                        boolean isClose = hostile.closerThan(mod.getPlayer(), annoyingRange);

                        if (isClose) {
                            isClose = LookHelper.seesPlayer(hostile, mod.getPlayer(), annoyingRange);
                        }

                        // LINE-OF-SIGHT GRACE.
                        // isClose ends in LookHelper.seesPlayer(), a raycast that fails the
                        // moment either of them steps behind a block, and dropping the entry
                        // right here rebuilt this whole list from nothing on the next tick.
                        // an empty toDealWith collapses the entire branch below, which used
                        // to hand the chain straight back to UserTaskChain mid-fight. keep
                        // the hostile for a moment after it was last actually seen.
                        if (isClose) {
                            _lastCloseTick.put(hostile, safeTicks());
                        }
                        Integer lastSeen = _lastCloseTick.get(hostile);
                        boolean recentlyClose = lastSeen != null && safeTicks() - lastSeen <= LOS_GRACE_TICKS;

                        // Give each hostile a timer, if they're close for too long deal with them.
                        if (isClose || recentlyClose) {
                            if (!_closeAnnoyingEntities.containsKey(hostile)) {
                                TimerGame timer = new TimerGame(0);
                                timer.reset();
                                _closeAnnoyingEntities.put(hostile, timer);
                            }
                            // "don't pick a fight with the scary ones while healthy" used to be
                            // written as a TimerGame(POSITIVE_INFINITY) - a timer that never
                            // elapses - stored ONCE behind the containsKey() guard above. so it
                            // was never revisited: an enderman or vindicator that walked up while
                            // she was healthy was excluded from toDealWith for the rest of its
                            // life, all the way down to zero health, while she treated the fight
                            // as "no problematic entities" and walked her travel goal. decide it
                            // per tick instead, and drop the deference the moment it hits her.
                            boolean deferScary = isScaryToPickAFightWith(hostile)
                                    && mod.getPlayer().getHealth() > 10
                                    && !tookDamageRecently();
                            if (!deferScary && _closeAnnoyingEntities.get(hostile).elapsed()) {
                                toDealWith.add(hostile);
                            }
                        } else {
                            _closeAnnoyingEntities.remove(hostile);
                            _lastCloseTick.remove(hostile);
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
                for (Entity remove : toRemove) {
                    _closeAnnoyingEntities.remove(remove);
                    _lastCloseTick.remove(remove);
                }
            }
            // a mob can also leave getHostiles() entirely (that list is rebuilt through
            // isAngryAtPlayer every tick), in which case the loop above never visits it
            // to expire its grace entry. drop anything stale so this can't grow all night.
            // the `> nowTicks` arm catches entries written before a reconnect: getTicks()
            // is the CONNECTION's counter and restarts at zero, so their age goes negative
            // and a plain age test would keep them forever.
            int nowTicks = safeTicks();
            _lastCloseTick.entrySet().removeIf(e -> !e.getKey().isAlive()
                    || e.getValue() > nowTicks
                    || nowTicks - e.getValue() > LOS_GRACE_TICKS);
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

                // Use the same health/gear/type-aware assessment as the emergency flee
                // gate. Two identical branches must not disagree and alternate tasks.
                if (canSafelyFight(mod, toDealWith)) {
                    // We can deal with it.
                    if (commitTo(mod, DefenseMode.FIGHT)) {
                        _runAwayTask = null;
                        Class<?> targetClass = pickFightTarget(mod, toDealWith);
                        setTask(_fightTargetEntity != null
                                ? attackTaskFor(mod, _fightTargetEntity)
                                : new KillEntitiesTask(targetClass));
                    }
                    // ⚠ GEAR UP ON THE WAY IN, NOT AFTER SHE LOSES. The shield was only
                    // ever moved to the offhand REACTIVELY - once a creeper was already
                    // fusing or an arrow was already in the air - even though capacity
                    // scores an offhand shield at +0.75 against +0.20 for the same shield
                    // in the bag. The code knew the difference and never acted on it.
                    // A drawn bow needs both hands, so a ranged fight does not want one.
                    _gearingUp = !CombatGear.readyUp(mod, !_rangedEngagement);
                    // she can already take this one; nothing to promise about gear.
                    _couldWinIfGeared = false;
                    return 65;
                } else {
                    // We can't deal with it...
                    // ...unless the override has already judged running a failure. it
                    // has to sit above THIS branch too: canSafelyFight is exactly the
                    // opinion that started the treadmill, and an override only one
                    // caller respects is not an override (this file's own words, two
                    // hundred lines up). without this, commitTo() let the fight stand
                    // for DEFENSE_COMMIT_SECONDS and then handed it back to the flee.
                    if (_fightingItOut && fightStillStands(mod)) return 75;
                    // Same retreat-and-re-arm as the emergency flee block above. This arm
                    // is reached on its own conditions, so a gear-up wired only into that
                    // one would be missing exactly where "she ran from a fight she owned
                    // the gear to win" is decided.
                    _gearingUp = !CombatGear.readyUp(mod, true);
                    // toDealWith is already the set this arm judged unwinnable, so the
                    // "...but not if I were dressed" verdict is exact here.
                    _couldWinIfGeared = couldWinIfGeared(mod, toDealWith);
                    if (commitTo(mod, DefenseMode.FLEE)) {
                        beginOrAdoptFlee(mod);
                    }
                    return 80;
                }
            }
        }
        // By default if we aren't "immediately" in danger but were running away, keep running away until we're good.
        if (_runAwayTask != null && !_runAwayTask.isFinished(mod)) {
            setTask(_runAwayTask);
            return Math.max(_cachedLastPriority, _engaged ? ENGAGED_PRIORITY : 0);
        } else {
            _runAwayTask = null;
            // the escape is OVER, so stop calling ourselves FLEE.
            //
            // this half of the loop is why she could stand still for minutes with no
            // live task: the latch's third stillInIt term is
            // `_defenseMode == FLEE && nearestThreat(16) != null`, and defaultAnswer()
            // re-asserts forceMode(FLEE) every time the latch calls it. mode keeps the
            // latch alive, the latch re-asserts the mode. nothing else ever cleared it -
            // onTaskFinish deliberately does not - so a single finished escape pinned
            // FLEE for as long as any hostile-SPECIES mob sat within 16 blocks, which
            // underground or after dark is essentially always.
            if (_defenseMode == DefenseMode.FLEE) {
                releaseDefenseMode();
            }
        }

        // ---- THE ENGAGEMENT LATCH ----
        // reaching here means NO branch matched on THIS TICK, and that used to mean
        // "return 0" - handing the slot straight back to UserTaskChain (a flat 50).
        // every predicate above flickers: EntityTracker builds getHostiles() itself
        // through EntityHelper.isAngryAtPlayer(), which raycasts line of sight AND reads
        // Mob.isAggressive() (a data flag that blinks between swings), so the hostile list
        // can empty for a tick with mobs standing on her.
        //
        // what that cost, from her death log on 2026-08-02 (killed by a spider at
        // 01:22:24): ten "Chain Interrupted" swaps in the last forty seconds, each one a
        // full task-tree teardown and a fresh ~1s baritone path calculation she cannot
        // move during. and between 01:21:56 and 01:22:16 the flicker held long enough that
        // defense stayed out entirely - so she spent twenty unbroken seconds WALKING HER
        // TRAVEL ROUTE while a crowd hit her in the back, because as far as this method
        // was concerned nothing was happening. that is the "she just stands there and does
        // nothing" this file has now been asked to fix ten times.
        //
        // so combat is a STATE here, not a per-tick opinion. while engaged the chain
        // stays above UserTaskChain and always has an answer running.
        // gated on the LOOSE test (species + distance, no raycast, no aggression flag) so
        // it cannot flicker. the range is SAFE_KEEP_DISTANCE and not the disengage range
        // ON PURPOSE: holding the chain for anything within 16 blocks means holding it all
        // night, since something hostile is nearly always that close underground or after
        // dark - she would never mine, travel or build again. only a fight she is actually
        // in, or a mob genuinely on top of her, gets to own the slot. the wider range is
        // still honoured while fleeing, where letting go early strands her mid-escape.
        // the fourth term is the ranged-mob hole: the branch above picks fights with
        // skeletons, pillagers, witches and piglins from FIFTEEN blocks, which is
        // outside every range this latch was holding. see fightStillStands - without
        // it she commits to a kill and abandons it on the next tick, forever.
        boolean stillInIt = tookDamageRecently()
                || nearestThreat(mod, SAFE_KEEP_DISTANCE) != null
                || (_defenseMode == DefenseMode.FLEE && nearestThreat(mod, DISENGAGE_KEEP_DISTANCE) != null)
                || fightStillStands(mod);
        if (_engaged && stillInIt) {
            // an answer is mid-flight - let it finish, do not re-decide.
            if (!currentTaskDone(mod)) return ENGAGED_PRIORITY;
            Task fallback = defaultAnswer(mod);
            if (fallback != null) {
                // clear FIRST. SingleTaskChain.setTask() is a no-op whenever the
                // replacement .equals() the incumbent, and RunAwayFromHostilesTask.isEqual
                // calls any two runs of the same distance equal - so handing it a fresh
                // flee task while a FINISHED one occupies the slot changes precisely
                // nothing, and the chain then wins the tick with a corpse. (a flee task
                // reports finished whenever getHostiles() comes back empty, which is the
                // very flicker this latch exists to survive.)
                setTask(null);
                setTask(fallback);
                // and confirm the answer arrived ALIVE. a task that reports finished the
                // moment it is installed would win the tick and run nothing - the same
                // freeze, just manufactured fresh each tick instead of inherited.
                // RunAwayFromHostilesTask no longer does that (it debounces), but this
                // class must never be the reason she stands still, whatever a task decides
                // to report. if it is dead on arrival, yield instead.
                if (!currentTaskDone(mod)) return ENGAGED_PRIORITY;
            }
        }
        // nothing left to defend against - drop the commitment so the NEXT threat is
        // answered on the tick it appears rather than after a stale hold expires, and drop
        // the task with it. a KillEntitiesTask never reports finished and is never stopped,
        // so without this it sits in the slot indefinitely and the latch would RESUME that
        // stale hunt on the next unrelated engagement - chasing whatever she was fighting
        // an hour ago while something else bites her.
        releaseDefenseMode();
        setTask(null);
        return 0;
    }

    // ------------------------------------------------------------------
    // engagement latch + anti-freeze
    // ------------------------------------------------------------------

    /**
     * WorldHelper.getTicks() requireNonNulls the network connection. An NPE thrown out of
     * getPriority() does not just break this chain - TaskRunner.tick() computes every
     * chain's priority in one loop, so it takes the food chain, the MLG bucket and the
     * user's task down with it, mid-air, on a disconnect race. Nothing here is worth that.
     */
    private static int safeTicks() {
        try {
            return WorldHelper.getTicks();
        } catch (Exception e) {
            return 0;
        }
    }

    private void trackDamage(AltoClef mod) {
        float health = mod.getPlayer().getHealth();
        if (mod.getPlayer().hurtTime > 0 || (_lastHealth >= 0 && health < _lastHealth - 0.01f)) {
            _sinceDamage.reset();
        }
        _lastHealth = health;
        updateEngagement(mod);
    }

    private boolean tookDamageRecently() {
        return !_sinceDamage.elapsed();
    }

    /**
     * Engagement may only BEGIN from something unambiguous: a defensive answer having
     * actually been chosen, or her losing health with a hostile in range. It then
     * survives on the LOOSE threat test (see nearestThreat), so a flickering predicate
     * can never cut it short, and it ends only after ENGAGEMENT_RELEASE_SECONDS with no
     * trace of a threat.
     * <p>
     * Deliberately conservative about starting: a zombie standing behind a wall while
     * she mines must never latch the chain and stall her work.
     */
    private void updateEngagement(AltoClef mod) {
        boolean beingAttacked = tookDamageRecently() && nearestThreat(mod, DANGER_KEEP_DISTANCE) != null;
        if (_defenseMode != DefenseMode.NONE || beingAttacked) {
            _engaged = true;
            _engagementRelease.reset();
        } else if (_engaged) {
            if (nearestThreat(mod, DISENGAGE_KEEP_DISTANCE) != null) {
                _engagementRelease.reset();
            } else if (_engagementRelease.elapsed()) {
                _engaged = false;
            }
        }
    }

    /**
     * The LOOSE threat scan: hostile-by-species mobs within DANGER_KEEP_DISTANCE, nearest
     * first. Every caller below filters this by its own range, so the world entity list -
     * which can be thousands of entries on a busy server - is walked ONCE per tick even
     * though the questions get asked half a dozen times.
     * <p>
     * It deliberately does not consult EntityTracker.getHostiles(), because that list is
     * itself filtered through EntityHelper.isAngryAtPlayer() - a line-of-sight raycast
     * plus Mob.isAggressive() - and those are exactly the two things whose flicker drops
     * the chain mid-fight. Used for LATCHING and for the freeze watchdog; choosing what to
     * actually attack still goes through the strict tests.
     */
    private List<Entity> threats(AltoClef mod) {
        LocalPlayer player = mod.getPlayer();
        if (player == null || mod.getWorld() == null) return Collections.emptyList();
        try {
            // inside the try: WorldHelper.getTicks() requireNonNull's the connection, and
            // an NPE escaping getPriority() takes down TaskRunner.tick() for EVERY chain,
            // not just this one.
            int now = WorldHelper.getTicks();
            if (now == _threatScanTick) return _threatScan;
            _threatScanTick = now;
            _threatScan = new ArrayList<>();
            double maxSq = DANGER_KEEP_DISTANCE * DANGER_KEEP_DISTANCE;
            for (Entity entity : mod.getWorld().entitiesForRendering()) {
                if (!(entity instanceof Mob) || !(entity instanceof Enemy)) continue;
                if (!entity.isAlive()) continue;
                if (mod.getBehaviour().shouldExcludeFromForcefield(entity)) continue;
                if (entity.distanceToSqr(player) > maxSq) continue;
                _threatScan.add(entity);
            }
            _threatScan.sort(StlHelper.compareValues(entity -> entity.distanceToSqr(player)));
        } catch (Exception ignored) {
            // world entity list is mutated off-thread; a bad tick just means no answer
        }
        return _threatScan;
    }

    private Entity nearestThreat(AltoClef mod, double range) {
        List<Entity> threats = threats(mod);
        if (threats.isEmpty()) return null;
        Entity nearest = threats.get(0);   // sorted nearest-first
        return nearest.distanceToSqr(mod.getPlayer()) <= range * range ? nearest : null;
    }

    /**
     * True when survival should override any requested kill task.
     */
    public boolean shouldRetreatFromCombat(AltoClef mod) {
        return shouldRetreatFromCombat(mod, null);
    }

    /**
     * A voluntary target must be close, actively hostile, and not a mob we should leave
     * alone. This prevents HeroTask from walking back toward the crowd we just escaped.
     */
    public boolean isSafeToStartFight(AltoClef mod, Entity target) {
        if (target == null || !target.isAlive()
                || target.distanceToSqr(mod.getPlayer()) > COMBAT_RISK_DISTANCE * COMBAT_RISK_DISTANCE) {
            return false;
        }
        if (!EntityHelper.isAngryAtPlayer(mod, target)
                || target instanceof Creeper || isScaryToPickAFightWith(target)) {
            return false;
        }
        return canSafelyFight(mod, combatThreats(mod, target));
    }

    private boolean shouldRetreatFromCombat(AltoClef mod, Entity intendedTarget) {
        List<Entity> nearby = combatThreats(mod, intendedTarget);
        return !nearby.isEmpty() && !canSafelyFight(mod, nearby);
    }

    private List<Entity> combatThreats(AltoClef mod, Entity intendedTarget) {
        List<Entity> result = new ArrayList<>();
        double riskRangeSq = COMBAT_RISK_DISTANCE * COMBAT_RISK_DISTANCE;
        for (Entity threat : threats(mod)) {
            double distanceSq = threat.distanceToSqr(mod.getPlayer());
            if (distanceSq > riskRangeSq) break; // threats() is nearest-first
            boolean active = EntityHelper.isAngryAtPlayer(mod, threat);
            // Line of sight and aggression flags may blink between attacks. A recent hit
            // keeps the whole nearby pack in the decision, including ranged attackers.
            if (active || tookDamageRecently()) {
                result.add(threat);
            }
        }
        if (intendedTarget != null && intendedTarget.isAlive()
                && intendedTarget.distanceToSqr(mod.getPlayer()) <= riskRangeSq
                && (EntityHelper.isAngryAtPlayer(mod, intendedTarget) || tookDamageRecently())
                && !result.contains(intendedTarget)) {
            result.add(intendedTarget);
        }
        return result;
    }

    private boolean canSafelyFight(AltoClef mod, Collection<Entity> hostiles) {
        if (hostiles.isEmpty()) return true;
        if (fightIsHopeless(mod)) return false;
        return combatCapacity(mod, false) >= dangerOf(mod, hostiles) * COMBAT_SAFETY_MARGIN;
    }

    /**
     * The same question asked about the loadout she is CARRYING rather than wearing.
     * <p>
     * ⚠ THIS IS THE DIFFERENCE BETWEEN "I CANNOT WIN THIS" AND "I CANNOT WIN THIS YET".
     * capacity is built from getArmorValue() (worn) and scores a shield in the offhand at
     * +0.75 against +0.20 for the same shield in her bag - so a bot carrying a full iron
     * set was scored as naked, decided the fight was unwinnable and ran. Nothing anywhere
     * in the defense path had ever put a piece of armour on. And a fresh spawn owns
     * nothing, so "carrying but not wearing" is the normal case.
     * <p>
     * When this is true and {@link #canSafelyFight} is false, running is not the answer -
     * getting dressed is. See the gear-up call on the flee path.
     */
    private boolean couldWinIfGeared(AltoClef mod, Collection<Entity> hostiles) {
        if (hostiles.isEmpty()) return true;
        if (fightIsHopeless(mod)) return false;
        return combatCapacity(mod, true) >= dangerOf(mod, hostiles) * COMBAT_SAFETY_MARGIN;
    }

    /** the conditions no amount of gear fixes. */
    private boolean fightIsHopeless(AltoClef mod) {
        float effectiveHealth = mod.getPlayer().getHealth() + mod.getPlayer().getAbsorptionAmount();
        return effectiveHealth <= STAND_AND_FIGHT_MIN_HEALTH
                || mod.getPlayer().hasEffect(MobEffects.WITHER)
                || mod.getPlayer().hasEffect(MobEffects.POISON);
    }

    /**
     * @param assumeGeared count what she could put on in a few slot clicks, instead of
     *                     what is currently on her body.
     */
    private double combatCapacity(AltoClef mod, boolean assumeGeared) {
        float effectiveHealth = mod.getPlayer().getHealth() + mod.getPlayer().getAbsorptionAmount();

        // ⚠ ANY melee weapon, not just swords. The old scan walked a hardcoded SWORDS[]
        // ladder, so a netherite AXE - which hits HARDER than the netherite sword - scored
        // as bare hands and turned every fight into a retreat. See CombatGear.
        double weaponDamage = CombatGear.bestMeleeDamage(mod);
        double attackDamage = weaponDamage <= 0 ? 0 : 1 + weaponDamage;

        double armor = assumeGeared ? CombatGear.reachableArmor(mod) : CombatGear.wornCapacityArmor(mod);
        double capacity = 0.65 + armor * 0.10 + attackDamage * 0.20;

        if (CombatGear.shieldInOffhand(mod) || (assumeGeared && CombatGear.hasShield(mod))) {
            capacity += 0.75;
        } else if (CombatGear.hasShield(mod)) {
            capacity += 0.20; // owning one is not the same as blocking with it
        }
        if (mod.getPlayer().getFoodData().getFoodLevel() >= 14) {
            capacity += 0.15;
        } else if (mod.getPlayer().getFoodData().getFoodLevel() < 8 || !mod.getFoodChain().hasFood()) {
            capacity *= 0.75;
        }

        // Gear at half a heart bar is not full-strength gear. Keep a small floor so one
        // weak mob does not cause indecision, but rapidly prefer escape as health falls.
        double healthFactor = Math.max(0.35, Math.min(1.0, (effectiveHealth - 4) / 16.0));
        return capacity * healthFactor;
    }

    private double dangerOf(AltoClef mod, Collection<Entity> hostiles) {
        double danger = 0;
        for (Entity hostile : hostiles) {
            danger += threatWeight(mod, hostile);
        }
        return danger;
    }

    private double threatWeight(AltoClef mod, Entity hostile) {
        if (hostile instanceof Warden || hostile instanceof WitherBoss) return 100;

        double weight = 1;
        if (hostile instanceof Creeper creeper) {
            if (creeper.isPowered()) return 100;
            weight = 2.75 + creeper.getSwelling(1) * 3;
        } else if (hostile instanceof EnderMan || hostile instanceof PiglinBrute
                || hostile instanceof Hoglin || hostile instanceof Zoglin
                || hostile instanceof Vindicator) {
            weight = 2.5;
        } else if (hostile instanceof Witch || hostile instanceof Blaze
                || hostile instanceof WitherSkeleton) {
            weight = 2.2;
        } else if (hostile instanceof AbstractSkeleton || hostile instanceof Pillager
                || hostile instanceof Ghast) {
            weight = 1.6;
        } else if (hostile instanceof Slime slime && slime.getSize() >= 4) {
            weight = 1.8;
        }

        double distanceSq = hostile.distanceToSqr(mod.getPlayer());
        if (distanceSq <= 16) weight *= 1.20;
        if (distanceSq <= 6.25) weight *= 1.15;
        return weight;
    }

    /**
     * mobs that can hurt her from further away than she can hurt them back.
     * <p>
     * this set was written inline in the annoying-hostiles branch and nowhere else, so
     * the one fact "this thing shoots" could not be consulted by any other decision.
     * Extracted verbatim - same four types, so the annoying-range behaviour is unchanged -
     * because the ranged/melee choice needs exactly this question.
     */
    private static boolean outrangesUs(Entity hostile) {
        return hostile instanceof AbstractSkeleton || hostile instanceof Witch
                || hostile instanceof Pillager || hostile instanceof Piglin;
    }

    // mobs it is not worth PICKING a fight with while healthy. this is deference, not
    // fear: the moment one of them actually hits her it stops applying.
    private boolean isScaryToPickAFightWith(Entity hostile) {
        return hostile instanceof Warden || hostile instanceof WitherBoss || hostile instanceof EnderMan
                || hostile instanceof Blaze || hostile instanceof WitherSkeleton || hostile instanceof Hoglin
                || hostile instanceof Zoglin || hostile instanceof PiglinBrute || hostile instanceof Vindicator;
    }

    /**
     * The answer to give when the latch is holding the chain but no branch produced a
     * task. NEVER return the latch priority without one of these: this chain overrides
     * isActive() to true, so TaskRunner will happily hand it the tick with a null or
     * finished task and she would stand there holding a slot she is not using.
     */
    private Task defaultAnswer(AltoClef mod) {
        Entity threat = nearestThreat(mod, DISENGAGE_KEEP_DISTANCE);
        if (threat == null) return null;
        // only ever pick a FIGHT with something that is actually on her and that the rest
        // of this file would also have chosen to hit. the loose scan matches on species,
        // so without these guards the fallback would happily start a fight with a warden,
        // or walk a healthy burnt across a nether bastion at a piglin brute.
        Entity inReach = nearestThreat(mod, SAFE_KEEP_DISTANCE);
        if (inReach != null
                && canSafelyFight(mod, combatThreats(mod, inReach))
                && !(inReach instanceof Creeper)
                && !isScaryToPickAFightWith(inReach)) {
            return commitToKilling(mod, inReach);
        }
        // NEVER install an escape from nothing.
        //
        // the loose scan above matches on species and distance, but the flee task builds
        // its goal from the entity tracker - so when a hostile-species mob is nearby and
        // the tracker cannot see it (not aggressive, or no line of sight), the two
        // disagree: the latch says "still in it" while the goal is already satisfied
        // where she stands. baritone then has nowhere to path, the escape reports
        // finished ESCAPE_SETTLE_SECONDS later, and the latch mints another one. She
        // stands perfectly still, at a priority that outranks her real work, for as long
        // as that mob loiters. Two branches that disagree do not get to trade a task
        // between them - that is the rule this file already learned twice.
        //
        // returning null instead drops the chain (releaseDefenseMode + setTask(null) +
        // priority 0), which is honest: an escape whose own goal is already met is not a
        // defence, and letting her mining or travel task resume actually moves her.
        if (!RunAwayFromHostilesTask.hasSomethingToFleeFrom(mod)) return null;
        forceMode(DefenseMode.FLEE);
        _runAwayTask = new RunAwayFromHostilesTask(DANGER_KEEP_DISTANCE, true);
        return _runAwayTask;
    }

    /**
     * LAST RESORT: if she is engaged, something is in reach, and she has not actually
     * moved for FROZEN_SECONDS, move her by hand.
     * <p>
     * Everything else in this file is about keeping the right task running. This does not
     * care what the task tree believes, because from the outside every failure looks
     * identical - burnt standing still in a crowd being eaten - and the causes are not all
     * reachable from here: baritone can be mid-calculation (a second of dead stillness per
     * restart, and it restarts on every interrupt), the path can have failed outright, a
     * sub-task can be waiting on something that will never arrive. So this watches the one
     * thing that cannot lie - her actual position - and if it stops changing while mobs
     * are on her, it presses the keys itself.
     * <p>
     * Strafes rather than turning, so the camera stays on the mob and the force field
     * keeps landing hits while she repositions. Yields the instant baritone is moving her
     * again, and never touches the controls while the operator has them (F1).
     */
    private void panicTick(AltoClef mod) {
        LocalPlayer player = mod.getPlayer();
        // release, don't just return: this is the one exit that used to leave _panicDriving
        // set. inGame() guards the caller, so getting here needs the connection to drop
        // mid-tick - and the cost of missing it is that every CustomBaritoneGoalTask stops
        // releasing SNEAK/MOVE_BACK/MOVE_FORWARD for the rest of the session.
        if (player == null) {
            releasePanic(mod);
            return;
        }
        if (ExternalControlServer.isManualControl()) {
            releasePanic(mod);
            return;
        }

        Vec3 pos = player.position();
        if (_lastStillPos == null || pos.distanceToSqr(_lastStillPos) > FROZEN_MOVE_EPSILON * FROZEN_MOVE_EPSILON) {
            _lastStillPos = pos;
            _stillTimer.reset();
            _hardStillTimer.reset();
        }

        // NOT bare _engaged: that stays true for seconds after the fighting stops, and
        // "has not moved for 1.5s" is also a perfect description of mining a block,
        // waiting on a furnace, or standing in a doorway placing torches. it has to be a
        // defensive answer that is actually RUNNING - _defenseMode is NONE on every path
        // that returns a priority of 0 or less, so this is only ever armed while defense
        // owns the tick. (recent damage alone would not do: mining down into a fall with a
        // zombie two tunnels over would arm it.) putOutFire deliberately pauses pathing to
        // stand still and swing at the fire, so it must be exempt too or she gets strafed
        // off the block she is trying to extinguish.
        boolean reallyFighting = _defenseMode != DefenseMode.NONE;
        Entity threat = (_engaged && reallyFighting && !_wasPuttingOutFire)
                ? nearestThreat(mod, PANIC_TRIGGER_DISTANCE) : null;
        // once it starts, it runs for PANIC_HOLD_SECONDS. the trigger is "has not moved",
        // which the first step of the escape immediately falsifies - without a hold she
        // would step once, stop, wait out the still timer again, step once... a stutter
        // that is barely better than the freeze it replaces.
        boolean committed = !_panicHeld.isEmpty() && !_panicCommitment.elapsed();
        // "baritone is pathing" is not "she is moving", and trusting it is why this
        // watchdog slept through the death it exists to prevent (2026-08-04, slain by a
        // zombie after 47 seconds standing still): while a defensive answer is torn down
        // and rebuilt, baritone spends every window re-calculating a path it is about to
        // have force-cancelled, and reports isPathing() throughout. The churn LOOKS like
        // progress, so the one mechanism that would have physically moved her stood down
        // once per cycle until she was dead.
        //
        // But dropping the test outright is worse: baritone breaking a block to escape
        // legitimately stands still, and strafing her off it every 1.5s turns a slow
        // escape into no escape (mine -> panic -> recalculate -> mine, forever). So keep
        // it, and give it a deadline. Under FROZEN_HARD_SECONDS baritone gets the benefit
        // of the doubt; past it, "not moving" wins the argument no matter what it claims.
        //
        // `|| committed` on the trust term is what makes the hold actually hold. The
        // first panic step covers FROZEN_MOVE_EPSILON in about three ticks, and that
        // movement resets _hardStillTimer - so without this, trust is restored ~0.16s
        // into a 1.2s hold, panic releases, she stops, and she cannot fire again for
        // another FROZEN_HARD_SECONDS. Roughly 0.9 blocks every 3.5s, against a zombie
        // doing several blocks a second: the exact stutter PANIC_HOLD_SECONDS exists to
        // prevent, reintroduced through the back door.
        boolean pathingAndTrusted = mod.getClientBaritone().getPathingBehavior().isPathing()
                && !_hardStillTimer.elapsed();
        boolean frozen = threat != null
                && (_stillTimer.elapsed() || committed)
                && !_shielding
                && (!pathingAndTrusted || committed);
        if (!frozen) {
            releasePanic(mod);
            return;
        }

        double threatDistance = Math.sqrt(threat.distanceToSqr(player));
        boolean outnumbered = shouldRetreatFromCombat(mod);
        // standing still inside melee range while she can take the crowd is not a freeze,
        // it is a fight - the force field is landing hits and dragging her out of reach
        // every 1.5 seconds would mean she never finishes anything. only take the controls
        // when she cannot reach what is hurting her, or when she should be running and is
        // somehow not.
        if (threatDistance <= 3.5 && !outnumbered) {
            releasePanic(mod);
            return;
        }

        // out of reach and meant to be fighting: close the distance. otherwise put ground
        // between her and it. either way she MOVES.
        boolean closeIn = _defenseMode == DefenseMode.FIGHT && !outnumbered;
        Vec3 desired = closeIn ? threat.position().subtract(pos) : pos.subtract(threat.position());

        Vec3 chosen = firstSafeDirection(mod, desired);
        if (chosen == null) {
            releasePanic(mod);
            return;
        }
        holdPanicInputs(mod, chosen);
    }

    /**
     * Try the direction we want, then progressively wider deflections of it, and return
     * the first one she can actually step into. Water counts as unsafe at any depth -
     * burnt does not swim, and a fight is the worst possible place to learn.
     */
    private Vec3 firstSafeDirection(AltoClef mod, Vec3 desired) {
        Vec3 flat = new Vec3(desired.x, 0, desired.z);
        if (flat.lengthSqr() < 0.0001) return null;
        flat = flat.normalize();
        // no 180: the desired direction is already either "away from it" or "at it", so a
        // full reversal is the exact opposite of the intent - it would walk a fleeing
        // burnt straight into the mob she is fleeing.
        double[] deflections = {0, 45, -45, 90, -90, 135, -135};
        for (double degrees : deflections) {
            double rad = Math.toRadians(degrees);
            double cos = Math.cos(rad), sin = Math.sin(rad);
            Vec3 candidate = new Vec3(flat.x * cos - flat.z * sin, 0, flat.x * sin + flat.z * cos);
            if (stepIsSafe(mod, candidate)) return candidate;
        }
        return null;
    }

    private boolean stepIsSafe(AltoClef mod, Vec3 direction) {
        try {
            Vec3 target = mod.getPlayer().position().add(direction.scale(1.4));
            BlockPos foot = BlockPos.containing(target);
            BlockPos head = foot.above();
            BlockPos ground = foot.below();
            // collision shapes, not WorldHelper.isSolid() - that one is isRedstoneConductor,
            // so it calls stairs, slabs, paths and farmland "not solid" (she would refuse to
            // flee across a village) while calling a fence "not blocking" (she would walk
            // into one). in a cave with no acceptable direction she just stands and swings,
            // which is the outcome this whole method exists to avoid.
            if (!mod.getWorld().getBlockState(foot).getCollisionShape(mod.getWorld(), foot).isEmpty()) return false;
            if (!mod.getWorld().getBlockState(head).getCollisionShape(mod.getWorld(), head).isEmpty()) return false;
            if (mod.getWorld().getBlockState(ground).getCollisionShape(mod.getWorld(), ground).isEmpty()) {
                return false;   // no walking off a ledge in a panic
            }
            for (BlockPos check : new BlockPos[]{foot, head, ground}) {
                // any fluid at all: water is a hard no (the operator's standing rule, and a fight is
                // the worst possible place to start swimming), lava is worse.
                if (!mod.getWorld().getBlockState(check).getFluidState().isEmpty()) return false;
            }
            return !(mod.getWorld().getBlockState(foot).getBlock() instanceof BaseFireBlock);
        } catch (Exception e) {
            return false;
        }
    }

    private void holdPanicInputs(AltoClef mod, Vec3 direction) {
        double yaw = Math.toRadians(mod.getPlayer().getYRot());
        // minecraft yaw: 0 looks toward +Z (south) and increases clockwise seen from
        // above, so the look vector is (-sin, cos). facing south your right hand points
        // WEST (-X), which is (-cos, -sin) - not (cos, sin). getting this backwards
        // strafes her into the mob she is trying to get away from.
        Vec3 forward = new Vec3(-Math.sin(yaw), 0, Math.cos(yaw));
        Vec3 right = new Vec3(-Math.cos(yaw), 0, -Math.sin(yaw));
        double forwardness = direction.dot(forward);
        double rightness = direction.dot(right);

        Set<Input> want = new HashSet<>();
        if (forwardness > 0.35) {
            want.add(Input.MOVE_FORWARD);
            want.add(Input.SPRINT);
        } else if (forwardness < -0.35) {
            want.add(Input.MOVE_BACK);
        }
        if (rightness > 0.35) {
            want.add(Input.MOVE_RIGHT);
        } else if (rightness < -0.35) {
            want.add(Input.MOVE_LEFT);
        }
        if (want.isEmpty()) {
            releasePanic(mod);
            return;
        }

        if (_panicHeld.isEmpty()) {
            _panicCommitment.reset();   // starting a fresh escape - see the hold in panicTick
        }
        for (Input held : new ArrayList<>(_panicHeld)) {
            if (!want.contains(held)) {
                mod.getInputControls().release(held);
                _panicHeld.remove(held);
            }
        }
        for (Input input : want) {
            mod.getInputControls().hold(input);
            _panicHeld.add(input);
        }
        _panicDriving = true;
    }

    private void releasePanic(AltoClef mod) {
        // flag first, and OUTSIDE the empty-set early return: it must go false on every
        // path that gives the controls back, or a single panic would suppress the goal
        // tasks' input handling for the rest of the session.
        _panicDriving = false;
        if (_panicHeld.isEmpty()) return;
        for (Input input : _panicHeld) {
            mod.getInputControls().release(input);
        }
        _panicHeld.clear();
    }

    /**
     * True while the anti-freeze watchdog is pressing movement keys itself. Movement
     * tasks must leave the controls alone while this holds - see the field comment.
     */
    public static boolean isPanicDriving() {
        return _panicDriving;
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
                        // worstSafety was never updated here, so this returned the LAST
                        // fusing creeper the tracker happened to list rather than the most
                        // dangerous one - she would run from a distant creeper while the
                        // one at her feet finished its fuse.
                        worstSafety = safety;
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
                            // aim only while actually blocking - see the note below on why
                            // this method no longer touches the pathing behaviour.
                            if (_shielding && ghastBall.isPresent() && ghast.isPresent()) {
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
                            // NO requestPause() HERE, EVER.
                            // this method is a QUESTION, asked several times per tick by the
                            // branches above - and it used to answer it by pausing baritone.
                            // PathingBehavior.isPathing() is `hasPath() && !pausedThisTick`,
                            // so while any arrow was in flight nearby AND _runAwayTask was
                            // null - which is precisely what FIGHT mode sets it to - she was
                            // re-paused on every single tick and could not take one step. she
                            // stood in the open, turned to face the arrow, and let a skeleton
                            // empty its quiver into her. shielding pauses on its own inside
                            // startShielding(); nothing else here needs the controls.
                            if (_shielding) {
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
        // BEING HIT IS NOT AN OPINION. everything below this line is a health/armour
        // threshold or a raycast, and at full health with a mob chewing on her every one
        // of them answered "no danger" - so she kept walking her travel goal while a ring
        // of mobs ate her. losing health with a hostile in reach IS the danger.
        if (tookDamageRecently() && nearestThreat(mod, SAFE_KEEP_DISTANCE) != null) {
            return true;
        }
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

    // COMMIT TO THE FIGHT.
    // isVulnurable() is `armor < 5 && health < 18`, which for a bot with no armour is
    // true after ONE HIT. so from first blood the panic flee (70) outranks the decision
    // to fight (65): she swings once, turns, and a melee mob follows her and beats her
    // to death from behind. a fresh spawn owns no armour, so that is the NORMAL case.
    // if the entire threat is one ordinary melee mob and she can still take a few hits,
    // stand and finish it.
    private boolean shouldStandAndFight(AltoClef mod) {
        List<Entity> nearby = combatThreats(mod, _targetEntity);
        return !nearby.isEmpty() && canSafelyFight(mod, nearby);
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

    // ------------------------------------------------------------------
    // COMBAT READOUT - what she decided, and why
    //
    // ⚠ this chain has always made the entire fight-or-flight decision in private. Burnt
    // could see "3 hostiles nearby" and her own health and nothing else, so when the
    // machine chose to run there was no way for her to know it had, let alone say why -
    // which is what "she says 'fighting back' for absolutely no reason" and "no idea what
    // she's doing or why" actually are. These are cheap reads off state the chain already
    // holds; the companion polls them every couple of seconds.
    // ------------------------------------------------------------------

    /** "none" | "dodge" | "fight" | "flee" - the answer she is currently committed to. */
    public String getCombatMode() {
        return _defenseMode.name().toLowerCase(java.util.Locale.ROOT);
    }

    /** the mob she has actually committed to killing, or null. */
    public Entity getCombatTarget() {
        return _fightTargetEntity != null && _fightTargetEntity.isAlive() ? _fightTargetEntity : null;
    }

    /** true when the committed fight is being had with a bow rather than a blade. */
    public boolean isFightingAtRange() {
        return _rangedEngagement;
    }

    /** true while there is still gear in her bag she has not managed to put on. */
    public boolean isGearingUp() {
        return _gearingUp;
    }

    /** true while the anti-treadmill override is deliberately standing its ground. */
    public boolean isStandingItsGround() {
        return _fightingItOut;
    }

    /**
     * "I would win this if I were wearing what I am carrying."
     * <p>
     * The single most useful thing she can know about a fight she is losing, and it was
     * not computable anywhere before {@link #couldWinIfGeared} existed.
     * <p>
     * ⚠ A PLAIN FIELD READ, ON PURPOSE - see {@link #_couldWinIfGeared}. Computing it
     * here would run an entity scan on the poll thread and corrupt the tick-keyed threat
     * cache out from under TaskRunner.
     */
    public boolean couldWinCurrentFightIfGeared() {
        return _couldWinIfGeared;
    }

    @Override
    public boolean isActive() {
        // We're always checking for mobs
        return true;
    }

    @Override
    public boolean runsWhileIdle() {
        // being between jobs is not a reason to let a spider have her
        return true;
    }

    @Override
    protected void onTaskFinish(AltoClef mod) {
        // SingleTaskChain does NOT clear a finished task - it calls this and then ticks
        // nothing, forever, while isActive() (overridden to true here) keeps the chain in
        // the running for every tick. the default body was empty, so a defensive answer
        // that reported "done" became a corpse in the slot that still won ticks and still
        // did nothing. drop it so the next tick re-decides.
        //
        // it deliberately does NOT releaseDefenseMode(). that reads tidier and is a trap:
        // commitTo()'s one-way dodge->flee door only exists while _defenseMode is an
        // evasion, so clearing the mode here would grant DODGE immediately after a flee
        // task blinked "finished" - re-opening the exact two-way door documented on
        // commitTo(), which has already killed her once. the mode is cleared at the
        // priority-0 fallthrough instead, which is where the fight is genuinely over.
        setTask(null);
    }

    @Override
    protected void onStop(AltoClef mod) {
        // TaskRunner.disable() stops every chain and then never calls getPriority()
        // again, so anything panicTick() is holding down would stay held - burnt walking
        // into the sunset after an @stop. let go here too.
        releasePanic(mod);
        releaseDefenseMode();
        _engaged = false;
        // entity refs and the connection-relative tick stamps in here do not survive a
        // world change. WorldHelper.getTicks() restarts at zero on a new connection, so
        // stale stamps would read as "seen in the future" and linger.
        _lastCloseTick.clear();
        _closeAnnoyingEntities.clear();
        // same reason, different owner: the flee task's sighting ledger is static (it has
        // to outlive the task), which also means nothing else ever drops it - and every
        // entry is a strong ref to an Entity, hence to its Level, hence to that world's
        // chunk cache.
        RunAwayFromHostilesTask.forget();
        _threatScanTick = -1;
        _threatScan = new ArrayList<>();
        _lastStillPos = null;
        _lastHealth = -1;
        super.onStop(mod);
    }

    @Override
    public String getName() {
        return "Mob Defense";
    }
}
