/**
 * ColorPaletteField – Color picker with palette swatches for forms.
 *
 * Combines Chakra UI's full ColorPicker (area, hue slider, hex input, eyedropper)
 * with preset swatches from the entity palette.
 * Used in AccountFormDialog and ConnectorFormDialog.
 */

import React from 'react';
import { Box, ColorPicker, Flex, HStack, Portal, Text, parseColor } from '@chakra-ui/react';
import { ENTITY_COLOR_PALETTE, DEFAULT_ENTITY_COLOR } from '../hooks/useEntityColors';

interface ColorPaletteFieldProps {
    value?: string | null;
    onChange: (color: string | null) => void;
    label?: string;
    /** Colors already in use – the picker will visually dim them */
    usedColors?: string[];
}

export const ColorPaletteField: React.FC<ColorPaletteFieldProps> = ({
    value,
    onChange,
    label = 'Color',
    usedColors = [],
}) => {
    const usedSet = new Set(usedColors.map(c => c?.toLowerCase()));
    const currentColor = value || DEFAULT_ENTITY_COLOR;

    const handleValueChange = (details: ColorPicker.ValueChangeDetails) => {
        onChange(details.value.toString('hex'));
    };

    return (
        <Box>
            <Text fontWeight="medium" mb={1.5}>{label}</Text>
            <ColorPicker.Root
                value={parseColor(currentColor)}
                onValueChange={handleValueChange}
            >
                <ColorPicker.Control>
                    <ColorPicker.Input />
                    <ColorPicker.Trigger />
                </ColorPicker.Control>
                <Portal>
                    <ColorPicker.Positioner style={{ zIndex: 1500 }}>
                        <ColorPicker.Content>
                            <ColorPicker.Area />
                            <HStack>
                                <ColorPicker.EyeDropper />
                                <ColorPicker.ChannelSlider channel="hue" />
                            </HStack>
                            <ColorPicker.SwatchGroup>
                                {ENTITY_COLOR_PALETTE.map(hex => {
                                    const isUsed = usedSet.has(hex.toLowerCase());
                                    return (
                                        <ColorPicker.SwatchTrigger
                                            key={hex}
                                            value={hex}
                                            style={isUsed ? { opacity: 0.35 } : undefined}
                                            title={isUsed ? `${hex} (in use)` : hex}
                                        >
                                            <ColorPicker.Swatch value={hex} />
                                        </ColorPicker.SwatchTrigger>
                                    );
                                })}
                            </ColorPicker.SwatchGroup>
                        </ColorPicker.Content>
                    </ColorPicker.Positioner>
                </Portal>
            </ColorPicker.Root>
        </Box>
    );
};

export default ColorPaletteField;
