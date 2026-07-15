import React, { useState, useCallback } from 'react';
import { FiUpload, FiFile, FiX, FiCheck } from 'react-icons/fi';
import { Button } from './ui/primitives';

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
            <div className="border-2 border-solid border-green-300 bg-green-50 p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FiCheck className="text-green-500" />
                        <FiFile className="text-slate-500" />
                        <span className="text-sm font-medium">
                            {currentFileName}
                        </span>
                    </div>
                    {onRemove && (
                        <Button
                            size="sm"
                            variant="ghost"
                            colorScheme="red"
                            onClick={onRemove}
                            disabled={disabled}
                        >
                            <FiX />
                            Remove
                        </Button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div>
            <div
                className={`border-2 border-dashed p-6 text-center transition-all ${isDragging ? 'border-blue-400 bg-blue-50' : error ? 'border-red-300 bg-slate-50' : 'border-slate-300 bg-slate-50'} ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-blue-400 hover:bg-blue-50'}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClick}
            >
                <div className="flex flex-col items-center gap-2">
                    <FiUpload size={32} className={isDragging ? 'text-blue-500' : 'text-slate-400'} />
                    <span className={`font-medium ${isDragging ? 'text-blue-600' : 'text-slate-600'}`}>
                        {isDragging ? 'Drop file here' : 'Drag & drop a JSON file here'}
                    </span>
                    <span className="text-sm text-slate-500">
                        or click to browse
                    </span>
                </div>
            </div>
            {error && (
                <span className="mt-2 block text-sm text-red-500">
                    {error}
                </span>
            )}
        </div>
    );
};

export default FileDropzone;
