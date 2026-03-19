import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import React from 'react';

interface CounterpartyFilterCardProps {
    nonOwned: boolean;
    onToggle: (value: boolean) => void;
    nonOwnedCount?: number;
}

/**
 * A filter card for the P&L context that toggles the "Non-Owned" filter.
 *
 * "Non-Owned" includes transactions where any counterparty (from/to account)
 * is either explicitly marked as non-owned or is unmapped (NULL).
 *
 * Designed to be passed as `extraFilterCards` to TransactionFilters.
 */
export const CounterpartyFilterCard: React.FC<CounterpartyFilterCardProps> = ({
    nonOwned,
    onToggle,
    nonOwnedCount,
}) => {
    return (
        <Box
            bg="white"
            border="1px solid"
            borderColor={nonOwned ? 'red.200' : 'gray.200'}
            borderRadius="md"
            p={2}
            minH="70px"
        >
            {/* Header */}
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs" fontWeight="semibold" color="gray.600">
                        🔗 Counterparty
                    </Text>
                </Flex>
                {nonOwned && (
                    <Badge size="xs" colorPalette="red">1 active</Badge>
                )}
            </Flex>

            {/* Toggle chip */}
            <Flex flexWrap="wrap" gap={1.5}>
                <Badge
                    size="sm"
                    variant={nonOwned ? 'solid' : 'outline'}
                    colorPalette={nonOwned ? 'red' : 'gray'}
                    cursor="pointer"
                    userSelect="none"
                    onClick={() => onToggle(!nonOwned)}
                    _hover={{ opacity: 0.8 }}
                >
                    🚫 Non-Owned
                    {nonOwnedCount !== undefined && nonOwnedCount > 0 && (
                        <Text as="span" ml={1} fontSize="2xs" opacity={0.8}>
                            ({nonOwnedCount})
                        </Text>
                    )}
                </Badge>
            </Flex>

            {/* Helper text */}
            <Text fontSize="2xs" color="gray.400" mt={1.5}>
                Includes unmapped accounts
            </Text>
        </Box>
    );
};

export default CounterpartyFilterCard;
