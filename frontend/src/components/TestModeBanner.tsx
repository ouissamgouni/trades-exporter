import { Box, Flex, Text } from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { API_URL, AppInfo } from '../types';

export const TestModeBanner: React.FC = () => {
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchAppInfo = async () => {
            try {
                const response = await fetch(`${API_URL}/config/info`);
                if (response.ok) {
                    const data: AppInfo = await response.json();
                    setAppInfo(data);
                }
            } catch (err) {
                console.error('Failed to fetch app info:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchAppInfo();
    }, []);

    // Don't render anything if production or still loading
    if (loading || appInfo?.environment === 'prod') {
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
            zIndex={10}
        >
            <Flex justify="center" align="center" gap={2}>
                <Text fontSize="lg">⚠️</Text>
                <Text>
                    {appInfo?.environment.toUpperCase()} ENVIRONMENT - You are using a {appInfo?.environment} version of the backend.
                </Text>
                <Text fontSize="lg">⚠️</Text>
            </Flex>
        </Box>
    );
};
