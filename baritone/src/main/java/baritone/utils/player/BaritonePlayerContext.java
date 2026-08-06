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

package baritone.utils.player;

import baritone.Baritone;
import baritone.api.cache.IWorldData;
import baritone.api.utils.*;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.HitResult;

/**
 * Implementation of {@link IPlayerContext} that provides information about the primary player.
 *
 * @author Brady
 * @since 11/12/2018
 */
public final class BaritonePlayerContext implements IPlayerContext {

    private final Baritone baritone;
    private final Minecraft mc;
    private final IPlayerController playerController;

    public BaritonePlayerContext(Baritone baritone, Minecraft mc) {
        this.baritone = baritone;
        this.mc = mc;
        this.playerController = new BaritonePlayerController(mc);
    }

    @Override
    public Minecraft minecraft() {
        return this.mc;
    }

    @Override
    public LocalPlayer player() {
        return this.mc.player;
    }

    @Override
    public IPlayerController playerController() {
        return this.playerController;
    }

    @Override
    public Level world() {
        return this.mc.level;
    }

    @Override
    public IWorldData worldData() {
        return this.baritone.getWorldProvider().getCurrentWorld();
    }

    @Override
    public BetterBlockPos viewerPos() {
        final Entity entity = this.mc.getCameraEntity();
        return entity == null ? this.playerFeet() : BetterBlockPos.from(entity.blockPosition());
    }

    @Override
    public Rotation playerRotations() {
        return this.baritone.getLookBehavior().getEffectiveRotation().orElseGet(IPlayerContext.super::playerRotations);
    }

    @Override
    public HitResult objectMouseOver() {
        // BURNT: cast from the eye she ACTUALLY has. this used the 3-arg overload,
        // which always assumes a standing eye - but the builder forces SNEAK while
        // placing and validates reachability against the CROUCHING eye
        // (BuilderProcess#possibleToPlace -> inferSneakingEyePosition). the two rays
        // start 0.35 blocks apart and are both hard-clipped at 4.5, so a target that
        // is 4.47 away to the deciding ray can be 4.52 away to the executing one:
        // baritone commits to the placement, cancels its path, clicks forever, and
        // nothing lands. that is the "block is literally 1 pixel too far away, nudge
        // her forward and she carries on" freeze reported from a live build.
        return RayTraceUtils.rayTraceTowards(player(), playerRotations(),
                playerController().getBlockReachDistance(), player().isShiftKeyDown());
    }
}
