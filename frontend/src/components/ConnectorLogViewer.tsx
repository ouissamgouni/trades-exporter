import { Box, Flex, IconButton, Text } from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { LogEntry } from '../types';

interface ConnectorLogViewerProps {
    logs: LogEntry[];
    maxHeight?: string;
}

const getLevelColor = (level: string): string => {
    switch (level) {
        case 'ERROR':
            return 'red.400';
        case 'WARNING':
            return 'yellow.400';
        case 'INFO':
            return 'gray.100';
        case 'DEBUG':
            return 'gray.500';
        default:
            return 'gray.300';
    }
};

const getLevelBadgeColor = (level: string): string => {
    switch (level) {
        case 'ERROR':
            return 'red';
        case 'WARNING':
            return 'yellow';
        case 'INFO':
            return 'blue';
        case 'DEBUG':
            return 'gray';
        default:
            return 'gray';
    }
};

const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};

export const ConnectorLogViewer: React.FC<ConnectorLogViewerProps> = ({
    logs,
    maxHeight = '200px',
}) => {
    const [autoScroll, setAutoScroll] = useState(true);
    const [filterLevel, setFilterLevel] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new logs arrive
    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    // Handle manual scroll - disable auto-scroll if user scrolls up
    const handleScroll = () => {
        if (scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
            if (!isAtBottom && autoScroll) {
                setAutoScroll(false);
            }
        }
    };

    // Filter logs by level
    const filteredLogs = filterLevel
        ? logs.filter((log) => log.level === filterLevel)
        : logs;

    if (logs.length === 0) {
        return (
            <Box
                bg="gray.900"
                borderRadius="md"
                p={3}
                fontFamily="mono"
                fontSize="xs"
            >
                <Text color="gray.500" textAlign="center">
                    No logs yet...
                </Text>
            </Box>
        );
    }

    return (
        <Box>
            {/* Controls */}
            <Flex justify="space-between" align="center" mb={2}>
                <Flex gap={1}>
                    <Text
                        fontSize="xs"
                        color={!filterLevel ? 'blue.400' : 'gray.500'}
                        cursor="pointer"
                        onClick={() => setFilterLevel(null)}
                        _hover={{ color: 'blue.300' }}
                    >
                        All
                    </Text>
                    <Text fontSize="xs" color="gray.600">|</Text>
                    <Text
                        fontSize="xs"
                        color={filterLevel === 'ERROR' ? 'red.400' : 'gray.500'}
                        cursor="pointer"
                        onClick={() => setFilterLevel(filterLevel === 'ERROR' ? null : 'ERROR')}
                        _hover={{ color: 'red.300' }}
                    >
                        Errors
                    </Text>
                    <Text fontSize="xs" color="gray.600">|</Text>
                    <Text
                        fontSize="xs"
                        color={filterLevel === 'WARNING' ? 'yellow.400' : 'gray.500'}
                        cursor="pointer"
                        onClick={() => setFilterLevel(filterLevel === 'WARNING' ? null : 'WARNING')}
                        _hover={{ color: 'yellow.300' }}
                    >
                        Warnings
                    </Text>
                </Flex>
                <Flex align="center" gap={2}>
                    <Text fontSize="xs" color="gray.500">
                        {filteredLogs.length} logs
                    </Text>
                    <Text
                        fontSize="xs"
                        color={autoScroll ? 'green.400' : 'gray.500'}
                        cursor="pointer"
                        onClick={() => setAutoScroll(!autoScroll)}
                        _hover={{ textDecoration: 'underline' }}
                    >
                        Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
                    </Text>
                </Flex>
            </Flex>

            {/* Log viewer */}
            <Box
                ref={scrollRef}
                onScroll={handleScroll}
                bg="gray.900"
                borderRadius="md"
                p={2}
                maxH={maxHeight}
                overflowY="auto"
                fontFamily="mono"
                fontSize="xs"
                css={{
                    '&::-webkit-scrollbar': {
                        width: '6px',
                    },
                    '&::-webkit-scrollbar-track': {
                        background: '#1a1a2e',
                    },
                    '&::-webkit-scrollbar-thumb': {
                        background: '#4a4a6a',
                        borderRadius: '3px',
                    },
                }}
            >
                {filteredLogs.map((log, idx) => (
                    <Flex key={idx} gap={2} mb={0.5} alignItems="flex-start">
                        <Text color="gray.600" flexShrink={0}>
                            {formatTimestamp(log.timestamp)}
                        </Text>
                        <Text
                            color={getLevelColor(log.level)}
                            fontWeight="medium"
                            flexShrink={0}
                            w="50px"
                        >
                            [{log.level.substring(0, 4)}]
                        </Text>
                        <Text color={getLevelColor(log.level)} wordBreak="break-word">
                            {log.message}
                        </Text>
                    </Flex>
                ))}
            </Box>
        </Box>
    );
};
