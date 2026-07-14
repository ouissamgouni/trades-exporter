/**
 * DuplicateIcon
 *
 * Simple icon to indicate a transaction is a suspected duplicate.
 * Uses a "copy" icon to represent duplication.
 */

import React from 'react';
import { LuCopy } from 'react-icons/lu';
import { FiAlertTriangle } from 'react-icons/fi';

interface DuplicateIconProps {
    /** Size of the icon in px */
    size?: number;
    /** Color for the icon (Chakra token or CSS color) */
    color?: string;
}

export const DuplicateIcon: React.FC<DuplicateIconProps> = ({
    size = 12,
    color,
}) => {
    const warningSize = Math.max(8, Math.round(size * 0.65));
    return (
        <span className="inline-flex items-center gap-[2px]" style={{ color }}>
            <FiAlertTriangle size={warningSize} style={{ flexShrink: 0 }} />
            <LuCopy size={size} style={{ flexShrink: 0 }} />
        </span>
    );
};

export default DuplicateIcon;
