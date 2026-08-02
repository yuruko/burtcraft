package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.ChatMessageEvent;
import com.mojang.authlib.GameProfile;
import net.minecraft.client.multiplayer.chat.ChatListener;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.PlayerChatMessage;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;


@Mixin(ChatListener.class)
public final class ChatReadMixin {
    @Inject(
            method = "handlePlayerChatMessage",
            at = @At("HEAD")
    )
    private void onChatMessage(PlayerChatMessage message, GameProfile sender, ChatType.Bound params, CallbackInfo ci) {
        ChatMessageEvent evt = new ChatMessageEvent(message, sender, params);
        EventBus.publish(evt);
    }
}