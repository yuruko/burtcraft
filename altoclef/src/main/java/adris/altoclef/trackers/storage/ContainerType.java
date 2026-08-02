package adris.altoclef.trackers.storage;

import adris.altoclef.util.slots.ChestSlot;
import adris.altoclef.util.slots.FurnaceSlot;
import adris.altoclef.util.slots.Slot;
import net.minecraft.world.*;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.entity.*;
import net.minecraft.world.level.block.grower.*;
import net.minecraft.world.level.block.piston.*;
import net.minecraft.world.level.block.state.*;
import net.minecraft.world.level.block.state.properties.*;
import net.minecraft.world.level.material.*;
import net.minecraft.world.phys.shapes.*;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.*;
import net.minecraft.world.*;
import net.minecraft.world.inventory.*;
import org.apache.commons.lang3.NotImplementedException;

public enum ContainerType {
    CHEST, ENDER_CHEST, SHULKER, FURNACE, BREWING, MISC, EMPTY;

    public static ContainerType getFromBlock(Block block) {
        if (block instanceof ChestBlock) {
            return CHEST;
        }
        if (block instanceof AbstractFurnaceBlock) {
            return FURNACE;
        }
        if (block.equals(Blocks.ENDER_CHEST)) {
            return ENDER_CHEST;
        }
        if (block instanceof ShulkerBoxBlock) {
            return SHULKER;
        }
        if (block instanceof BrewingStandBlock) {
            return BREWING;
        }
        if (block instanceof BarrelBlock || block instanceof DispenserBlock || block instanceof HopperBlock) {
            return MISC;
        }
        return EMPTY;
    }

    public static boolean screenHandlerMatches(ContainerType type, AbstractContainerMenu handler) {
        switch (type) {
            case CHEST, ENDER_CHEST -> {
                return handler instanceof ChestMenu;
            }
            case SHULKER -> {
                return handler instanceof ShulkerBoxMenu;
            }
            case FURNACE -> {
                return handler instanceof AbstractFurnaceMenu;
            }
            case BREWING -> {
                return handler instanceof BrewingStandMenu;
            }
            case MISC -> {
                return handler instanceof DispenserMenu || handler instanceof ChestMenu;
            }
            case EMPTY -> {
                return false;
            }
            default -> throw new NotImplementedException("Missed this chest type: " + type);
        }
    }

    public static boolean screenHandlerMatches(ContainerType type) {
        if (Minecraft.getInstance().player != null) {
            AbstractContainerMenu h = Minecraft.getInstance().player.containerMenu;
            if (h != null)
                return screenHandlerMatches(type, h);
        }
        return false;
    }

    public static boolean screenHandlerMatchesAny() {
        return screenHandlerMatches(CHEST) ||
                screenHandlerMatches(SHULKER) ||
                screenHandlerMatches(FURNACE);
    }

    public static boolean slotTypeMatches(ContainerType type, Slot slot) {
        switch (type) {
            case CHEST, ENDER_CHEST, SHULKER -> {
                return slot instanceof ChestSlot;
            }
            case FURNACE -> {
                return slot instanceof FurnaceSlot;
            }
            case BREWING -> throw new NotImplementedException("Brewing slots not implemented yet.");
            case MISC -> {
                return true;
            }
            default -> throw new NotImplementedException("Missed this chest type: " + type);
        }
    }
}
