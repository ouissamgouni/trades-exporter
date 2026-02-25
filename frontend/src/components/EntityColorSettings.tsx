/**
 * EntityColorSettings - Configuration panel for account & connector badge colors.
 *
 * Provides a grid of accounts and connectors, each with a clickable color
 * swatch that cycles through the available hex color palette.
 * Overrides are persisted in localStorage via useEntityColors.
 *
 * Can be embedded in any settings drawer, modal, or panel.
 */

import React from 'react';
import { Badge, Box, Button, Flex, Text } from '@chakra-ui/react';
import { FiRefreshCw } from 'react-icons/fi';
import { Account } from '../types';
import { useEntityColors, ENTITY_COLOR_PALETTE, hexToRgba } from '../hooks/useEntityColors';
import { Tooltip } from './ui/tooltip';

interface EntityColorSettingsProps {
    /** Available accounts to configure */
    accounts: Account[];
    /** Known connector names to configure */
    connectorNames: string[];
}

/** Small clickable circle showing a hex color */
const ColorSwatch: React.FC<{
    color: string;
    active?: boolean;
    onClick: () => void;
    size?: number;
}> = ({ color, active, onClick, size = 16 }) => (
    <Box
        as="button"
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="full"
        bg={color}
        border="2px solid"
        borderColor={active ? 'white' : 'transparent'}
        outline={active ? '2px solid' : 'none'}
        outlineColor={active ? color : undefined}
        cursor="pointer"
        onClick={onClick}
        _hover={{ transform: 'scale(1.2)' }}
        transition="transform 0.1s"
        flexShrink={0}
        title={color}
    />
);

export const EntityColorSettings: React.FC<EntityColorSettingsProps> = ({
    accounts,
    connectorNames,
}) => {
    const {
        getAccountColor,
        getConnectorColor,
        setAccountColor,
        setConnectorColor,
        resetAccountColor,
        resetConnectorColor,
        resetAllColors,
    } = useEntityColors();

    return (
        <Box>
            {/* Header */}
            <Flex justify="space-between" align="center" mb={3}>
                <Text fontSize="sm" fontWeight="bold" color="gray.700">Badge Colors</Text>
                <Tooltip content="Reset all colors to auto-assigned defaults">
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={resetAllColors}
                        fontSize="9px"
                    >
                        <FiRefreshCw size={10} />
                        Reset All
                    </Button>
                </Tooltip>
            </Flex>

            {/* Accounts */}
            {accounts.length > 0 && (
                <Box mb={4}>
                    <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={2} textTransform="uppercase">
                        Accounts
                    </Text>
                    <Flex direction="column" gap={1.5}>
                        {accounts.map(account => {
                            const currentColor = getAccountColor(account.id, account.name, account.color);
                            return (
                                <Flex key={account.id} align="center" gap={2} py={0.5}>
                                    <Badge
                                        size="xs"
                                        bg={hexToRgba(currentColor, 0.18)}
                                        color={currentColor}
                                        variant="subtle"
                                        fontSize="9px"
                                        minW="80px"
                                    >
                                        {account.name.length > 16 ? account.name.slice(0, 16) + '…' : account.name}
                                    </Badge>
                                    <Flex gap={0.5} align="center" flexWrap="wrap">
                                        {ENTITY_COLOR_PALETTE.map(hex => (
                                            <ColorSwatch
                                                key={hex}
                                                color={hex}
                                                active={currentColor.toLowerCase() === hex.toLowerCase()}
                                                onClick={() => setAccountColor(account.id, hex)}
                                                size={14}
                                            />
                                        ))}
                                    </Flex>
                                    <Tooltip content="Reset to auto">
                                        <Box
                                            as="button"
                                            fontSize="8px"
                                            color="gray.400"
                                            cursor="pointer"
                                            onClick={() => resetAccountColor(account.id)}
                                            _hover={{ color: 'gray.600' }}
                                            ml={1}
                                        >
                                            ✕
                                        </Box>
                                    </Tooltip>
                                </Flex>
                            );
                        })}
                    </Flex>
                </Box>
            )}

            {/* Connectors */}
            {connectorNames.length > 0 && (
                <Box>
                    <Text fontSize="xs" fontWeight="bold" color="gray.500" mb={2} textTransform="uppercase">
                        Connectors
                    </Text>
                    <Flex direction="column" gap={1.5}>
                        {connectorNames.map(name => {
                            const currentColor = getConnectorColor(name);
                            return (
                                <Flex key={name} align="center" gap={2} py={0.5}>
                                    <Badge
                                        size="xs"
                                        bg={hexToRgba(currentColor, 0.18)}
                                        color={currentColor}
                                        variant="subtle"
                                        fontSize="9px"
                                        minW="80px"
                                    >
                                        {name.length > 16 ? name.slice(0, 16) + '…' : name}
                                    </Badge>
                                    <Flex gap={0.5} align="center" flexWrap="wrap">
                                        {ENTITY_COLOR_PALETTE.map(hex => (
                                            <ColorSwatch
                                                key={hex}
                                                color={hex}
                                                active={currentColor.toLowerCase() === hex.toLowerCase()}
                                                onClick={() => setConnectorColor(name, hex)}
                                                size={14}
                                            />
                                        ))}
                                    </Flex>
                                    <Tooltip content="Reset to auto">
                                        <Box
                                            as="button"
                                            fontSize="8px"
                                            color="gray.400"
                                            cursor="pointer"
                                            onClick={() => resetConnectorColor(name)}
                                            _hover={{ color: 'gray.600' }}
                                            ml={1}
                                        >
                                            ✕
                                        </Box>
                                    </Tooltip>
                                </Flex>
                            );
                        })}
                    </Flex>
                </Box>
            )}
        </Box>
    );
};

export default EntityColorSettings;
