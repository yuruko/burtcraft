package adris.altoclef.eventbus.events;

import com.mojang.authlib.GameProfile;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.PlayerChatMessage;

/**
 * Whenever chat appears
 */
public class ChatMessageEvent {
    PlayerChatMessage message;
    GameProfile sender;
    ChatType.Bound messageType;

    public ChatMessageEvent(PlayerChatMessage message, GameProfile sender, ChatType.Bound messageType) {
        this.message = message;
        this.sender = sender;
        this.messageType = messageType;
    }
    public String messageContent() {
        return message.decoratedContent().getString();
    }

    public String senderName() {
        return sender.name();
    }

    // the mojang ACCOUNT name only. on any server running a nick/rank plugin
    // this is not the name the room uses - resolve the speaker from the
    // rendered line (bound().decorate(contentComponent())) instead, and keep
    // this as the vanilla fallback.
    public GameProfile senderProfile() {
        return sender;
    }

    public net.minecraft.network.chat.Component contentComponent() {
        return message.decoratedContent();
    }

    public ChatType.Bound bound() {
        return messageType;
    }

    public ChatType messageType() {
        return messageType.chatType().value();
    }
}
