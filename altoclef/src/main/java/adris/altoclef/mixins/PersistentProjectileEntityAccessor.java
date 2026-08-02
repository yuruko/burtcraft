package adris.altoclef.mixins;

import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(AbstractArrow.class)
public interface PersistentProjectileEntityAccessor {
    // the invoker MUST NOT share the target's name. isInGround() was private in
    // older versions (mixin emits a direct call, so the collision was harmless);
    // in 26.1.2 it is protected, so mixin emits a VIRTUAL call - a same-named
    // invoker then dispatches straight back to itself and every arrow tick
    // stack-overflows the client. keep the invoke* prefix.
    @Invoker("isInGround")
    boolean invokeIsInGround();
}
