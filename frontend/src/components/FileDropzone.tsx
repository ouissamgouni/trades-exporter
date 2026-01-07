import React, { useState, useCallback } from 'react';
import { Box, Text, Button, Flex, Icon } from '@chakra-ui/react';
import { FiUpload, FiFile, FiX, FiCheck } from 'react-icons/fi';

interface FileDropzoneProps {
    onFileSelect: (file: File) => void;
    accept?: string;
    maxSize?: number; // in bytes
    currentFileName?: string | null;
    onRemove?: () => void;
    disabled?: boolean;
}

const FileDropzone: React.FC<FileDropzoneProps> = ({
    onFileSelect,
    accept = '.json',
    maxSize = 1024 * 1024, // 1MB default
    currentFileName,
    onRemove,
    disabled = false,
}) => {
    const [isDragging, setIsDragging] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const validateFile = useCallback((file: File): string | null => {
        // Check file extension
        if (accept && !file.name.toLowerCase().endsWith(accept.replace('*', ''))) {
            return `File must be a ${accept} file`;
        }
        // Check file size
        if (maxSize && file.size > maxSize) {
            return `File size must be less than ${(maxSize / 1024 / 1024).toFixed(1)}MB`;
        }
        return null;
    }, [accept, maxSize]);

    const handleFile = useCallback((file: File) => {
        const validationError = validateFile(file);
        if (validationError) {
            setError(validationError);
            return;
        }
        setError(null);
        onFileSelect(file);
    }, [validateFile, onFileSelect]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) {
            setIsDragging(true);
        }
    }, [disabled]);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (disabled) return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            handleFile(files[0]);
        }
    }, [disabled, handleFile]);

    const handleClick = useCallback(() => {
        if (disabled) return;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) {
                handleFile(file);
            }
        };
        input.click();
    }, [disabled, accept, handleFile]);

    // If a file is already selected, show the file info
    if (currentFileName) {
        return (
            <Box
                p={4}
                borderWidth="2px"
                borderStyle="solid"
                borderColor="green.300"
                borderRadius="md"
                bg="green.50"
            >
                <Flex align="center" justify="space-between">
                    <Flex align="center" gap={2}>
                        <Icon as={FiCheck} color="green.500" />
                        <Icon as={FiFile} color="gray.500" />
                        <Text fontSize="sm" fontWeight="medium">
                            {currentFileName}
                        </Text>
                    </Flex>
                    {onRemove && (
                        <Button
                            size="sm"
                            variant="ghost"
                            colorPalette="red"
                            onClick={onRemove}
                            disabled={disabled}
                        >
                            <Icon as={FiX} />
                            Remove
                        </Button>
                    )}
                </Flex>
            </Box>
        );
    }

    return (
        <Box>
            <Box
                p={6}
                borderWidth="2px"
                borderStyle="dashed"
                borderColor={isDragging ? 'blue.400' : error ? 'red.300' : 'gray.300'}
                borderRadius="md"
                bg={isDragging ? 'blue.50' : 'gray.50'}
                textAlign="center"
                cursor={disabled ? 'not-allowed' : 'pointer'}
                opacity={disabled ? 0.6 : 1}
                transition="all 0.2s"
                _hover={!disabled ? { borderColor: 'blue.400', bg: 'blue.50' } : undefined}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClick}
            >
                <Flex direction="column" align="center" gap={2}>
                    <Icon as={FiUpload} boxSize={8} color={isDragging ? 'blue.500' : 'gray.400'} />
                    <Text fontWeight="medium" color={isDragging ? 'blue.600' : 'gray.600'}>
                        {isDragging ? 'Drop file here' : 'Drag & drop a JSON file here'}
                    </Text>
                    <Text fontSize="sm" color="gray.500">
                        or click to browse
                    </Text>
                </Flex>
            </Box>
            {error && (
                <Text color="red.500" fontSize="sm" mt={2}>
                    {error}
                </Text>
            )}
        </Box>
    );
};

export default FileDropzone;
