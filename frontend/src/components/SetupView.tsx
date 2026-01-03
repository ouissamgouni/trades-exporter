import {
    Badge, Box, Button, Card, Flex,
    Heading, Spinner, Text, VStack
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../types';

interface SetupStatus {
    accounts_configured: boolean;
    accounts_count: number;
    connectors_configured: boolean;
    connectors_count: number;
    assets_configured: boolean;
    assets_count: number;
    base_currency_set: boolean;
    base_currency_symbol: string | null;
    setup_complete: boolean;
    pending_items: string[];
}

export const SetupView: React.FC = () => {
    const [status, setStatus] = useState<SetupStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchStatus = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${API_URL}/config/setup-status`);
            if (!response.ok) throw new Error('Failed to fetch setup status');
            const data = await response.json();
            setStatus(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStatus();
    }, [fetchStatus]);

    if (loading) {
        return (
            <Box textAlign="center" py={8}>
                <Spinner size="xl" />
                <Text mt={4}>Loading setup status...</Text>
            </Box>
        );
    }

    if (error || !status) {
        return (
            <Box textAlign="center" py={8}>
                <Text color="red.500">{error || 'Failed to load status'}</Text>
                <Button onClick={fetchStatus} mt={4}>Retry</Button>
            </Box>
        );
    }

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6}>
                <Heading size="lg">🏠 Setup</Heading>
                {status.setup_complete ? (
                    <Badge colorPalette="green" size="lg">✓ Setup Complete</Badge>
                ) : (
                    <Badge colorPalette="yellow" size="lg">⚠️ Setup Incomplete</Badge>
                )}
            </Flex>

            <VStack gap={4} align="stretch">
                {/* Accounts */}
                <Card.Root>
                    <Card.Body>
                        <Flex justify="space-between" align="center">
                            <Box>
                                <Heading size="md">👤 Accounts</Heading>
                                <Text color="gray.600" fontSize="sm">
                                    Configure your trading accounts and wallets
                                </Text>
                                <Text mt={2}>
                                    {status.accounts_configured
                                        ? `✓ ${status.accounts_count} account(s) configured`
                                        : '⚠️ No accounts configured'}
                                </Text>
                            </Box>
                            <Badge
                                colorPalette={status.accounts_configured ? 'green' : 'red'}
                                size="lg"
                            >
                                {status.accounts_configured ? 'Done' : 'Todo'}
                            </Badge>
                        </Flex>
                    </Card.Body>
                </Card.Root>

                {/* Connectors */}
                <Card.Root>
                    <Card.Body>
                        <Flex justify="space-between" align="center">
                            <Box>
                                <Heading size="md">🔌 Connectors</Heading>
                                <Text color="gray.600" fontSize="sm">
                                    Link connectors to sync transactions
                                </Text>
                                <Text mt={2}>
                                    {status.connectors_configured
                                        ? `✓ ${status.connectors_count} connector(s) configured`
                                        : '⚠️ No connectors configured'}
                                </Text>
                            </Box>
                            <Badge
                                colorPalette={status.connectors_configured ? 'green' : 'red'}
                                size="lg"
                            >
                                {status.connectors_configured ? 'Done' : 'Todo'}
                            </Badge>
                        </Flex>
                    </Card.Body>
                </Card.Root>

                {/* Assets */}
                <Card.Root>
                    <Card.Body>
                        <Flex justify="space-between" align="center">
                            <Box>
                                <Heading size="md">💰 Assets</Heading>
                                <Text color="gray.600" fontSize="sm">
                                    Map and configure assets
                                </Text>
                                <Text mt={2}>
                                    {status.assets_configured
                                        ? `✓ ${status.assets_count} asset(s) configured`
                                        : '⚠️ No assets configured'}
                                </Text>
                            </Box>
                            <Badge
                                colorPalette={status.assets_configured ? 'green' : 'red'}
                                size="lg"
                            >
                                {status.assets_configured ? 'Done' : 'Todo'}
                            </Badge>
                        </Flex>
                    </Card.Body>
                </Card.Root>

                {/* Base Currency */}
                <Card.Root>
                    <Card.Body>
                        <Flex justify="space-between" align="center">
                            <Box>
                                <Heading size="md">💵 Base Currency</Heading>
                                <Text color="gray.600" fontSize="sm">
                                    Set base currency for P&L calculations
                                </Text>
                                <Text mt={2}>
                                    {status.base_currency_set
                                        ? `✓ Base currency: ${status.base_currency_symbol}`
                                        : '⚠️ Add EUR or USD asset for P&L'}
                                </Text>
                            </Box>
                            <Badge
                                colorPalette={status.base_currency_set ? 'green' : 'red'}
                                size="lg"
                            >
                                {status.base_currency_set ? 'Done' : 'Todo'}
                            </Badge>
                        </Flex>
                    </Card.Body>
                </Card.Root>
            </VStack>

            {!status.setup_complete && (
                <Card.Root mt={6} bg="yellow.50" borderColor="yellow.200">
                    <Card.Body>
                        <Heading size="sm" mb={2}>⚠️ Pending Items:</Heading>
                        <VStack align="start" gap={1}>
                            {status.pending_items.map((item, idx) => (
                                <Text key={idx} fontSize="sm">• {item}</Text>
                            ))}
                        </VStack>
                    </Card.Body>
                </Card.Root>
            )}

            {status.setup_complete && (
                <Card.Root mt={6} bg="green.50" borderColor="green.200">
                    <Card.Body>
                        <Text fontSize="lg" fontWeight="bold">
                            ✅ Setup is complete! You can now:
                        </Text>
                        <VStack align="start" mt={3} gap={1}>
                            <Text>• Sync transactions from your connectors</Text>
                            <Text>• Review pending transactions in the Inbox</Text>
                            <Text>• Create bundles to group related transactions</Text>
                            <Text>• Run P&L calculations</Text>
                        </VStack>
                    </Card.Body>
                </Card.Root>
            )}
        </Box>
    );
};
