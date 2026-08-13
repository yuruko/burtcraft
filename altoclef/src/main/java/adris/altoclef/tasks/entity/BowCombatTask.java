package adris.altoclef.tasks.entity;

import adris.altoclef.AltoClef;
import adris.altoclef.tasks.movement.GetToEntityTask;
import adris.altoclef.tasks.movement.RunAwayFromEntitiesTask;
import adris.altoclef.tasksystem.Task;
import adris.altoclef.util.helpers.CombatGear;
import adris.altoclef.util.helpers.LookHelper;
import adris.altoclef.util.time.TimerGame;
import baritone.api.utils.Rotation;
import baritone.api.utils.input.Input;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.Items;

import java.util.Collections;
import java.util.List;

/**
 * Fight something with a bow instead of walking into it.
 * <p>
 * She had no ranged option at all. {@link ShootArrowSimpleProjectileTask} existed, has
 * perfectly good gravity-corrected ballistics, and was wired to NOTHING outside
 * Playground - so against skeletons, pillagers and blazes her only plan was to close the
 * gap through their fire, and against a creeper her only plan was to walk up to a bomb.
 * <p>
 * The three things that make this a fight rather than a single shot:
 * <ul>
 *   <li><b>A pocket, not a point.</b> She holds a stand-off band and only shoots from
 *       inside it. Outside it she moves; she does not shoot on the move, because drawing
 *       a bow slows her to a crawl and fights whatever baritone is doing.</li>
 *   <li><b>Hysteresis on every band edge.</b> Enter and exit thresholds differ on
 *       purpose. A latch whose release threshold equals its trigger is a coin flip on
 *       sensor noise, and this file's neighbours have been bitten by that repeatedly.</li>
 *   <li><b>Movement sub-tasks are built ONCE.</b> Each is a CustomBaritoneGoalTask, and
 *       those force-cancel baritone on start - minting a fresh one per tick is exactly
 *       the rebuild storm that has frozen MobDefenseChain four separate times.</li>
 * </ul>
 */
public class BowCombatTask extends Task {

    /**
     * inside this she is being hit, so back off. Skeletons close to melee if you let
     * them, and a bow does nothing useful at contact range.
     */
    private static final double TOO_CLOSE = 5;
    /** ...and she stops backing off only once out here. Deliberately &gt; TOO_CLOSE. */
    private static final double BACKED_OFF_ENOUGH = 9;
    /** past this the shot is not worth taking - arrow drop and travel time get silly. */
    private static final double TOO_FAR = 20;
    /** ...and she stops closing in once inside here. Deliberately &lt; TOO_FAR. */
    private static final double CLOSE_ENOUGH = 15;
    /** raycast budget for "can I actually see it". */
    private static final double SIGHT_RANGE = 28;
    /**
     * how close the CLOSE_IN goal asks for.
     * <p>
     * ⚠ DELIBERATELY WELL INSIDE {@link #CLOSE_ENOUGH}, AND THAT IS THE WHOLE POINT.
     * This was CLOSE_ENOUGH (15), which meant losing line of sight at, say, 12 blocks
     * produced a GetToEntityTask whose goal was ALREADY SATISFIED - baritone instantly
     * in-goal, nothing to path, and GetToEntityTask resets its own progress checker every
     * tick while inside the distance, so its give-up could never fire either. She stood
     * perfectly still, unable to restore the line of sight that was the only exit
     * condition. Asking for a distance she is not already at means the goal always has
     * something to do.
     */
    private static final double LOS_APPROACH = 6;
    /**
     * no single intent may hold her longer than this without something changing.
     * <p>
     * ⚠ this used to be an AIM-only timer checked inside the SHOOT branch, which the
     * movement branches returned before ever reaching - so the two states that could
     * actually deadlock were the two with no bound at all.
     */
    private static final double STALL_SECONDS = 6;
    /** distance change that counts as "this is going somewhere". */
    private static final double PROGRESS_EPSILON = 0.5;
    /** a bow is fully drawn at 20 ticks; below that the arrow is weak and drops fast. */
    private static final int FULL_DRAW_TICKS = 20;
    /** total engagement bound, so a ranged fight can never become the whole evening. */
    private static final double ENGAGEMENT_MAX_SECONDS = 45;

    private final Entity _target;

    private Task _backOffTask;
    private Task _closeInTask;
    /** which movement intent is live. Only rebuilt when the intent CHANGES. */
    private Intent _intent = Intent.SHOOT;

    private final TimerGame _stallClock = new TimerGame(STALL_SECONDS);
    private final TimerGame _engagementClock = new TimerGame(ENGAGEMENT_MAX_SECONDS);
    private double _lastDistance = -1;
    private boolean _drawing = false;
    private boolean _gaveUp = false;

    public BowCombatTask(Entity target) {
        _target = target;
    }

    private enum Intent {SHOOT, BACK_OFF, CLOSE_IN}

    @Override
    protected void onStart(AltoClef mod) {
        _drawing = false;
        _gaveUp = false;
        _intent = Intent.SHOOT;
        _lastDistance = -1;
        _stallClock.reset();
        _engagementClock.reset();
    }

    @Override
    protected Task onTick(AltoClef mod) {
        if (!CombatGear.canShoot(mod) || _target == null || !_target.isAlive()) {
            releaseDraw(mod);
            _gaveUp = true;
            setDebugState("Out of arrows or target gone.");
            return null;
        }
        if (_engagementClock.elapsed()) {
            releaseDraw(mod);
            _gaveUp = true;
            setDebugState("Ranged engagement went long; handing back.");
            return null;
        }

        double distance = Math.sqrt(_target.distanceToSqr(mod.getPlayer()));
        boolean sees = LookHelper.seesPlayer(mod.getPlayer(), _target, SIGHT_RANGE);

        // ---- THE STALL DETECTOR, ABOVE THE INTENT DISPATCH ----
        // ⚠ IT HAS TO SIT HERE, NOT INSIDE THE SHOOT BRANCH. As an aim-only timer it
        // bounded the one state that was already fine and left both movement states
        // unbounded - and a CLOSE_IN whose goal is already satisfied moves her nowhere,
        // while the only exit from CLOSE_IN is regaining line of sight, which requires
        // moving. That is a hard freeze at chain priority 65, with UserTaskChain locked
        // out, for the whole 45s engagement clock. panicTick cannot rescue it either:
        // PANIC_TRIGGER_DISTANCE is 7 and this engagement lives at 5-20 blocks, so its
        // trigger radius is shorter than the fight it would have to supervise.
        //
        // Progress, not patience, is the right question: distance moving means the plan
        // is working, and a loosed arrow means the plan is working even standing still.
        if (_lastDistance < 0 || Math.abs(distance - _lastDistance) > PROGRESS_EPSILON) {
            _lastDistance = distance;
            _stallClock.reset();
        }
        if (_stallClock.elapsed()) {
            releaseDraw(mod);
            _gaveUp = true;
            setDebugState("Getting nowhere with the bow; handing back.");
            return null;
        }

        // ---- pick the intent, with hysteresis on both edges ----
        Intent wanted = _intent;
        switch (_intent) {
            case SHOOT -> {
                if (distance < TOO_CLOSE) wanted = Intent.BACK_OFF;
                else if (distance > TOO_FAR || !sees) wanted = Intent.CLOSE_IN;
            }
            case BACK_OFF -> {
                if (distance >= BACKED_OFF_ENOUGH) wanted = Intent.SHOOT;
            }
            case CLOSE_IN -> {
                if (distance <= CLOSE_ENOUGH && sees) wanted = Intent.SHOOT;
            }
        }
        if (wanted != _intent) {
            _intent = wanted;
            _stallClock.reset();
        }

        if (_intent != Intent.SHOOT) {
            // ⚠ drawing while moving slows her to a walk and makes the reposition take
            // longer than the thing it is escaping. Hands off the trigger while moving.
            releaseDraw(mod);
            if (_intent == Intent.BACK_OFF) {
                setDebugState("Too close - opening the range.");
                if (_backOffTask == null) _backOffTask = new BackOffFromTargetTask(_target, BACKED_OFF_ENOUGH);
                return _backOffTask;
            }
            setDebugState(sees ? "Closing to bow range." : "Moving for a clear shot.");
            if (_closeInTask == null) _closeInTask = new GetToEntityTask(_target, LOS_APPROACH);
            return _closeInTask;
        }

        // ---- in the pocket: aim, draw, loose ----
        mod.getSlotHandler().forceEquipItem(Items.BOW);
        Rotation aim = ShootArrowSimpleProjectileTask.calculateThrowLook(mod, _target);
        LookHelper.lookAt(mod, aim);

        if (!_drawing) {
            mod.getInputControls().hold(Input.CLICK_RIGHT);
            _drawing = true;
        }

        boolean fullyDrawn = mod.getPlayer().getTicksUsingItem() > FULL_DRAW_TICKS
                && mod.getPlayer().getUseItem().getItem() == Items.BOW;
        if (fullyDrawn && LookHelper.isLookingAt(mod, aim)) {
            releaseDraw(mod);
            // a loosed arrow IS progress, even though she has not moved an inch - without
            // this, shooting a stationary target reads as a stall and hands the fight back.
            _stallClock.reset();
            setDebugState("Loosed one.");
        } else {
            setDebugState("Drawing on " + _target.getType().getDescriptionId() + ".");
        }
        return null;
    }

    private void releaseDraw(AltoClef mod) {
        if (_drawing) {
            mod.getInputControls().release(Input.CLICK_RIGHT);
            _drawing = false;
        }
    }

    /** true when this stopped because ranged did not work, so melee should get a turn. */
    public boolean gaveUp() {
        return _gaveUp;
    }

    @Override
    public boolean isFinished(AltoClef mod) {
        return _gaveUp || _target == null || !_target.isAlive();
    }

    @Override
    protected void onStop(AltoClef mod, Task interruptTask) {
        releaseDraw(mod);
    }

    @Override
    protected boolean isEqual(Task other) {
        return other instanceof BowCombatTask task && task._target == _target;
    }

    @Override
    protected String toDebugString() {
        return "Shooting " + (_target == null ? "something" : _target.getType().getDescriptionId()) + " with a bow";
    }

    /**
     * Back away from one specific entity. RunAwayFromEntitiesTask is abstract and its
     * concrete siblings all run from the whole hostile list - here the point is to open
     * the range on the thing she is SHOOTING, not to leave the fight.
     */
    private static class BackOffFromTargetTask extends RunAwayFromEntitiesTask {
        private final Entity _from;

        BackOffFromTargetTask(Entity from, double distance) {
            super(() -> from == null || !from.isAlive() ? Collections.<Entity>emptyList() : List.of(from), distance, 1);
            _from = from;
        }

        @Override
        protected boolean isEqual(Task other) {
            return other instanceof BackOffFromTargetTask task && task._from == _from;
        }

        @Override
        protected String toDebugString() {
            return "Opening the range";
        }
    }
}
