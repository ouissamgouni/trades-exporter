import React, { useCallback, useEffect, useState } from 'react';
import { Box, Flex, Text } from '@chakra-ui/react';
import { FiActivity, FiCheckCircle, FiClipboard } from 'react-icons/fi';
import { useDataHealth } from '../contexts/DataHealthContext';
import { useQaContext } from './QaTestPlanPanel';
import { DataHealthCheckDrawer } from './DataHealthCheckDrawer';
import { API_URL, Account, Asset } from '../types';
import { useAssets } from '../hooks/useAssets';

const STATUS_BAR_HEIGHT = 22;

const envColors: Record<string, string> = {
    dev: '#edf2f7',
    test: '#edf2f7',
    staging: '#edf2f7',
    prod: '#edf2f7',
};

const envDotColors: Record<string, string> = {
    dev: '#3b82f6',
    test: '#dd6b20',
    staging: '#dd6b20',
    prod: '#a0aec0',
};

/** Thin divider between segments */
const Divider = () => (
    <Box
        w="1px"
        h="12px"
        bg="blackAlpha.200"
        mx={1}
        flexShrink={0}
    />
);

/** Clickable segment wrapper */
const Segment: React.FC<{ onClick?: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
    <Flex
        align="center"
        gap={1}
        px={1.5}
        h="100%"
        cursor={onClick ? 'pointer' : 'default'}
        onClick={onClick}
        _hover={onClick ? { bg: 'blackAlpha.100' } : undefined}
        transition="background 0.15s"
        flexShrink={0}
        fontSize="11px"
    >
        {children}
    </Flex>
);

export const StatusBar: React.FC = () => {
    const { validationSummary, refreshHealthData } = useDataHealth();
    const { appInfo, isOpen: qaIsOpen, setIsOpen: setQaIsOpen, doneCount, totalSteps } = useQaContext();

    // Data health drawer state
    const [isHealthCheckOpen, setIsHealthCheckOpen] = useState(false);
    const [healthCheckRefreshTrigger, setHealthCheckRefreshTrigger] = useState(0);
    const { assets, refetchAssets } = useAssets();
    const [accounts, setAccounts] = useState<Account[]>([]);

    const fetchAccounts = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) {
                setAccounts(await response.json());
            }
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        if (isHealthCheckOpen) fetchAccounts();
    }, [isHealthCheckOpen, fetchAccounts]);

    const env = appInfo?.environment ?? 'prod';
    const isProd = env === 'prod';
    const barBg = envColors[env] ?? envColors.prod;
    const dotColor = envDotColors[env] ?? envDotColors.prod;
    const hasQa = (appInfo?.qa_scenarios?.length ?? 0) > 0 && !isProd;

    return (
        <>
            <Box
                position="fixed"
                bottom={0}
                left={0}
                right={0}
                h={`${STATUS_BAR_HEIGHT}px`}
                bg={barBg}
                color="gray.600"
                borderTop="1px solid"
                borderColor="gray.200"
                zIndex={50}
                display="flex"
                alignItems="center"
                justifyContent="flex-end"
                fontFamily="system-ui, -apple-system, sans-serif"
                userSelect="none"
            >
                {/* ── Right-aligned segments: Data Health | QA | Env ── */}

                {/* Data Health segment */}
                {validationSummary && (
                    <>
                        <Segment onClick={() => {
                            refreshHealthData();
                            setIsHealthCheckOpen(true);
                        }}>
                            {validationSummary.has_issues ? (
                                <>
                                    <FiActivity size={11} color="#dd6b20" />
                                    <Text color="#dd6b20" fontWeight="600">
                                        {validationSummary.total_issues} Issues
                                    </Text>
                                </>
                            ) : (
                                <>
                                    <FiCheckCircle size={11} color="#38a169" />
                                    <Text color="#38a169">Healthy</Text>
                                </>
                            )}
                        </Segment>
                        <Divider />
                    </>
                )}

                {/* QA segment */}
                {hasQa && (
                    <>
                        <Segment onClick={() => setQaIsOpen(!qaIsOpen)}>
                            <FiClipboard size={11} />
                            <Text>QA</Text>
                            {totalSteps > 0 && (
                                <Text fontWeight="600" opacity={0.85}>
                                    {doneCount}/{totalSteps}
                                </Text>
                            )}
                        </Segment>
                        <Divider />
                    </>
                )}

                {/* Env info segment (rightmost) */}
                <Segment>
                    {!isProd && (
                        <>
                            <Box
                                w="7px"
                                h="7px"
                                borderRadius="full"
                                bg={dotColor}
                                flexShrink={0}
                            />
                            <Text fontWeight="700">{env.toUpperCase()}</Text>
                        </>
                    )}
                    {appInfo?.backend_version && (
                        <Text opacity={0.6}>{appInfo.backend_version}</Text>
                    )}
                    {appInfo?.db_schema_version && (
                        <Text opacity={0.5}>DB {appInfo.db_schema_version}</Text>
                    )}
                </Segment>

                {/* Right edge padding */}
                <Box w={1} flexShrink={0} />
            </Box>

            {/* Data Health Drawer — triggered from status bar */}
            <DataHealthCheckDrawer
                isOpen={isHealthCheckOpen}
                onClose={() => setIsHealthCheckOpen(false)}
                refreshTrigger={healthCheckRefreshTrigger}
                assets={assets}
                accounts={accounts}
                onAssetsUpdated={refetchAssets}
                onAccountsUpdated={fetchAccounts}
                onIssueFixed={() => {
                    refreshHealthData();
                    setHealthCheckRefreshTrigger(prev => prev + 1);
                }}
            />
        </>
    );
};

export const STATUS_BAR_HEIGHT_PX = STATUS_BAR_HEIGHT;
