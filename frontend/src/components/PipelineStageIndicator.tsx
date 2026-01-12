import { Box, Flex, Text } from '@chakra-ui/react';
import React from 'react';
import { PipelineStage, StageStats } from '../types';

interface PipelineStageIndicatorProps {
    currentStage?: PipelineStage;
    stageStats?: Record<PipelineStage, StageStats>;
}

interface StageConfig {
    key: PipelineStage;
    label: string;
    icon: string;
}

const STAGES: StageConfig[] = [
    { key: 'fetch', label: 'Fetch Data', icon: '📥' },
    { key: 'transfer_detection', label: 'Detect Transfers', icon: '🔄' },
    { key: 'asset_enrichment', label: 'Enrich Assets', icon: '💎' },
    { key: 'persistence', label: 'Save to DB', icon: '💾' },
];

const getStageStatus = (
    stageKey: PipelineStage,
    currentStage?: PipelineStage,
    stageStats?: Record<PipelineStage, StageStats>
): 'pending' | 'active' | 'completed' => {
    if (!currentStage) return 'pending';

    const stageOrder: PipelineStage[] = ['fetch', 'transfer_detection', 'asset_enrichment', 'persistence'];
    const currentIndex = stageOrder.indexOf(currentStage);
    const stageIndex = stageOrder.indexOf(stageKey);

    if (stageIndex < currentIndex) return 'completed';
    if (stageIndex === currentIndex) return 'active';
    return 'pending';
};

const getStageColor = (status: 'pending' | 'active' | 'completed'): string => {
    switch (status) {
        case 'completed':
            return 'green.400';
        case 'active':
            return 'blue.400';
        case 'pending':
        default:
            return 'gray.500';
    }
};

const getStageIcon = (status: 'pending' | 'active' | 'completed', defaultIcon: string): string => {
    switch (status) {
        case 'completed':
            return '✅';
        case 'active':
            return '🔄';
        case 'pending':
        default:
            return defaultIcon;
    }
};

export const PipelineStageIndicator: React.FC<PipelineStageIndicatorProps> = ({
    currentStage,
    stageStats,
}) => {
    return (
        <Box>
            <Text fontSize="xs" color="gray.500" mb={2}>
                Pipeline Progress
            </Text>
            <Flex
                direction={{ base: 'column', md: 'row' }}
                align={{ base: 'stretch', md: 'center' }}
                gap={2}
            >
                {STAGES.map((stage, idx) => {
                    const status = getStageStatus(stage.key, currentStage, stageStats);
                    const stats = stageStats?.[stage.key];

                    return (
                        <React.Fragment key={stage.key}>
                            {/* Stage box */}
                            <Flex
                                direction="column"
                                align="center"
                                p={2}
                                borderRadius="md"
                                bg={status === 'active' ? 'blue.50' : status === 'completed' ? 'green.50' : 'gray.50'}
                                borderWidth="1px"
                                borderColor={
                                    status === 'active'
                                        ? 'blue.300'
                                        : status === 'completed'
                                            ? 'green.300'
                                            : 'gray.200'
                                }
                                flex="1"
                                minW="80px"
                                position="relative"
                            >
                                <Text fontSize="lg" mb={1}>
                                    {getStageIcon(status, stage.icon)}
                                </Text>
                                <Text
                                    fontSize="xs"
                                    fontWeight="medium"
                                    color={getStageColor(status)}
                                    textAlign="center"
                                >
                                    {stage.label}
                                </Text>
                                {stats && (stats.processed > 0 || stats.success > 0) && (
                                    <Text fontSize="2xs" color="gray.500" mt={1}>
                                        {stats.success}/{stats.processed}
                                    </Text>
                                )}
                                {status === 'active' && (
                                    <Box
                                        position="absolute"
                                        top={0}
                                        left={0}
                                        right={0}
                                        height="2px"
                                        bg="blue.400"
                                        borderRadius="full"
                                        animation="pulse 1.5s ease-in-out infinite"
                                        css={{
                                            '@keyframes pulse': {
                                                '0%, 100%': { opacity: 1 },
                                                '50%': { opacity: 0.5 },
                                            },
                                        }}
                                    />
                                )}
                            </Flex>

                            {/* Arrow between stages */}
                            {idx < STAGES.length - 1 && (
                                <Text
                                    color={
                                        getStageStatus(STAGES[idx + 1].key, currentStage, stageStats) !== 'pending'
                                            ? 'green.400'
                                            : 'gray.600'
                                    }
                                    fontSize="lg"
                                    display={{ base: 'none', md: 'block' }}
                                >
                                    →
                                </Text>
                            )}
                        </React.Fragment>
                    );
                })}
            </Flex>
        </Box>
    );
};
