import React, { useState, useRef, useCallback } from 'react';
import {
    Badge,
    Button,
    Spinner,
    Text,
} from './ui/primitives';
import { toaster } from './ui/toaster';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../types';
import { formatDateTimeCompact } from '../utils/dateUtils';
import { LuUpload, LuRefreshCw } from 'react-icons/lu';
import { FiCheckCircle } from 'react-icons/fi';

interface ToggleSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-4 w-7 items-center transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300'}`}
    >
        <span
            className={`inline-block h-3 w-3 transform bg-white transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
    </button>
);

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
        <div className="border border-gray-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
                <LuUpload size={20} />
                <Text className="text-lg font-bold">Import Trades from CSV</Text>
            </div>

            {importStep === 'select' && (
                <div>
                    <Text className="mb-4 block text-gray-600">
                        Upload a CSV file with trades to import. The file should have columns for:
                        Date, Transaction Type, Asset, Quantity, Unit Price, Trading Fees, Investment Account.
                    </Text>
                    <div
                        className={`cursor-pointer border-2 border-dashed border-gray-300 p-8 text-center transition-all hover:border-green-400 hover:bg-green-50 ${importFile ? 'bg-green-50' : 'bg-gray-50'}`}
                        onDrop={handleFileDrop}
                        onDragOver={(e) => e.preventDefault()}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        <input
                            type="file"
                            accept=".csv"
                            onChange={handleFileSelect}
                            ref={fileInputRef}
                            style={{ display: 'none' }}
                        />
                        {importFile ? (
                            <div>
                                <Text className="block font-bold text-green-600">✓ {importFile.name}</Text>
                                <Text className="block text-sm text-gray-500">{(importFile.size / 1024).toFixed(1)} KB</Text>
                            </div>
                        ) : (
                            <div>
                                <Text className="mb-2 block text-lg">📁 Drop CSV file here or click to browse</Text>
                                <Text className="block text-sm text-gray-500">Supports .csv files</Text>
                            </div>
                        )}
                    </div>
                    <div className="mt-4 flex justify-end">
                        <Button
                            colorScheme="green"
                            onClick={previewImport}
                            disabled={!importFile || importLoading}
                        >
                            {importLoading ? <Spinner size="sm" /> : 'Preview Import'}
                        </Button>
                    </div>
                </div>
            )}

            {importStep === 'preview' && importPreview && (
                <div>
                    <div className="mb-4 flex flex-wrap gap-4">
                        <Badge colorScheme="blue" className="p-2 text-sm">
                            📊 {importPreview.transactions_count} Transactions
                        </Badge>
                        <Badge colorScheme="purple" className="p-2 text-sm">
                            👤 {importPreview.accounts_count} Accounts
                        </Badge>
                        <Badge colorScheme="green" className="p-2 text-sm">
                            💎 {importPreview.assets_count} Assets
                        </Badge>
                        {importPreview.fee_transactions_count > 0 && (
                            <Badge colorScheme="orange" className="p-2 text-sm">
                                💰 {importPreview.fee_transactions_count} Fee Transactions
                            </Badge>
                        )}
                    </div>

                    {importPreview.errors.length > 0 && (
                        <div className="mb-4 border border-red-200 bg-red-50 p-3">
                            <Text className="mb-2 block font-bold text-red-600">⚠️ Parse Errors ({importPreview.errors.length})</Text>
                            {importPreview.errors.slice(0, 5).map((err, i) => (
                                <Text key={i} className="block text-sm text-red-600">Row {err.row}: {err.error}</Text>
                            ))}
                            {importPreview.errors.length > 5 && (
                                <Text className="block text-sm text-red-500">...and {importPreview.errors.length - 5} more errors</Text>
                            )}
                        </div>
                    )}

                    {importPreview.warnings.length > 0 && (
                        <div className="mb-4 border border-yellow-200 bg-yellow-50 p-3">
                            <Text className="mb-2 block font-bold text-yellow-700">⚠️ Warnings ({importPreview.warnings.length})</Text>
                            {importPreview.warnings.slice(0, 5).map((warn, i) => (
                                <Text key={i} className="block text-sm text-yellow-700">{warn}</Text>
                            ))}
                        </div>
                    )}

                    <div className="mb-4">
                        <Text className="mb-2 block font-bold">Accounts to create as RawAccount:</Text>
                        <div className="flex flex-wrap gap-1">
                            {importPreview.accounts.map((acc, i) => (
                                <Badge key={i} colorScheme="purple" className="text-xs">{acc}</Badge>
                            ))}
                        </div>
                    </div>

                    <div className="mb-4">
                        <Text className="mb-2 block font-bold">Assets to create as RawAsset:</Text>
                        <div className="flex max-h-[100px] flex-wrap gap-1 overflow-auto">
                            {importPreview.assets.slice(0, 30).map((asset, i) => (
                                <Badge key={i} colorScheme="green" className="text-xs">{asset}</Badge>
                            ))}
                            {importPreview.assets.length > 30 && (
                                <Badge colorScheme="gray" className="text-xs">+{importPreview.assets.length - 30} more</Badge>
                            )}
                        </div>
                    </div>

                    <div>
                        <Text className="mb-2 block font-bold">Transaction Preview (first 20) - Source → Transformed:</Text>
                        <div className="max-h-[350px] overflow-auto border border-gray-200">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr>
                                        <th className="px-2 py-1 text-left">Date</th>
                                        <th className="bg-gray-100 px-2 py-1 text-left">CSV Type</th>
                                        <th className="bg-blue-50 px-2 py-1 text-left">→ DB Type</th>
                                        <th className="bg-blue-50 px-2 py-1 text-left">→ Direction</th>
                                        <th className="bg-gray-100 px-2 py-1 text-left">CSV Asset</th>
                                        <th className="bg-blue-50 px-2 py-1 text-left">→ DB Asset</th>
                                        <th className="px-2 py-1 text-left">Qty</th>
                                        <th className="bg-blue-50 px-2 py-1 text-left">→ Fee</th>
                                        <th className="bg-gray-100 px-2 py-1 text-left">CSV Account</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {importPreview.transactions.slice(0, 20).map((tx, i) => {
                                        const dbType = tx.is_fee_transaction ? 'cost' : 'trade';
                                        const direction = tx.is_fee_transaction
                                            ? 'neutral'
                                            : (tx.transaction_type === 'Buy' ? 'inflow' : 'outflow');
                                        const dbQty = tx.is_fee_transaction ? 0 : tx.quantity;
                                        const dbFee = tx.is_fee_transaction ? tx.quantity : tx.fee;
                                        const dbAsset = tx.is_fee_transaction ? null : tx.asset_ticker;

                                        return (
                                            <tr key={i} className={tx.is_fee_transaction ? 'bg-orange-50' : ''}>
                                                <td className="px-2 py-1 text-xs">{formatDateTimeCompact(tx.date_time)}</td>
                                                <td className="bg-gray-50 px-2 py-1 text-xs">
                                                    <Badge colorScheme="gray" className="text-xs">
                                                        {tx.transaction_type}
                                                    </Badge>
                                                </td>
                                                <td className="bg-blue-50 px-2 py-1 text-xs">
                                                    <Badge colorScheme={tx.is_fee_transaction ? 'orange' : 'blue'} className="text-xs">
                                                        {dbType}
                                                    </Badge>
                                                </td>
                                                <td className="bg-blue-50 px-2 py-1 text-xs">
                                                    <Badge
                                                        colorScheme={direction === 'inflow' ? 'green' : direction === 'outflow' ? 'red' : 'gray'}
                                                        className="text-xs"
                                                    >
                                                        {direction}
                                                    </Badge>
                                                </td>
                                                <td className="max-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap bg-gray-50 px-2 py-1 text-xs" title={tx.asset_label}>
                                                    {tx.asset_ticker}
                                                </td>
                                                <td className="bg-blue-50 px-2 py-1 text-xs">
                                                    {dbAsset ? (
                                                        <Badge colorScheme="green" className="text-xs" title="Will create RawAsset for mapping">
                                                            {dbAsset}
                                                        </Badge>
                                                    ) : (
                                                        <Text className="text-xs text-gray-400">None</Text>
                                                    )}
                                                </td>
                                                <td className="px-2 py-1 text-xs">
                                                    {tx.is_fee_transaction ? (
                                                        <span className="text-gray-400 line-through">{tx.quantity?.toFixed(2)}</span>
                                                    ) : (
                                                        tx.quantity?.toFixed(4) || '-'
                                                    )}
                                                </td>
                                                <td className="bg-blue-50 px-2 py-1 text-xs">
                                                    {dbFee ? `€${dbFee.toFixed(2)}` : '-'}
                                                </td>
                                                <td className="bg-gray-50 px-2 py-1 text-xs">{tx.account_code}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <div className="mt-2 flex gap-4 text-xs text-gray-600">
                            <Text><span className="bg-gray-100 px-1">Gray</span> = CSV source values</Text>
                            <Text><span className="bg-blue-50 px-1">Blue</span> = Transformed DB values</Text>
                        </div>
                    </div>

                    <div className="mt-4 bg-blue-50 p-3">
                        <div className="flex items-center gap-2">
                            <ToggleSwitch
                                checked={dryRunMode}
                                onChange={(checked) => setDryRunMode(checked)}
                            />
                            <Text className="font-bold">Dry Run Mode</Text>
                        </div>
                        <Text className="mt-1 block text-sm text-gray-600">
                            {dryRunMode
                                ? 'Preview only - no changes will be saved to the database'
                                : '⚠️ Changes will be committed to the database'}
                        </Text>
                    </div>

                    <div className="mt-4 flex justify-between gap-2">
                        <Button variant="outline" onClick={resetImport}>
                            ← Back
                        </Button>
                        <Button
                            colorScheme={dryRunMode ? 'blue' : 'green'}
                            onClick={executeImport}
                            disabled={importLoading}
                        >
                            {importLoading ? <Spinner size="sm" /> : (dryRunMode ? 'Run Dry Import' : 'Import Now')}
                        </Button>
                    </div>
                </div>
            )}

            {importStep === 'result' && importResult && (
                <div>
                    <div className={`mb-4 p-4 ${importResult.dry_run ? 'bg-blue-50' : 'bg-green-50'}`}>
                        <div className="flex items-center gap-2">
                            <FiCheckCircle size={24} color={importResult.dry_run ? '#3182CE' : '#38A169'} />
                            <Text className="text-lg font-bold">
                                {importResult.dry_run ? 'Dry Run Complete' : 'Import Complete'}
                            </Text>
                        </div>
                        {importResult.dry_run && (
                            <Text className="mt-1 block text-sm text-blue-600">
                                No changes were saved. Run again with Dry Run disabled to commit.
                            </Text>
                        )}
                    </div>

                    <div className="mb-4 flex flex-wrap gap-4">
                        <div className="min-w-[150px] flex-1 bg-gray-50 p-3">
                            <Text className="block text-sm text-gray-500">Transactions</Text>
                            <Text className="block text-xl font-bold text-green-600">
                                {importResult.transactions.created} created
                            </Text>
                            <Text className="block text-sm text-gray-500">
                                {importResult.transactions.skipped} skipped
                            </Text>
                        </div>
                        <div className="min-w-[150px] flex-1 bg-gray-50 p-3">
                            <Text className="block text-sm text-gray-500">Raw Accounts</Text>
                            <Text className="block text-xl font-bold text-purple-600">
                                {importResult.raw_accounts.created} created
                            </Text>
                            <Text className="block text-sm text-gray-500">
                                {importResult.raw_accounts.skipped} skipped
                            </Text>
                        </div>
                        <div className="min-w-[150px] flex-1 bg-gray-50 p-3">
                            <Text className="block text-sm text-gray-500">Raw Assets</Text>
                            <Text className="block text-xl font-bold text-green-600">
                                {importResult.raw_assets.created} created
                            </Text>
                            <Text className="block text-sm text-gray-500">
                                {importResult.raw_assets.skipped} skipped
                            </Text>
                        </div>
                    </div>

                    {importResult.pending_review_count > 0 && (
                        <div className="mb-4 bg-yellow-50 p-3">
                            <Text className="text-yellow-700">
                                ⚠️ <strong>{importResult.pending_review_count}</strong> transactions need review
                                (unmapped accounts or assets). Use the Raw Accounts and Raw Assets editors in Setup to map them.
                            </Text>
                        </div>
                    )}

                    {importResult.summary.total_errors > 0 && (
                        <div className="mb-4 bg-red-50 p-3">
                            <Text className="block font-bold text-red-600">
                                ❌ {importResult.summary.total_errors} errors occurred
                            </Text>
                        </div>
                    )}

                    <div className="mt-4 flex justify-end gap-2">
                        <Button variant="outline" onClick={resetImport}>
                            <LuRefreshCw /> Import Another
                        </Button>
                        {importResult?.dry_run && (
                            <Button
                                colorScheme="green"
                                onClick={() => {
                                    setDryRunMode(false);
                                    setImportStep('preview');
                                }}
                            >
                                Commit Import
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ImportCSVPanel;
