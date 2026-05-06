/**
 * QaTestPlanPanel
 *
 * Floating action button (bottom-right, like a support chat widget)
 * that opens a side panel with QA test plan steps.
 * Supports pin/unpin: when pinned, the panel sits alongside the app
 * (pushes content left) instead of overlaying it.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box, Button, Text, Flex, Badge, Heading, Spinner, IconButton } from '@chakra-ui/react';
import { FiClipboard, FiCheckSquare, FiSquare, FiChevronLeft, FiX } from 'react-icons/fi';
import { API_URL, AppInfo } from '../types';

const QA_PANEL_WIDTH = 380;

// ── Context: exposes pinned width + panel controls so StatusBar can trigger open ──
interface QaPinContext {
    pinnedWidth: number;
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    appInfo: AppInfo | null;
    doneCount: number;
    totalSteps: number;
}
const QaPinCtx = createContext<QaPinContext>({
    pinnedWidth: 0,
    isOpen: false,
    setIsOpen: () => {},
    appInfo: null,
    doneCount: 0,
    totalSteps: 0,
});
export const useQaPinnedWidth = () => useContext(QaPinCtx).pinnedWidth;
export const useQaContext = () => useContext(QaPinCtx);

interface TestStep {
    id: number;
    title: string;
    description: string;
    expected: string;
    verification: string;
}

interface TestPlan {
    name: string;
    description: string;
    steps: TestStep[];
}

export const QaTestPlanProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [pinnedWidth, setPinnedWidth] = useState(0);
    const [isOpen, setIsOpen] = useState(false);
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
    const [doneCount, setDoneCount] = useState(0);
    const [totalSteps, setTotalSteps] = useState(0);

    // Fetch app info once (shared with StatusBar via context)
    useEffect(() => {
        const fetchAppInfo = async () => {
            try {
                const response = await fetch(`${API_URL}/config/info`);
                if (response.ok) {
                    const data: AppInfo = await response.json();
                    setAppInfo(data);
                }
            } catch {
                // ignore
            }
        };
        fetchAppInfo();
    }, []);

    return (
        <QaPinCtx.Provider value={{ pinnedWidth, isOpen, setIsOpen, appInfo, doneCount, totalSteps }}>
            {children}
            <QaTestPlanPanelInner
                onPinnedWidthChange={setPinnedWidth}
                isOpen={isOpen}
                setIsOpen={setIsOpen}
                appInfo={appInfo}
                onProgressChange={(done, total) => { setDoneCount(done); setTotalSteps(total); }}
            />
        </QaPinCtx.Provider>
    );
};

interface PanelInnerProps {
    onPinnedWidthChange: (w: number) => void;
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    appInfo: AppInfo | null;
    onProgressChange: (done: number, total: number) => void;
}

const QaTestPlanPanelInner: React.FC<PanelInnerProps> = ({ onPinnedWidthChange, isOpen, setIsOpen, appInfo, onProgressChange }) => {
    const [pinned, setPinned] = useState(false);
    const [activeScenario, setActiveScenario] = useState<string | null>(null);
    const [testPlan, setTestPlan] = useState<TestPlan | null>(null);
    const [loading, setLoading] = useState(false);
    const [checkedSteps, setCheckedSteps] = useState<Record<string, Set<number>>>({});

    // Notify parent of pinned width changes
    useEffect(() => {
        onPinnedWidthChange(pinned && isOpen ? QA_PANEL_WIDTH : 0);
    }, [pinned, isOpen, onPinnedWidthChange]);

    // Auto-select single scenario
    useEffect(() => {
        if (appInfo?.qa_scenarios?.length === 1 && !activeScenario) {
            setActiveScenario(appInfo.qa_scenarios[0]);
        }
    }, [appInfo, activeScenario]);

    // Fetch test plan when a scenario is selected
    useEffect(() => {
        if (!activeScenario) { setTestPlan(null); return; }
        setLoading(true);
        const fetchTestPlan = async () => {
            try {
                const response = await fetch(
                    `${API_URL}/config/test-plan?scenario=${encodeURIComponent(activeScenario)}`
                );
                if (response.ok) {
                    setTestPlan(await response.json() as TestPlan);
                }
            } catch {
                // ignore
            } finally {
                setLoading(false);
            }
        };
        fetchTestPlan();
    }, [activeScenario]);

    const toggleStep = (stepId: number) => {
        if (!activeScenario) return;
        setCheckedSteps(prev => {
            const scenarioSet = new Set(prev[activeScenario] ?? []);
            if (scenarioSet.has(stepId)) scenarioSet.delete(stepId);
            else scenarioSet.add(stepId);
            return { ...prev, [activeScenario]: scenarioSet };
        });
    };

    const scenarios = appInfo?.qa_scenarios ?? [];

    const doneSet = activeScenario ? (checkedSteps[activeScenario] ?? new Set<number>()) : new Set<number>();
    const totalSteps = testPlan?.steps?.length ?? 0;
    const doneCount = doneSet.size;
    const hasMultiple = scenarios.length > 1;

    // Report progress to parent context
    useEffect(() => {
        onProgressChange(doneCount, totalSteps);
    }, [doneCount, totalSteps, onProgressChange]);

    if (scenarios.length === 0) return null;

    const handleClose = () => {
        setIsOpen(false);
        if (pinned) { setPinned(false); }
    };

    const togglePin = () => setPinned(p => !p);

    // ── Panel content (shared between pinned & overlay modes) ────────
    const panelContent = (
        <>
            {/* Header */}
            <Flex
                justify="space-between"
                align="center"
                px={3}
                py={2}
                borderBottom="1px solid"
                borderColor="gray.200"
                bg="gray.50"
                position="sticky"
                top={0}
                zIndex={1}
            >
                <Flex align="center" gap={2}>
                    <FiClipboard size={16} />
                    <Heading size="sm">{activeScenario ? `QA: ${activeScenario}` : 'QA Test Plans'}</Heading>
                </Flex>
                <Flex gap={1}>
                    <IconButton
                        aria-label={pinned ? 'Unpin panel' : 'Pin panel'}
                        variant="ghost"
                        size="xs"
                        onClick={togglePin}
                        title={pinned ? 'Unpin (overlay mode)' : 'Pin (side-by-side)'}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {pinned ? (
                                // Pinned icon — filled pin
                                <>
                                    <line x1="12" y1="17" x2="12" y2="22" />
                                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" fill="currentColor" />
                                </>
                            ) : (
                                // Unpinned icon — outline pin with slash
                                <>
                                    <line x1="12" y1="17" x2="12" y2="22" />
                                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                                    <line x1="2" y1="2" x2="22" y2="22" />
                                </>
                            )}
                        </svg>
                    </IconButton>
                    <IconButton aria-label="Close" variant="ghost" size="xs" onClick={handleClose}>
                        <FiX size={16} />
                    </IconButton>
                </Flex>
            </Flex>

            {/* Body */}
            <Box p={3} overflowY="auto" flex={1}>
                {/* Scenario picker */}
                {(!activeScenario || (hasMultiple && !testPlan)) && (
                    <Box mb={4}>
                        <Text fontSize="xs" color="gray.500" mb={2}>Select a scenario:</Text>
                        <Flex direction="column" gap={2}>
                            {scenarios.map(s => {
                                const sDone = checkedSteps[s]?.size ?? 0;
                                return (
                                    <Box
                                        key={s}
                                        p={3}
                                        border="1px solid"
                                        borderColor="gray.200"
                                        borderRadius="md"
                                        cursor="pointer"
                                        _hover={{ bg: 'purple.50', borderColor: 'purple.300' }}
                                        onClick={() => setActiveScenario(s)}
                                    >
                                        <Flex justify="space-between" align="center">
                                            <Text fontSize="sm" fontWeight="bold">{s}</Text>
                                            {sDone > 0 && (
                                                <Badge colorPalette="green" fontSize="xs">{sDone} done</Badge>
                                            )}
                                        </Flex>
                                    </Box>
                                );
                            })}
                        </Flex>
                    </Box>
                )}

                {/* Back button when viewing a scenario in multi mode */}
                {hasMultiple && activeScenario && testPlan && (
                    <Button
                        variant="ghost"
                        size="xs"
                        mb={3}
                        onClick={() => { setActiveScenario(null); setTestPlan(null); }}
                    >
                        <FiChevronLeft /> All scenarios
                    </Button>
                )}

                {loading && (
                    <Flex justify="center" py={8}><Spinner size="lg" /></Flex>
                )}

                {testPlan && (
                    <Box>
                        <Heading size="xs" mb={1}>{testPlan.name}</Heading>
                        <Text fontSize="xs" color="gray.500" mb={4}>{testPlan.description}</Text>

                        <Badge
                            colorPalette={doneCount === totalSteps ? 'green' : 'purple'}
                            fontSize="xs"
                            mb={3}
                        >
                            {doneCount} / {totalSteps} completed
                        </Badge>

                        {testPlan.steps.map((step) => {
                            const isDone = doneSet.has(step.id);
                            return (
                                <Box
                                    key={step.id}
                                    mb={2}
                                    p={2}
                                    borderRadius="md"
                                    border="1px solid"
                                    borderColor={isDone ? 'green.200' : 'gray.200'}
                                    bg={isDone ? 'green.50' : 'white'}
                                    opacity={isDone ? 0.7 : 1}
                                    cursor="pointer"
                                    onClick={() => toggleStep(step.id)}
                                    _hover={{ borderColor: 'purple.300' }}
                                    transition="all 0.15s"
                                >
                                    <Flex align="flex-start" gap={2}>
                                        <Box mt="2px" color={isDone ? 'green.500' : 'gray.400'} flexShrink={0}>
                                            {isDone ? <FiCheckSquare size={14} /> : <FiSquare size={14} />}
                                        </Box>
                                        <Box flex={1}>
                                            <Text fontSize="xs" fontWeight="bold" mb={0.5}>
                                                {step.id}. {step.title}
                                            </Text>
                                            <Text fontSize="xs" color="gray.600" mb={1}>
                                                {step.description}
                                            </Text>
                                            <Box bg="blue.50" px={2} py={1} borderRadius="sm" mb={1}>
                                                <Text fontSize="xs" color="blue.700">
                                                    <strong>Expected:</strong> {step.expected}
                                                </Text>
                                            </Box>
                                            <Text fontSize="xs" color="gray.500" fontStyle="italic">
                                                ✓ {step.verification}
                                            </Text>
                                        </Box>
                                    </Flex>
                                </Box>
                            );
                        })}
                    </Box>
                )}
            </Box>
        </>
    );

    return (
        <>
            {/* Overlay mode (unpinned): backdrop + fixed panel */}
            {isOpen && !pinned && (
                <>
                    <Box
                        position="fixed"
                        inset={0}
                        bg="blackAlpha.400"
                        zIndex={199}
                        onClick={handleClose}
                    />
                    <Box
                        position="fixed"
                        right={0}
                        top={0}
                        bottom={0}
                        width={`${QA_PANEL_WIDTH}px`}
                        maxW="90vw"
                        bg="white"
                        boxShadow="xl"
                        zIndex={200}
                        display="flex"
                        flexDirection="column"
                        borderLeft="1px solid"
                        borderColor="gray.200"
                    >
                        {panelContent}
                    </Box>
                </>
            )}

            {/* Pinned mode: fixed panel, no backdrop, app shrinks via margin */}
            {isOpen && pinned && (
                <Box
                    position="fixed"
                    right={0}
                    top={0}
                    bottom={0}
                    width={`${QA_PANEL_WIDTH}px`}
                    bg="white"
                    boxShadow="-2px 0 8px rgba(0,0,0,0.08)"
                    zIndex={10}
                    display="flex"
                    flexDirection="column"
                    borderLeft="1px solid"
                    borderColor="gray.200"
                >
                    {panelContent}
                </Box>
            )}
        </>
    );
};
