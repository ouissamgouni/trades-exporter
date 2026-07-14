import React, { useCallback, useEffect, useState } from 'react';
import { FiActivity, FiCheckCircle, FiClipboard } from 'react-icons/fi';
import { useDataHealth } from '../contexts/DataHealthContext';
import { useQaContext } from './QaTestPlanPanel';
import { DataHealthCheckDrawer } from './DataHealthCheckDrawer';
import { API_URL, Account, Asset } from '../types';
import { useAssets } from '../hooks/useAssets';

const STATUS_BAR_HEIGHT = 22;

const envColors: Record<string, string> = {
    dev: '#edf2f7',
    test: '#edf2f7',
    staging: '#edf2f7',
    prod: '#edf2f7',
};

const envDotColors: Record<string, string> = {
    dev: '#3b82f6',
    test: '#dd6b20',
    staging: '#dd6b20',
    prod: '#a0aec0',
};

/** Thin divider between segments */
const Divider = () => (
    <div className="mx-1 h-3 w-px shrink-0 bg-black/10" />
);

/** Clickable segment wrapper */
const Segment: React.FC<{ onClick?: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
    <div
        className={`flex h-full shrink-0 items-center gap-1 px-1.5 text-[11px] transition-colors ${onClick ? 'cursor-pointer hover:bg-black/5' : 'cursor-default'}`}
        onClick={onClick}
    >
        {children}
    </div>
);

export const StatusBar: React.FC = () => {
    const { validationSummary, refreshHealthData } = useDataHealth();
    const { appInfo, isOpen: qaIsOpen, setIsOpen: setQaIsOpen, doneCount, totalSteps } = useQaContext();

    // Data health drawer state
    const [isHealthCheckOpen, setIsHealthCheckOpen] = useState(false);
    const [healthCheckRefreshTrigger, setHealthCheckRefreshTrigger] = useState(0);
    const { assets, refetchAssets } = useAssets();
    const [accounts, setAccounts] = useState<Account[]>([]);

    const fetchAccounts = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) {
                setAccounts(await response.json());
            }
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        if (isHealthCheckOpen) fetchAccounts();
    }, [isHealthCheckOpen, fetchAccounts]);

    const env = appInfo?.environment ?? 'prod';
    const isProd = env === 'prod';
    const barBg = envColors[env] ?? envColors.prod;
    const dotColor = envDotColors[env] ?? envDotColors.prod;
    const hasQa = (appInfo?.qa_scenarios?.length ?? 0) > 0 && !isProd;

    return (
        <>
            <div
                className="fixed bottom-0 left-0 right-0 z-50 flex select-none items-center justify-end border-t border-slate-200 text-slate-600"
                style={{
                    height: `${STATUS_BAR_HEIGHT}px`,
                    backgroundColor: barBg,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                }}
            >
                {/* ── Right-aligned segments: Data Health | QA | Env ── */}

                {/* Data Health segment */}
                {validationSummary && (
                    <>
                        <Segment onClick={() => {
                            refreshHealthData();
                            setIsHealthCheckOpen(true);
                        }}>
                            {validationSummary.has_issues ? (
                                <>
                                    <FiActivity size={11} color="#dd6b20" />
                                    <span className="font-semibold" style={{ color: '#dd6b20' }}>
                                        {validationSummary.total_issues} Issues
                                    </span>
                                </>
                            ) : (
                                <>
                                    <FiCheckCircle size={11} color="#38a169" />
                                    <span style={{ color: '#38a169' }}>Healthy</span>
                                </>
                            )}
                        </Segment>
                        <Divider />
                    </>
                )}

                {/* QA segment */}
                {hasQa && (
                    <>
                        <Segment onClick={() => setQaIsOpen(!qaIsOpen)}>
                            <FiClipboard size={11} />
                            <span>QA</span>
                            {totalSteps > 0 && (
                                <span className="font-semibold" style={{ opacity: 0.85 }}>
                                    {doneCount}/{totalSteps}
                                </span>
                            )}
                        </Segment>
                        <Divider />
                    </>
                )}

                {/* Env info segment (rightmost) */}
                <Segment>
                    {!isProd && (
                        <>
                            <span
                                className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                                style={{ backgroundColor: dotColor }}
                            />
                            <span className="font-bold">{env.toUpperCase()}</span>
                        </>
                    )}
                    {appInfo?.backend_version && (
                        <span style={{ opacity: 0.6 }}>{appInfo.backend_version}</span>
                    )}
                    {appInfo?.db_schema_version && (
                        <span style={{ opacity: 0.5 }}>DB {appInfo.db_schema_version}</span>
                    )}
                </Segment>

                {/* Right edge padding */}
                <span className="w-1 shrink-0" />
            </div>

            {/* Data Health Drawer — triggered from status bar */}
            <DataHealthCheckDrawer
                isOpen={isHealthCheckOpen}
                onClose={() => setIsHealthCheckOpen(false)}
                refreshTrigger={healthCheckRefreshTrigger}
                assets={assets}
                accounts={accounts}
                onAssetsUpdated={refetchAssets}
                onAccountsUpdated={fetchAccounts}
                onIssueFixed={() => {
                    refreshHealthData();
                    setHealthCheckRefreshTrigger(prev => prev + 1);
                }}
            />
        </>
    );
};

export const STATUS_BAR_HEIGHT_PX = STATUS_BAR_HEIGHT;
