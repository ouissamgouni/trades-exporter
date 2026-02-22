import { Badge } from '@chakra-ui/react';
import React from 'react';
import { PipelineStage } from '../types';

interface PipelineStageIndicatorProps {
    currentStage?: PipelineStage;
}

const STAGE_LABELS: Record<PipelineStage, string> = {
    fetch: '📥 Fetching',
    transfer_detection: '🔄 Detecting Transfers',
    asset_enrichment: '💎 Enriching Assets',
    persistence: '💾 Saving',
};

export const PipelineStageIndicator: React.FC<PipelineStageIndicatorProps> = ({
    currentStage,
}) => {
    if (!currentStage) return null;

    return (
        <Badge colorPalette="blue" size="sm" variant="subtle">
            {STAGE_LABELS[currentStage]}
        </Badge>
    );
};
