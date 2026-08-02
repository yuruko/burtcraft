package adris.altoclef.eventbus.events;

import net.minecraft.client.gui.screens.Screen;

public class ScreenOpenEvent {
    public Screen screen;
    public boolean preOpen;

    public ScreenOpenEvent(Screen screen, boolean preOpen) {
        this.screen = screen;
        this.preOpen = preOpen;
    }
}
