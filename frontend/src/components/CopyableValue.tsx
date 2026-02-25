import React, { useState } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
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
        <Flex
            align="center"
            gap={1}
            role="group"
            css={{ userSelect: 'text', cursor: 'text' }}
        >
            <Text
                fontSize={fontSize}
                fontFamily="mono"
                color="gray.700"
                wordBreak="break-all"
                textAlign="right"
            >
                {displayValue}
            </Text>
            <Box
                as="button"
                onClick={handleCopy}
                opacity={0}
                _groupHover={{ opacity: 1 }}
                transition="opacity 0.15s"
                cursor="pointer"
                flexShrink={0}
                color={copied ? 'green.500' : 'gray.400'}
                _hover={{ color: copied ? 'green.500' : 'blue.500' }}
                aria-label="Copy to clipboard"
            >
                {copied ? <FiCheck size={10} /> : <FiCopy size={10} />}
            </Box>
        </Flex>
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
