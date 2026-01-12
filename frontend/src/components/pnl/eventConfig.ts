/**
 * Cost Lot Event Type Configuration
 * 
 * Centralized configuration for all cost lot event types, providing:
 * - Visual styling (colors, icons, backgrounds)
 * - Default visibility settings
 * - Event descriptions and metadata
 * 
 * This configuration is used across all cost lot event tables to ensure
 * consistent presentation and behavior.
 */

import React from 'react';
import { FiPlusCircle, FiMinusCircle, FiArrowDownCircle, FiCheckCircle, FiArrowRightCircle, FiEdit3, FiGitMerge } from 'react-icons/fi';
import { LotEventType } from './types';

export interface EventTypeConfig {
    type: LotEventType;
    label: string;
    icon: React.ReactNode;     // React icon component
    iconText: string;          // Fallback text icon for compact display
    color: string;             // Chakra UI color palette
    bgColor: string;           // Background color for table rows
    defaultVisible: boolean;
    description: string;
    sortPriority: number;      // For filter button ordering
}

export const EVENT_TYPE_CONFIG: Record<LotEventType, EventTypeConfig> = {
    'created': {
        type: 'created',
        label: 'Created',
        icon: React.createElement(FiPlusCircle, { size: 14 }),
        iconText: '+',
        color: 'green',
        bgColor: 'green.50',
        defaultVisible: true,
        description: 'Positive lot created from acquisition',
        sortPriority: 1
    },
    'created-negative': {
        type: 'created-negative',
        label: 'Negative',
        icon: React.createElement(FiMinusCircle, { size: 14 }),
        iconText: '−',
        color: 'red',
        bgColor: 'red.50',
        defaultVisible: true,  // Now visible by default
        description: 'Negative lot created (short position)',
        sortPriority: 2
    },
    'consumed': {
        type: 'consumed',
        label: 'Consumed',
        icon: React.createElement(FiArrowDownCircle, { size: 14 }),
        iconText: '↓',
        color: 'orange',
        bgColor: 'orange.50',
        defaultVisible: true,
        description: 'Lot partially/fully consumed in disposal',
        sortPriority: 3
    },
    'settled': {
        type: 'settled',
        label: 'Settled',
        icon: React.createElement(FiCheckCircle, { size: 14 }),
        iconText: '✓',
        color: 'gray',
        bgColor: 'gray.50',
        defaultVisible: true,  // Now visible by default
        description: 'Lot exhausted (reached zero balance)',
        sortPriority: 4
    },
    'transferred': {
        type: 'transferred',
        label: 'Transferred',
        icon: React.createElement(FiArrowRightCircle, { size: 14 }),
        iconText: '→',
        color: 'blue',
        bgColor: 'blue.50',
        defaultVisible: true,
        description: 'Lot transferred between accounts',
        sortPriority: 5
    },
    'adjusted': {
        type: 'adjusted',
        label: 'Adjusted',
        icon: React.createElement(FiEdit3, { size: 14 }),
        iconText: '✎',
        color: 'yellow',
        bgColor: 'yellow.50',
        defaultVisible: true,
        description: 'Manual cost basis adjustment',
        sortPriority: 6
    },
    'merged': {
        type: 'merged',
        label: 'Merged',
        icon: React.createElement(FiGitMerge, { size: 14 }),
        iconText: '⇄',
        color: 'teal',
        bgColor: 'teal.50',
        defaultVisible: true,
        description: 'Multiple lots combined into one',
        sortPriority: 7
    }
};

/**
 * Get configuration for a specific event type
 */
export function getEventConfig(eventType: LotEventType): EventTypeConfig {
    return EVENT_TYPE_CONFIG[eventType];
}

/**
 * Get all event types that should be visible by default
 */
export function getDefaultVisibleTypes(): Set<LotEventType> {
    return new Set(
        Object.values(EVENT_TYPE_CONFIG)
            .filter(cfg => cfg.defaultVisible)
            .map(cfg => cfg.type)
    );
}

/**
 * Get event types sorted by priority for filter buttons
 */
export function getSortedEventTypes(): LotEventType[] {
    return Object.values(EVENT_TYPE_CONFIG)
        .sort((a, b) => a.sortPriority - b.sortPriority)
        .map(cfg => cfg.type);
}

/**
 * Count events by type
 */
export function countEventsByType(events: Array<{ event_type: LotEventType }>): Record<LotEventType, number> {
    const counts = Object.keys(EVENT_TYPE_CONFIG).reduce((acc, type) => {
        acc[type as LotEventType] = 0;
        return acc;
    }, {} as Record<LotEventType, number>);

    events.forEach(event => {
        if (counts[event.event_type] !== undefined) {
            counts[event.event_type]++;
        }
    });

    return counts;
}
