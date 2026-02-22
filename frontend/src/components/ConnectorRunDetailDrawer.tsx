/**
 * ConnectorRunDetailDrawer - Resizable drawer for connector run details
 * Wraps ConnectorRunDetailPanel in a custom resizable drawer with the same
 * functionality as JobDetailDrawer.
 */

import { Box, Flex, Heading, IconButton } from '@chakra-ui/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuX } from 'react-icons/lu';
import { ConnectorRunDetailPanel } from './ConnectorRunDetailPanel';

interface ConnectorRunDetailDrawerProps {
    runId: number;
    open: boolean;
    onClose: () => void;
    enablePolling?: boolean;
}

export const ConnectorRunDetailDrawer: React.FC<ConnectorRunDetailDrawerProps> = ({
    runId,
    open,
    onClose,
    enablePolling = false,
}) => {
    // Resizable width state
    const [drawerWidth, setDrawerWidth] = useState<number>(() => {
        const saved = localStorage.getItem('connectorRunDetailDrawerWidth');
        return saved ? parseInt(saved, 10) : 900;
    });
    const [isResizing, setIsResizing] = useState(false);
    const resizeStartX = useRef<number>(0);
    const resizeStartWidth = useRef<number>(0);

    // Resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsResizing(true);
        resizeStartX.current = e.clientX;
        resizeStartWidth.current = drawerWidth;
    }, [drawerWidth]);

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!isResizing) return;
        const deltaX = resizeStartX.current - e.clientX;
        const newWidth = Math.max(600, Math.min(window.innerWidth * 0.95, resizeStartWidth.current + deltaX));
        setDrawerWidth(newWidth);
    }, [isResizing]);

    const handleResizeEnd = useCallback(() => {
        if (!isResizing) return;
        setIsResizing(false);
        localStorage.setItem('connectorRunDetailDrawerWidth', drawerWidth.toString());
    }, [isResizing, drawerWidth]);

    // Add/remove resize event listeners
    useEffect(() => {
        if (isResizing) {
            document.addEventListener('mousemove', handleResizeMove);
            document.addEventListener('mouseup', handleResizeEnd);
            return () => {
                document.removeEventListener('mousemove', handleResizeMove);
                document.removeEventListener('mouseup', handleResizeEnd);
            };
        }
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    if (!open) return null;

    return (
        <>
            {/* Backdrop */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.400"
                zIndex={1000}
                onClick={onClose}
            />

            {/* Drawer Panel */}
            <Box
                position="fixed"
                top={0}
                right={0}
                bottom={0}
                width={`${drawerWidth}px`}
                maxW="95vw"
                bg="white"
                _dark={{ bg: 'gray.900' }}
                boxShadow="xl"
                zIndex={1001}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                {/* Resize Handle */}
                <Box
                    position="absolute"
                    left={0}
                    top={0}
                    bottom={0}
                    width="4px"
                    cursor="col-resize"
                    bg={isResizing ? 'blue.400' : 'transparent'}
                    _hover={{ bg: 'blue.200' }}
                    transition="background-color 0.2s"
                    onMouseDown={handleResizeStart}
                    zIndex={1}
                />
                {/* Header */}
                <Flex
                    px={4}
                    py={3}
                    borderBottomWidth="1px"
                    align="center"
                    justify="space-between"
                >
                    <Heading size="md">
                        Connector Run Details
                    </Heading>
                    <IconButton
                        aria-label="Close"
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                    >
                        <LuX />
                    </IconButton>
                </Flex>

                {/* Body */}
                <Box flex={1} overflow="auto" p={4}>
                    <ConnectorRunDetailPanel
                        runId={runId}
                        enablePolling={enablePolling}
                    />
                </Box>
            </Box>
        </>
    );
};

export default ConnectorRunDetailDrawer;
