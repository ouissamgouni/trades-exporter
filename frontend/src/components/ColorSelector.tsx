import React from 'react';
import { HStack, ColorPicker, Portal, parseColor } from '@chakra-ui/react';
import { CATEGORY_COLOR_PALETTE } from '../constants/colors';

interface ColorSelectorProps {
    value: string;
    onChange: (color: string) => void;
}

/**
 * Color selector component using Chakra UI's built-in ColorPicker.
 * Displays a color input with trigger, area picker, hue slider, and preset swatches.
 */
export const ColorSelector: React.FC<ColorSelectorProps> = ({ value, onChange }) => {
    const handleValueChange = (details: ColorPicker.ValueChangeDetails) => {
        onChange(details.value.toString('hex'));
    };

    return (
        <ColorPicker.Root
            defaultValue={parseColor(value || CATEGORY_COLOR_PALETTE[0])}
            onValueChange={handleValueChange}
        >
            <ColorPicker.Control>
                <ColorPicker.Input />
                <ColorPicker.Trigger />
            </ColorPicker.Control>
            <Portal>
                <ColorPicker.Positioner>
                    <ColorPicker.Content>
                        <ColorPicker.Area />
                        <HStack>
                            <ColorPicker.EyeDropper />
                            <ColorPicker.ChannelSlider channel="hue" />
                        </HStack>
                        <ColorPicker.SwatchGroup>
                            {CATEGORY_COLOR_PALETTE.map((color) => (
                                <ColorPicker.SwatchTrigger key={color} value={color}>
                                    <ColorPicker.Swatch value={color} />
                                </ColorPicker.SwatchTrigger>
                            ))}
                        </ColorPicker.SwatchGroup>
                    </ColorPicker.Content>
                </ColorPicker.Positioner>
            </Portal>
        </ColorPicker.Root>
    );
};

export default ColorSelector;
