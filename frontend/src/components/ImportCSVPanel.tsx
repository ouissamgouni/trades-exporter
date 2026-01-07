import React, { useState, useRef, useCallback } from 'react';
import {
    Box,
    Button,
    Text,
    Flex,
    Badge,
    Spinner,
    Table,
    Switch,
} from '@chakra-ui/react';
import { toaster } from './ui/toaster';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../types';
import { formatDateTimeCompact } from '../utils/dateUtils';
import { LuUpload, LuRefreshCw } from 'react-icons/lu';
import { FiCheckCircle } from 'react-icons/fi';

// Types for CSV import
interface TradesImportPreviewTransaction {
    date_time: string | null;
    transaction_type: string;
    asset_ticker: string;
    asset_label: string;
    quantity: number | null;
    price: number | null;
    fee: number | null;
    account_code: string;
    is_fee_transaction: boolean;
}

interface TradesImportPreview {
    filename: string;
    transactions_count: number;
    accounts_count: number;
    assets_count: number;
    fee_transactions_count: number;
    errors: { row: number; error: string }[];
    warnings: string[];
    transactions: TradesImportPreviewTransaction[];
    accounts: string[];
    assets: string[];
}

interface TradesImportResult {
    transactions: { created: number; skipped: number; errors: any[] };
    raw_accounts: { created: number; skipped: number; errors: any[] };
    raw_assets: { created: number; skipped: number; errors: any[] };
    pending_review_count: number;
    parse_errors: any[];
    warnings: string[];
    dry_run: boolean;
    summary: { total_transactions: number; total_raw_accounts: number; total_raw_assets: number; total_errors: number };
}

interface ImportCSVPanelProps {
    onDataChange?: () => void;
}

export const ImportCSVPanel: React.FC<ImportCSVPanelProps> = ({ onDataChange }) => {
    const queryClient = useQueryClient();
    const fileInputRef = useRef<HTMLInputElement>(null);
    
    // Import state
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPreview, setImportPreview] = useState<TradesImportPreview | null>(null);
    const [importResult, setImportResult] = useState<TradesImportResult | null>(null);
    const [importLoading, setImportLoading] = useState(false);
    const [importStep, setImportStep] = useState<'select' | 'preview' | 'result'>('select');
    const [dryRunMode, setDryRunMode] = useState(true);

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            setImportFile(file);
        }
    };

    const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file && file.name.endsWith('.csv')) {
            setImportFile(file);
        } else {
            toaster.error({ title: 'Invalid file', description: 'Please drop a CSV file' });
        }
    };

    const previewImport = useCallback(async () => {
        if (!importFile) return;
        setImportLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', importFile);

            const response = await fetch(`${API_URL}/transactions/import-csv/preview`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Preview failed');
            }

            const data: TradesImportPreview = await response.json();
            setImportPreview(data);
            setImportStep('preview');
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to preview CSV' });
        } finally {
            setImportLoading(false);
        }
    }, [importFile]);

    const executeImport = useCallback(async () => {
        if (!importFile) return;
        setImportLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', importFile);

            const params = new URLSearchParams();
            params.append('dry_run', String(dryRunMode));

            const response = await fetch(`${API_URL}/transactions/import-csv?${params}`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Import failed');
            }

            const data: TradesImportResult = await response.json();
            setImportResult(data);
            setImportStep('result');

            // Refresh transactions list if not a dry run
            if (!dryRunMode) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                onDataChange?.();
            }
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to import CSV' });
        } finally {
            setImportLoading(false);
        }
    }, [importFile, dryRunMode, queryClient, onDataChange]);

    const resetImport = () => {
        setImportStep('select');
        setImportFile(null);
        setImportPreview(null);
        setImportResult(null);
        setDryRunMode(true);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    return (
        <Box p={6} bg="white" borderRadius="lg" borderWidth={1} shadow="sm">
            <Flex align="center" gap={2} mb={4}>
                <LuUpload size={20} />
                <Text fontSize="lg" fontWeight="bold">Import Trades from CSV</Text>
            </Flex>

            {importStep === 'select' && (
                <Box>
                    <Text mb={4} color="gray.600">
                        Upload a CSV file with trades to import. The file should have columns for:
                        Date, Transaction Type, Asset, Quantity, Unit Price, Trading Fees, Investment Account.
                    </Text>
                    <Box
                        border="2px dashed"
                        borderColor="gray.300"
                        borderRadius="md"
                        p={8}
                        textAlign="center"
                        onDrop={handleFileDrop}
                        onDragOver={(e) => e.preventDefault()}
                        bg={importFile ? 'green.50' : 'gray.50'}
                        cursor="pointer"
                        onClick={() => fileInputRef.current?.click()}
                        _hover={{ borderColor: 'teal.400', bg: 'teal.50' }}
                        transition="all 0.2s"
                    >
                        <input
                            type="file"
                            accept=".csv"
                            onChange={handleFileSelect}
                            ref={fileInputRef}
                            style={{ display: 'none' }}
                        />
                        {importFile ? (
                            <Box>
                                <Text color="green.600" fontWeight="bold">✓ {importFile.name}</Text>
                                <Text fontSize="sm" color="gray.500">{(importFile.size / 1024).toFixed(1)} KB</Text>
                            </Box>
                        ) : (
                            <Box>
                                <Text fontSize="lg" mb={2}>📁 Drop CSV file here or click to browse</Text>
                                <Text fontSize="sm" color="gray.500">Supports .csv files</Text>
                            </Box>
                        )}
                    </Box>
                    <Flex mt={4} justify="flex-end">
                        <Button
                            colorPalette="teal"
                            onClick={previewImport}
                            disabled={!importFile || importLoading}
                        >
                            {importLoading ? <Spinner size="sm" /> : 'Preview Import'}
                        </Button>
                    </Flex>
                </Box>
            )}

            {importStep === 'preview' && importPreview && (
                <Box>
                    <Flex gap={4} mb={4} flexWrap="wrap">
                        <Badge colorPalette="blue" fontSize="sm" p={2}>
                            📊 {importPreview.transactions_count} Transactions
                        </Badge>
                        <Badge colorPalette="purple" fontSize="sm" p={2}>
                            👤 {importPreview.accounts_count} Accounts
                        </Badge>
                        <Badge colorPalette="teal" fontSize="sm" p={2}>
                            💎 {importPreview.assets_count} Assets
                        </Badge>
                        {importPreview.fee_transactions_count > 0 && (
                            <Badge colorPalette="orange" fontSize="sm" p={2}>
                                💰 {importPreview.fee_transactions_count} Fee Transactions
                            </Badge>
                        )}
                    </Flex>

                    {importPreview.errors.length > 0 && (
                        <Box mb={4} p={3} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                            <Text color="red.600" fontWeight="bold" mb={2}>⚠️ Parse Errors ({importPreview.errors.length})</Text>
                            {importPreview.errors.slice(0, 5).map((err, i) => (
                                <Text key={i} fontSize="sm" color="red.600">Row {err.row}: {err.error}</Text>
                            ))}
                            {importPreview.errors.length > 5 && (
                                <Text fontSize="sm" color="red.500">...and {importPreview.errors.length - 5} more errors</Text>
                            )}
                        </Box>
                    )}

                    {importPreview.warnings.length > 0 && (
                        <Box mb={4} p={3} bg="yellow.50" borderRadius="md" borderWidth={1} borderColor="yellow.200">
                            <Text color="yellow.700" fontWeight="bold" mb={2}>⚠️ Warnings ({importPreview.warnings.length})</Text>
                            {importPreview.warnings.slice(0, 5).map((warn, i) => (
                                <Text key={i} fontSize="sm" color="yellow.700">{warn}</Text>
                            ))}
                        </Box>
                    )}

                    <Box mb={4}>
                        <Text fontWeight="bold" mb={2}>Accounts to create as RawAccount:</Text>
                        <Flex gap={1} flexWrap="wrap">
                            {importPreview.accounts.map((acc, i) => (
                                <Badge key={i} colorPalette="purple" fontSize="xs">{acc}</Badge>
                            ))}
                        </Flex>
                    </Box>

                    <Box mb={4}>
                        <Text fontWeight="bold" mb={2}>Assets to create as RawAsset:</Text>
                        <Flex gap={1} flexWrap="wrap" maxH="100px" overflow="auto">
                            {importPreview.assets.slice(0, 30).map((asset, i) => (
                                <Badge key={i} colorPalette="teal" fontSize="xs">{asset}</Badge>
                            ))}
                            {importPreview.assets.length > 30 && (
                                <Badge colorPalette="gray" fontSize="xs">+{importPreview.assets.length - 30} more</Badge>
                            )}
                        </Flex>
                    </Box>

                    <Box>
                        <Text fontWeight="bold" mb={2}>Transaction Preview (first 20) - Source → Transformed:</Text>
                        <Box maxH="350px" overflow="auto" borderWidth={1} borderRadius="md">
                            <Table.Root size="sm">
                                <Table.Header>
                                    <Table.Row>
                                        <Table.ColumnHeader>Date</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="gray.100">CSV Type</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="blue.50">→ DB Type</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="blue.50">→ Direction</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="gray.100">CSV Asset</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="blue.50">→ DB Asset</Table.ColumnHeader>
                                        <Table.ColumnHeader>Qty</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="blue.50">→ Fee</Table.ColumnHeader>
                                        <Table.ColumnHeader bg="gray.100">CSV Account</Table.ColumnHeader>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {importPreview.transactions.slice(0, 20).map((tx, i) => {
                                        const dbType = tx.is_fee_transaction ? 'technical' : 'trade';
                                        const direction = tx.is_fee_transaction
                                            ? 'neutral'
                                            : (tx.transaction_type === 'Buy' ? 'inflow' : 'outflow');
                                        const dbQty = tx.is_fee_transaction ? 0 : tx.quantity;
                                        const dbFee = tx.is_fee_transaction ? tx.quantity : tx.fee;
                                        const dbAsset = tx.is_fee_transaction ? null : tx.asset_ticker;

                                        return (
                                            <Table.Row key={i} bg={tx.is_fee_transaction ? 'orange.50' : undefined}>
                                                <Table.Cell fontSize="xs">{formatDateTimeCompact(tx.date_time)}</Table.Cell>
                                                <Table.Cell fontSize="xs" bg="gray.50">
                                                    <Badge colorPalette="gray" size="sm" variant="outline">
                                                        {tx.transaction_type}
                                                    </Badge>
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" bg="blue.50">
                                                    <Badge colorPalette={tx.is_fee_transaction ? 'orange' : 'blue'} size="sm">
                                                        {dbType}
                                                    </Badge>
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" bg="blue.50">
                                                    <Badge
                                                        colorPalette={direction === 'inflow' ? 'green' : direction === 'outflow' ? 'red' : 'gray'}
                                                        size="sm"
                                                    >
                                                        {direction}
                                                    </Badge>
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" bg="gray.50" maxW="100px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={tx.asset_label}>
                                                    {tx.asset_ticker}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" bg="blue.50">
                                                    {dbAsset ? (
                                                        <Badge colorPalette="teal" size="sm" title="Will create RawAsset for mapping">
                                                            {dbAsset}
                                                        </Badge>
                                                    ) : (
                                                        <Text color="gray.400" fontSize="xs">None</Text>
                                                    )}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs">
                                                    {tx.is_fee_transaction ? (
                                                        <Text as="span" textDecoration="line-through" color="gray.400">{tx.quantity?.toFixed(2)}</Text>
                                                    ) : (
                                                        tx.quantity?.toFixed(4) || '-'
                                                    )}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" bg="blue.50">
                                                    {dbFee ? `€${dbFee.toFixed(2)}` : '-'}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" bg="gray.50">{tx.account_code}</Table.Cell>
                                            </Table.Row>
                                        );
                                    })}
                                </Table.Body>
                            </Table.Root>
                        </Box>
                        <Flex mt={2} gap={4} fontSize="xs" color="gray.600">
                            <Text><Box as="span" bg="gray.100" px={1} borderRadius="sm">Gray</Box> = CSV source values</Text>
                            <Text><Box as="span" bg="blue.50" px={1} borderRadius="sm">Blue</Box> = Transformed DB values</Text>
                        </Flex>
                    </Box>

                    <Box mt={4} p={3} bg="blue.50" borderRadius="md">
                        <Flex align="center" gap={2}>
                            <Switch.Root
                                checked={dryRunMode}
                                onCheckedChange={(e: { checked: boolean }) => setDryRunMode(e.checked)}
                            >
                                <Switch.HiddenInput />
                                <Switch.Control />
                            </Switch.Root>
                            <Text fontWeight="bold">Dry Run Mode</Text>
                        </Flex>
                        <Text fontSize="sm" color="gray.600" mt={1}>
                            {dryRunMode
                                ? 'Preview only - no changes will be saved to the database'
                                : '⚠️ Changes will be committed to the database'}
                        </Text>
                    </Box>

                    <Flex mt={4} gap={2} justify="space-between">
                        <Button variant="outline" onClick={resetImport}>
                            ← Back
                        </Button>
                        <Button
                            colorPalette={dryRunMode ? 'blue' : 'green'}
                            onClick={executeImport}
                            disabled={importLoading}
                        >
                            {importLoading ? <Spinner size="sm" /> : (dryRunMode ? 'Run Dry Import' : 'Import Now')}
                        </Button>
                    </Flex>
                </Box>
            )}

            {importStep === 'result' && importResult && (
                <Box>
                    <Box mb={4} p={4} bg={importResult.dry_run ? 'blue.50' : 'green.50'} borderRadius="md">
                        <Flex align="center" gap={2}>
                            <FiCheckCircle size={24} color={importResult.dry_run ? '#3182CE' : '#38A169'} />
                            <Text fontSize="lg" fontWeight="bold">
                                {importResult.dry_run ? 'Dry Run Complete' : 'Import Complete'}
                            </Text>
                        </Flex>
                        {importResult.dry_run && (
                            <Text fontSize="sm" color="blue.600" mt={1}>
                                No changes were saved. Run again with Dry Run disabled to commit.
                            </Text>
                        )}
                    </Box>

                    <Flex gap={4} mb={4} flexWrap="wrap">
                        <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                            <Text fontSize="sm" color="gray.500">Transactions</Text>
                            <Text fontSize="xl" fontWeight="bold" color="green.600">
                                {importResult.transactions.created} created
                            </Text>
                            <Text fontSize="sm" color="gray.500">
                                {importResult.transactions.skipped} skipped
                            </Text>
                        </Box>
                        <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                            <Text fontSize="sm" color="gray.500">Raw Accounts</Text>
                            <Text fontSize="xl" fontWeight="bold" color="purple.600">
                                {importResult.raw_accounts.created} created
                            </Text>
                            <Text fontSize="sm" color="gray.500">
                                {importResult.raw_accounts.skipped} skipped
                            </Text>
                        </Box>
                        <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                            <Text fontSize="sm" color="gray.500">Raw Assets</Text>
                            <Text fontSize="xl" fontWeight="bold" color="teal.600">
                                {importResult.raw_assets.created} created
                            </Text>
                            <Text fontSize="sm" color="gray.500">
                                {importResult.raw_assets.skipped} skipped
                            </Text>
                        </Box>
                    </Flex>

                    {importResult.pending_review_count > 0 && (
                        <Box p={3} bg="yellow.50" borderRadius="md" mb={4}>
                            <Text color="yellow.700">
                                ⚠️ <strong>{importResult.pending_review_count}</strong> transactions need review
                                (unmapped accounts or assets). Use the Raw Accounts and Raw Assets editors in Setup to map them.
                            </Text>
                        </Box>
                    )}

                    {importResult.summary.total_errors > 0 && (
                        <Box p={3} bg="red.50" borderRadius="md" mb={4}>
                            <Text color="red.600" fontWeight="bold">
                                ❌ {importResult.summary.total_errors} errors occurred
                            </Text>
                        </Box>
                    )}

                    <Flex mt={4} gap={2} justify="flex-end">
                        <Button variant="outline" onClick={resetImport}>
                            <LuRefreshCw /> Import Another
                        </Button>
                        {importResult?.dry_run && (
                            <Button
                                colorPalette="green"
                                onClick={() => {
                                    setDryRunMode(false);
                                    setImportStep('preview');
                                }}
                            >
                                Commit Import
                            </Button>
                        )}
                    </Flex>
                </Box>
            )}
        </Box>
    );
};

export default ImportCSVPanel;
