import { Box, Flex, Text } from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { API_URL, ConfigStatus } from '../types';

export const TestModeBanner: React.FC = () => {
    const [config, setConfig] = useState<ConfigStatus | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const response = await fetch(`${API_URL}/config/status`);
                if (response.ok) {
                    const data: ConfigStatus = await response.json();
                    setConfig(data);
                }
            } catch (err) {
                console.error('Failed to fetch config status:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchConfig();
    }, []);

    // Don't render anything if not in test mode or still loading
    if (loading || !config?.test_mode) {
        return null;
    }

    return (
        <Box
            bg="orange.400"
            color="white"
            py={2}
            px={4}
            textAlign="center"
            fontWeight="bold"
            position="sticky"
            top={0}
            zIndex={1000}
        >
            <Flex justify="center" align="center" gap={2}>
                <Text fontSize="lg">⚠️</Text>
                <Text>
                    TEST MODE - You are using a test version of the backend. Data is stored in a separate test database.
                </Text>
                <Text fontSize="lg">⚠️</Text>
            </Flex>
        </Box>
    );
};
