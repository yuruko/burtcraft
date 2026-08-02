package adris.altoclef.mixins;

import com.mojang.authlib.GameProfile;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.world.entity.player.ProfilePublicKey;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(LocalPlayer.class)
public abstract class MixinLocalPlayer extends AbstractClientPlayer {

    public MixinLocalPlayer(ClientLevel world, GameProfile profile, ProfilePublicKey publicKey) {
        super(world, profile);
    }

    @Inject(method = "getViewXRot", at = @At("RETURN"), cancellable = true)
    public void burtcraft$viewXRot(float tickDelta, CallbackInfoReturnable<Float> cir) {
        cir.setReturnValue(super.getViewXRot(tickDelta));
    }

    @Inject(method = "getViewYRot", at = @At("RETURN"), cancellable = true)
    public void burtcraft$viewYRot(float tickDelta, CallbackInfoReturnable<Float> cir) {
        cir.setReturnValue(super.getViewYRot(tickDelta));
    }
}