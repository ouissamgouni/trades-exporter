/**
 * SlidePanel
 * 
 * Reusable slide-in panel with backdrop overlay.
 * Closes when clicking outside (backdrop) to solve the test-mode banner
 * potentially hiding the close button.
 */

import React from 'react';
import { Box, Flex, Heading, Button } from '@chakra-ui/react';
import { FiX } from 'react-icons/fi';

interface SlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    titleIcon?: React.ReactNode;
    width?: string;
    zIndex?: number;
    children: React.ReactNode;
}

export const SlidePanel: React.FC<SlidePanelProps> = ({
    isOpen,
    onClose,
    title,
    titleIcon,
    width = '600px',
    zIndex = 100,
    children,
}) => {
    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop overlay - clicking closes the panel */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.400"
                zIndex={zIndex - 1}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                cursor="pointer"
            />

            {/* Panel */}
            <Box
                position="fixed"
                right={0}
                top={0}
                bottom={0}
                width={width}
                maxW="90vw"
                bg="white"
                boxShadow="xl"
                zIndex={zIndex}
                overflowY="auto"
                borderLeft="1px solid"
                borderColor="gray.200"
                onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
            >
                {/* Header */}
                <Flex
                    justify="space-between"
                    align="center"
                    p={4}
                    borderBottom="1px solid"
                    borderColor="gray.200"
                    bg="gray.50"
                    position="sticky"
                    top={0}
                    zIndex={1}
                >
                    <Flex align="center" gap={2}>
                        {titleIcon}
                        <Heading size="md">{title}</Heading>
                    </Flex>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <FiX size={20} />
                    </Button>
                </Flex>

                {/* Content */}
                <Box p={4}>
                    {children}
                </Box>
            </Box>
        </>
    );
};

export default SlidePanel;
