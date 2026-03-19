/**
 * BundleSuggestionIcon
 * 
 * Composite icon: 💡 (lamp prefix) + 📦 (bundle) to indicate
 * "this is a bundle suggestion". The lamp comes first to read as
 * "suggestion → for a bundle".
 */

import React from 'react';
import { Box } from '@chakra-ui/react';
import { LuLightbulb, LuPackage2 } from 'react-icons/lu';

interface BundleSuggestionIconProps {
    /** Size of the primary bundle icon in px */
    size?: number;
    /** Color for the icons (Chakra token or CSS color) */
    color?: string;
}

export const BundleSuggestionIcon: React.FC<BundleSuggestionIconProps> = ({
    size = 14,
    color,
}) => {
    const lampSize = Math.round(size * 0.6);

    return (
        <Box display="inline-flex" alignItems="center" gap="1px" color={color}>
            <LuLightbulb size={lampSize} style={{ flexShrink: 0 }} />
            <LuPackage2 size={size} style={{ flexShrink: 0 }} />
        </Box>
    );
};

export default BundleSuggestionIcon;
