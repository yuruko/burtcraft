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

    public ChatType messageType() {
        return messageType.chatType().value();
    }
}
