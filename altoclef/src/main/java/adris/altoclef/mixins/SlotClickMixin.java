package adris.altoclef.mixins;

import adris.altoclef.eventbus.EventBus;
import adris.altoclef.eventbus.events.SlotClickChangedEvent;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.core.NonNullList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

import java.util.ArrayList;
import java.util.List;

@Mixin(AbstractContainerMenu.class)
public class SlotClickMixin {

    // 26.1: onSlotClick/internalOnSlotClick are clicked/doClick, and the recursive
    // self-call this hooks now lives inside doClick.
    @Redirect(
            method = "doClick",
            at = @At(value = "INVOKE", target = "Lnet/minecraft/world/inventory/AbstractContainerMenu;doClick(IILnet/minecraft/world/inventory/ContainerInput;Lnet/minecraft/world/entity/player/Player;)V")
    )
    private void slotClick(AbstractContainerMenu self, int slotIndex, int button, ContainerInput actionType, Player player) {
        // TODO: "self" is misleading, reread Mixin docs to understand the implications here.

        // This calculation is already done, BUT we also want a "before&after" type beat.

        NonNullList<Slot> afterSlots = self.slots;
        List<ItemStack> beforeStacks = new ArrayList<>(afterSlots.size());
        for (Slot slot : afterSlots) {
            beforeStacks.add(slot.getItem().copy());
        }
        // Perform slot changes potentially
        self.clicked(slotIndex, button, actionType, player);
        // Check for changes and alert
        for (int i = 0; i < beforeStacks.size(); ++i) {
            ItemStack before = beforeStacks.get(i);
            ItemStack after = afterSlots.get(i).getItem();
            if (!ItemStack.matches(before, after)) {
                adris.altoclef.util.slots.Slot slot = adris.altoclef.util.slots.Slot.getFromCurrentScreen(i);
                EventBus.publish(new SlotClickChangedEvent(slot, before, after));
            }
        }
    }
}
