/**
 * ChartFullscreenModal
 *
 * Fixed-position fullscreen overlay for charts.
 * Pattern reused from SlidePanel — backdrop + content panel.
 */
import React from 'react';
import { Box, Flex, Heading, Button } from '@chakra-ui/react';
import { FiX } from 'react-icons/fi';

interface ChartFullscreenModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}

export const ChartFullscreenModal: React.FC<ChartFullscreenModalProps> = ({
    isOpen,
    onClose,
    title,
    children,
}) => {
    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.500"
                zIndex={99}
                onClick={(e) => { e.stopPropagation(); onClose(); }}
            />

            {/* Panel */}
            <Box
                position="fixed"
                top="5vh"
                left="5vw"
                right="5vw"
                bottom="5vh"
                bg="white"
                borderRadius="lg"
                boxShadow="2xl"
                zIndex={100}
                display="flex"
                flexDirection="column"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <Flex
                    justify="space-between"
                    align="center"
                    px={4}
                    py={2}
                    borderBottom="1px solid"
                    borderColor="gray.200"
                    flexShrink={0}
                >
                    <Heading size="sm" color="gray.700">{title}</Heading>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <FiX size={18} />
                    </Button>
                </Flex>

                {/* Content — fills remaining space */}
                <Box flex="1" p={4} overflow="auto">
                    {children}
                </Box>
            </Box>
        </>
    );
};
