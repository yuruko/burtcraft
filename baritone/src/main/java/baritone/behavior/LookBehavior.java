/*
 * This file is part of Baritone.
 *
 * Baritone is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Baritone is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Baritone.  If not, see <https://www.gnu.org/licenses/>.
 */

package baritone.behavior;

import baritone.Baritone;
import baritone.api.Settings;
import baritone.api.behavior.ILookBehavior;
import baritone.api.behavior.look.IAimProcessor;
import baritone.api.behavior.look.ITickableAimProcessor;
import baritone.api.event.events.*;
import baritone.api.utils.IPlayerContext;
import baritone.api.utils.Rotation;
import baritone.behavior.look.ForkableRandom;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Optional;

public final class LookBehavior extends Behavior implements ILookBehavior {

    private static final float SMOOTHING_YAW_THRESHOLD = 10.0f;
    private static final float SMOOTHING_PITCH_THRESHOLD = 7.0f;
    private static final float DEFAULT_PITCH = 0.0f; // Default pitch to look straight ahead (skyline)
    // Cosmetic pitch stabilization: the pathing look target flaps between "down at
    // the next block" and "level at the walk target" tick to tick, and chasing every
    // flap reads as camera jitter. Pitch is averaged over a longer window than yaw
    // (a lagged head-tilt looks human, a lagged turn looks drunk) and moves only
    // when the averaged target escapes a small deadband.
    private static final int PITCH_SMOOTH_TICKS = 12;
    private static final float PITCH_DEADBAND_DEGREES = 3.0f;
    private static final float PITCH_MAX_DEGREES_PER_TICK = 2.0f;
    // how much of the look-down past the cap survives, so a real descent still
    // tips her head a little instead of clipping to a dead-flat stare
    private static final float TRAVEL_PITCH_RESIDUAL = 0.25f;

    private Target target;
    private Rotation serverRotation;
    private Rotation prevRotation;
    private final AimProcessor processor;
    private final Deque<Float> smoothYawBuffer;
    private final Deque<Float> smoothPitchBuffer;
    private float currentYaw;
    private float currentPitch;
    private int smoothingCounter;
    private Rotation lastTargetRotation;

    public LookBehavior(Baritone baritone) {
        super(baritone);
        this.processor = new AimProcessor(baritone.getPlayerContext());
        this.smoothYawBuffer = new ArrayDeque<>();
        this.smoothPitchBuffer = new ArrayDeque<>();
        this.currentPitch = DEFAULT_PITCH; // Initialize current pitch to look at the skyline
    }

    @Override
    public void updateTarget(Rotation rotation, boolean blockInteract) {
        this.target = new Target(rotation, Target.Mode.resolve(ctx, blockInteract));

        // Interactions need exact ray-trace alignment immediately. Smoothing
        // these rotations is visually soft but causes missed breaks/placements.
        if (blockInteract) {
            currentYaw = rotation.getYaw();
            currentPitch = rotation.getPitch();
            smoothingCounter = 0;
        } else if (smoothingCounter == 0 && isMeaningfulTurn(rotation)) {
            currentYaw = ctx.player().getYRot();
            currentPitch = ctx.player().getXRot();
            smoothingCounter = configuredSmoothingTicks();
        }
        lastTargetRotation = rotation;
    }

    @Override
    public IAimProcessor getAimProcessor() {
        return this.processor;
    }

    @Override
    public void onTick(TickEvent event) {
        if (event.getType() == TickEvent.Type.IN) {
            this.processor.tick();
        }
    }

    @Override
    public void onPlayerUpdate(PlayerUpdateEvent event) {
        if (this.target == null) {
            return;
        }

        switch (event.getState()) {
            case PRE: {
                if (this.target.mode == Target.Mode.NONE) {
                    return;
                }

                this.prevRotation = new Rotation(ctx.player().getYRot(), ctx.player().getXRot());
                Rotation targetRotation = this.target.rotation;

                if (smoothingCounter > 0) {
                    currentYaw = lerpAngle(currentYaw, targetRotation.getYaw(), 1.0f / smoothingCounter);
                    currentPitch = lerp(currentPitch, targetRotation.getPitch(), 1.0f / smoothingCounter);
                    smoothingCounter--;
                } else {
                    currentYaw = targetRotation.getYaw();
                    currentPitch = targetRotation.getPitch();
                }

                ctx.player().setYRot(currentYaw);
                ctx.player().setXRot(currentPitch);
                break;
            }
            case POST: {
                if (this.prevRotation != null) {
                    this.smoothYawBuffer.addLast(this.target.rotation.getYaw());
                    while (this.smoothYawBuffer.size() > Math.max(2, configuredSmoothingTicks())) {
                        this.smoothYawBuffer.removeFirst();
                    }
                    this.smoothPitchBuffer.addLast(this.target.rotation.getPitch());
                    while (this.smoothPitchBuffer.size() > PITCH_SMOOTH_TICKS) {
                        this.smoothPitchBuffer.removeFirst();
                    }
                    if (this.target.mode == Target.Mode.SERVER) {
                        if (Baritone.settings().smoothCameraFollow.value) {
                            // Cosmetic only: ease the RENDERED camera toward the look target so
                            // travel/idle reads as a smooth head-turn on stream instead of a frozen
                            // stare or a hard snap to each path segment. This runs in POST (after the
                            // tick's movement was already computed from the PRE rotation), so it never
                            // changes pathing, and the aim sent to the server is still exact via
                            // onPlayerRotationMove - so mining alignment (CLIENT-mode snap) is untouched.
                            // The camera chases the time-AVERAGED target, never the raw per-tick one:
                            // a target that flaps down/level every tick averages to a steady mid-pitch
                            // instead of shaking the screen, and small drifts sit inside the deadband.
                            float maxStep = Baritone.settings().cameraFollowMaxDegreesPerTick.value.floatValue();
                            if (maxStep <= 0.0f) maxStep = 0.01f;
                            ctx.player().setYRot(approachYaw(this.prevRotation.getYaw(), averageYawAround(this.prevRotation.getYaw()), maxStep));
                            ctx.player().setXRot(stabilizedPitch(this.prevRotation.getPitch(), Math.min(maxStep, PITCH_MAX_DEGREES_PER_TICK)));
                        } else {
                            ctx.player().setYRot(this.prevRotation.getYaw());
                            ctx.player().setXRot(this.prevRotation.getPitch());
                        }
                    } else if (ctx.player().isFallFlying() ? Baritone.settings().elytraSmoothLook.value : Baritone.settings().smoothLook.value) {
                        if (configuredSmoothingTicks() == 0) {
                            ctx.player().setYRot(this.target.rotation.getYaw());
                            if (ctx.player().isFallFlying()) ctx.player().setXRot(this.target.rotation.getPitch());
                        } else if (ctx.player().isFallFlying()) {
                            // elytra needs a responsive pitch: keep the short-window average
                            ctx.player().setYRot(averageYawAround(this.prevRotation.getYaw()));
                            ctx.player().setXRot((float) this.smoothPitchBuffer.stream().skip(Math.max(0, this.smoothPitchBuffer.size() - Math.max(2, configuredSmoothingTicks()))).mapToDouble(d -> d).average().orElse(this.prevRotation.getPitch()));
                        } else {
                            // on the ground: yaw follows the short average (snappy), pitch gets the
                            // same stabilized treatment as the camera-follow path - previously ground
                            // pitch was never smoothed at all, which is exactly the walk jitter
                            ctx.player().setYRot(averageYawAround(this.prevRotation.getYaw()));
                            ctx.player().setXRot(stabilizedPitch(this.prevRotation.getPitch(), PITCH_MAX_DEGREES_PER_TICK));
                        }
                    }
                    this.prevRotation = null;
                }
                this.target = null;
                break;
            }
            default:
                break;
        }
    }

    private float lerp(float start, float end, float alpha) {
        return start + alpha * (end - start);
    }

    private float lerpAngle(float start, float end, float alpha) {
        return start + alpha * Rotation.normalizeYaw(end - start);
    }

    // Average the buffered yaw samples RELATIVE to an anchor so the mean is
    // wrap-safe (-179 and +179 must average to 180, not 0).
    private float averageYawAround(float anchor) {
        if (this.smoothYawBuffer.isEmpty()) return anchor;
        double sum = 0;
        for (float sample : this.smoothYawBuffer) {
            sum += Rotation.normalizeYaw(sample - anchor);
        }
        return anchor + (float) (sum / this.smoothYawBuffer.size());
    }

    // Cosmetic pitch with flap rejection: chase the multi-tick average of the
    // pitch targets, ignore it entirely inside the deadband, and move at a
    // bounded human speed. A target alternating down/level every tick becomes
    // one steady mid-tilt instead of per-frame jitter.
    private float stabilizedPitch(float currentPitch, float maxStep) {
        final double averaged = this.smoothPitchBuffer.stream().mapToDouble(d -> d).average().orElse(currentPitch);
        float target = (float) averaged;
        // LOOK WHERE SHE'S GOING. baritone aims at the next foothold, which is
        // usually a block at her feet, so on stream she walks around staring at
        // the dirt. cap how far down the RENDERED pitch is allowed to sit while
        // travelling and let it settle near the horizon.
        //
        // this is safe here and nowhere else: POST is the cosmetic pass (the tick's
        // movement was already computed from the PRE rotation) and the aim sent to
        // the server still goes out exactly via onPlayerRotationMove. block
        // interaction uses the CLIENT-mode snap path and never reaches this
        // function - which matters, because DestroyBlockTask force-attacks before
        // alignment finishes, so softening an interaction aim breaks mining.
        if (Baritone.settings().travelLookAhead.value && !ctx.player().isFallFlying()) {
            final float maxDown = Baritone.settings().travelMaxPitchDown.value.floatValue();
            if (target > maxDown) {
                // ease toward the horizon rather than pinning exactly at the cap,
                // so a genuine downhill still reads as a slight look-down
                target = maxDown + (target - maxDown) * TRAVEL_PITCH_RESIDUAL;
            }
        }
        if (Math.abs(target - currentPitch) <= PITCH_DEADBAND_DEGREES) {
            return currentPitch;
        }
        return approachPitch(currentPitch, target, maxStep <= 0.0f ? 0.01f : maxStep);
    }

    // Move `current` toward `target` by at most `maxStep` degrees, snapping to exact
    // when within one step so the cosmetic follow always converges (no residual jitter).
    private float approachPitch(float current, float target, float maxStep) {
        float delta = target - current;
        if (Math.abs(delta) <= maxStep) return target;
        return current + Math.copySign(maxStep, delta);
    }

    // Same, but across the shortest angular path so a wrap-around turn doesn't spin the long way.
    private float approachYaw(float current, float target, float maxStep) {
        float delta = Rotation.normalizeYaw(target - current);
        if (Math.abs(delta) <= maxStep) return target;
        return current + Math.copySign(maxStep, delta);
    }

    private boolean isMeaningfulTurn(Rotation next) {
        if (lastTargetRotation == null) return true;
        float yawDelta = Math.abs(Rotation.normalizeYaw(next.getYaw() - lastTargetRotation.getYaw()));
        float pitchDelta = Math.abs(next.getPitch() - lastTargetRotation.getPitch());
        return yawDelta >= SMOOTHING_YAW_THRESHOLD || pitchDelta >= SMOOTHING_PITCH_THRESHOLD;
    }

    private int configuredSmoothingTicks() {
        // Honor a user's lower value (0 = fully snapped), but cap legacy
        // configs at two ticks so an old `smoothLookTicks 5` cannot restore the
        // sluggish camera behavior this fork previously shipped.
        return Math.max(0, Math.min(2, Baritone.settings().smoothLookTicks.value));
    }

    @Override
    public void onSendPacket(PacketEvent event) {
        if (!(event.getPacket() instanceof ServerboundMovePlayerPacket)) {
            return;
        }

        final ServerboundMovePlayerPacket packet = (ServerboundMovePlayerPacket) event.getPacket();
        if (packet instanceof ServerboundMovePlayerPacket.Rot || packet instanceof ServerboundMovePlayerPacket.PosRot) {
            this.serverRotation = new Rotation(packet.getYRot(0.0f), packet.getXRot(0.0f));
        }
    }

    @Override
    public void onWorldEvent(WorldEvent event) {
        this.serverRotation = null;
        this.target = null;
        this.lastTargetRotation = null;
        this.smoothingCounter = 0;
        // stale samples from the previous world must not steer the new camera
        this.smoothYawBuffer.clear();
        this.smoothPitchBuffer.clear();
    }

    public void pig() {
        if (this.target != null) {
            final Rotation actual = this.processor.peekRotation(this.target.rotation);
            ctx.player().setYRot(actual.getYaw());
        }
    }

    public Optional<Rotation> getEffectiveRotation() {
        if (Baritone.settings().freeLook.value) {
            return Optional.ofNullable(this.serverRotation);
        }
        return Optional.empty();
    }

    @Override
    public void onPlayerRotationMove(RotationMoveEvent event) {
        if (this.target != null) {
            final Rotation actual = this.processor.peekRotation(this.target.rotation);
            event.setYaw(actual.getYaw());
            event.setPitch(actual.getPitch());
        }
    }

    private static final class AimProcessor extends AbstractAimProcessor {

        public AimProcessor(final IPlayerContext ctx) {
            super(ctx);
        }

        @Override
        protected Rotation getPrevRotation() {
            return ctx.playerRotations();
        }
    }

    private static abstract class AbstractAimProcessor implements ITickableAimProcessor {

        protected final IPlayerContext ctx;
        private final ForkableRandom rand;
        private double randomYawOffset;
        private double randomPitchOffset;

        public AbstractAimProcessor(IPlayerContext ctx) {
            this.ctx = ctx;
            this.rand = new ForkableRandom();
        }

        private AbstractAimProcessor(final AbstractAimProcessor source) {
            this.ctx = source.ctx;
            this.rand = source.rand.fork();
            this.randomYawOffset = source.randomYawOffset;
            this.randomPitchOffset = source.randomPitchOffset;
        }

        @Override
        public final Rotation peekRotation(final Rotation rotation) {
            final Rotation prev = this.getPrevRotation();

            float desiredYaw = rotation.getYaw();
            float desiredPitch = rotation.getPitch();

            if (desiredPitch == prev.getPitch()) {
                desiredPitch = nudgeToLevel(desiredPitch);
            }

            desiredYaw += this.randomYawOffset;
            desiredPitch += this.randomPitchOffset;

            return new Rotation(
                    this.calculateMouseMove(prev.getYaw(), desiredYaw),
                    this.calculateMouseMove(prev.getPitch(), desiredPitch)
            ).clamp();
        }

        @Override
        public final void tick() {
            this.randomYawOffset = (this.rand.nextDouble() - 0.5) * Baritone.settings().randomLooking.value;
            this.randomPitchOffset = (this.rand.nextDouble() - 0.5) * Baritone.settings().randomLooking.value;

            double random = this.rand.nextDouble() - 0.5;
            if (Math.abs(random) < 0.1) {
                random *= 4;
            }
            this.randomYawOffset += random * Baritone.settings().randomLooking113.value;
        }

        @Override
        public final void advance(int ticks) {
            for (int i = 0; i < ticks; i++) {
                this.tick();
            }
        }

        @Override
        public Rotation nextRotation(final Rotation rotation) {
            final Rotation actual = this.peekRotation(rotation);
            this.tick();
            return actual;
        }

        @Override
        public final ITickableAimProcessor fork() {
            return new AbstractAimProcessor(this) {

                private Rotation prev = AbstractAimProcessor.this.getPrevRotation();

                @Override
                public Rotation nextRotation(final Rotation rotation) {
                    return (this.prev = super.nextRotation(rotation));
                }

                @Override
                protected Rotation getPrevRotation() {
                    return this.prev;
                }
            };
        }

        protected abstract Rotation getPrevRotation();

        private float nudgeToLevel(float pitch) {
            if (pitch < -20) {
                return pitch + 1;
            } else if (pitch > 10) {
                return pitch - 1;
            }
            return pitch;
        }

        private float calculateMouseMove(float current, float target) {
            final float delta = target - current;
            final double deltaPx = angleToMouse(delta);
            return current + mouseToAngle(deltaPx);
        }

        private double angleToMouse(float angleDelta) {
            final float minAngleChange = mouseToAngle(1);
            return Math.round(angleDelta / minAngleChange);
        }

        private float mouseToAngle(double mouseDelta) {
            final double f = ctx.minecraft().options.sensitivity().get() * (double) 0.6f + (double) 0.2f;
            return (float) (mouseDelta * f * f * f * 8.0d) * 0.15f;
        }
    }

    private static class Target {

        public final Rotation rotation;
        public final Mode mode;

        public Target(Rotation rotation, Mode mode) {
            this.rotation = rotation;
            this.mode = mode;
        }

        enum Mode {
            CLIENT,
            SERVER,
            NONE;

            static Mode resolve(IPlayerContext ctx, boolean blockInteract) {
                final Settings settings = Baritone.settings();
                final boolean antiCheat = settings.antiCheatCompatibility.value;
                final boolean blockFreeLook = settings.blockFreeLook.value;

                if (ctx.player().isFallFlying()) {
                    return settings.elytraFreeLook.value ? SERVER : CLIENT;
                } else if (settings.freeLook.value) {
                    if (blockInteract) {
                        return blockFreeLook ? SERVER : CLIENT;
                    }
                    return antiCheat ? SERVER : NONE;
                }

                return CLIENT;
            }
        }
    }
}
