import React, { useState } from 'react';
import { FiCopy, FiCheck } from 'react-icons/fi';
import { Tooltip } from './ui/tooltip';

interface CopyableValueProps {
    /** The string value to display and copy */
    value: string;
    /** Max characters to show before truncating (0 = no truncation) */
    truncate?: number;
    /** Font size (default: "10px") */
    fontSize?: string;
    /** Additional className */
    className?: string;
}

/**
 * CopyableValue - Displays a mono-styled selectable text with a copy-to-clipboard button on hover.
 * Truncates long values with tooltip showing full text.
 */
export const CopyableValue: React.FC<CopyableValueProps> = ({
    value,
    truncate = 0,
    fontSize = '10px',
}) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // fallback: ignore
        }
    };

    const displayValue = truncate > 0 && value.length > truncate
        ? `${value.slice(0, truncate)}…`
        : value;

    const needsTooltip = truncate > 0 && value.length > truncate;

    const content = (
        <div className="group flex items-center gap-1" style={{ userSelect: 'text', cursor: 'text' }}>
            <span
                className="break-all text-right font-mono text-slate-700"
                style={{ fontSize }}
            >
                {displayValue}
            </span>
            <button
                type="button"
                onClick={handleCopy}
                className={`shrink-0 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 ${copied ? 'text-green-500 hover:text-green-500' : 'text-slate-400 hover:text-blue-500'}`}
                aria-label="Copy to clipboard"
            >
                {copied ? <FiCheck size={10} /> : <FiCopy size={10} />}
            </button>
        </div>
    );

    if (needsTooltip) {
        return (
            <Tooltip content={value}>
                {content}
            </Tooltip>
        );
    }

    return content;
};

export default CopyableValue;
