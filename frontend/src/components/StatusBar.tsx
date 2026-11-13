import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FiActivity, FiCheckCircle, FiClipboard, FiDatabase, FiDownloadCloud, FiMonitor, FiServer } from 'react-icons/fi';
import { useGapFixJob } from '../hooks/usePriceGaps';
import { useDataHealth } from '../contexts/DataHealthContext';
import { useQaContext } from './QaTestPlanPanel';

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

type InfoKind = 'fe' | 'be' | 'db';

// Square corners by design system; full literal classes so Tailwind picks them up.
const PILL_COLORS: Record<InfoKind, string> = {
    fe: 'border-sky-200 bg-sky-50 text-sky-700',
    be: 'border-violet-200 bg-violet-50 text-violet-700',
    db: 'border-emerald-200 bg-emerald-50 text-emerald-700',
};

const InfoPill: React.FC<{ kind: InfoKind; icon: React.ReactNode; label: string; title: string; children: React.ReactNode }> = ({
    kind, icon, label, title, children,
}) => (
    <span
        className={`inline-flex h-4 shrink-0 items-center gap-1 whitespace-nowrap border px-1.5 text-[10px] leading-none ${PILL_COLORS[kind]}`}
        title={title}
        aria-label={title}
    >
        {icon}
        <span className="font-semibold">{label}</span>
        <span className="font-mono">{children}</span>
    </span>
);

/** Shared price-fetch job, visible from any page while it runs (also refreshes prices/P&L when it ends). */
const PriceJobSegment: React.FC<{ onClick: () => void }> = ({ onClick }) => {
    const { job, isActive } = useGapFixJob();
    if (!job || !isActive) return null;
    const pct = job.total_missing_days > 0 ? Math.round((job.processed_days / job.total_missing_days) * 100) : 0;
    const title = `Price fetch job: ${job.completed_assets}/${job.total_assets} assets, ${job.fetched_count} fetched, ${job.failed_count} failed`;
    return (
        <>
            <Segment onClick={onClick}>
                <span className="flex items-center gap-1 text-blue-700" title={title} aria-label={title} data-testid="status-price-job">
                    <FiDownloadCloud size={11} />
                    <span className="font-semibold">Prices {job.status === 'scanning' ? 'scanning…' : `${pct}%`}</span>
                    <span className="opacity-75">{job.completed_assets}/{job.total_assets}</span>
                </span>
            </Segment>
            <Divider />
        </>
    );
};

export const StatusBar: React.FC = () => {
    const { validationSummary, refreshHealthData } = useDataHealth();
    const { appInfo, isOpen: qaIsOpen, setIsOpen: setQaIsOpen, doneCount, totalSteps } = useQaContext();

    const navigate = useNavigate();

    const frontendVersion = import.meta.env.VITE_APP_VERSION;
    const versionTooltip = [
        `Frontend: ${frontendVersion ?? 'unknown'}`,
        `Backend: ${appInfo?.backend_version ?? 'unknown'}`,
        `Database: ${appInfo?.db_name ?? 'unknown'} @ ${appInfo?.db_schema_version ?? 'no migration rev'}`,
        appInfo?.db_provenance ? `Data: ${appInfo.db_provenance.replace(/; /g, '\n      ')}` : null,
    ].filter(Boolean).join('\n');

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
                {/* ── Right-aligned segments: Price job | Data Health | QA | Env ── */}
                <PriceJobSegment onClick={() => navigate('/prices')} />

                {/* Data Health segment */}
                {validationSummary && (
                    <>
                        <Segment onClick={() => {
                            refreshHealthData();
                            navigate('/health');
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
                        <span className="flex items-center gap-1" title={versionTooltip} aria-label={versionTooltip}>
                            <span
                                className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                                style={{ backgroundColor: dotColor }}
                            />
                            <span className="font-bold">{env.toUpperCase()}</span>
                        </span>
                    )}
                    {frontendVersion && (
                        <InfoPill kind="fe" icon={<FiMonitor size={10} />} label="FE" title={`Frontend: ${frontendVersion}`}>
                            {frontendVersion}
                        </InfoPill>
                    )}
                    {appInfo?.backend_version && (
                        <InfoPill kind="be" icon={<FiServer size={10} />} label="BE" title={`Backend: ${appInfo.backend_version}`}>
                            {appInfo.backend_version}
                        </InfoPill>
                    )}
                    {(appInfo?.db_name || appInfo?.db_schema_version) && (
                        <InfoPill
                            kind="db"
                            icon={<FiDatabase size={10} />}
                            label="DB"
                            title={[
                                `Database: ${appInfo.db_name ?? 'unknown'}`,
                                `Migration: ${appInfo.db_schema_version ?? 'none'}`,
                                appInfo.db_provenance ? `Data: ${appInfo.db_provenance}` : null,
                            ].filter(Boolean).join('\n')}
                        >
                            {/* Full details on wide screens, short forms when space is tight */}
                            {appInfo.db_name && <span className="hidden lg:inline">{appInfo.db_name}</span>}
                            {appInfo.db_name && appInfo.db_schema_version && <span className="hidden lg:inline"> @ </span>}
                            {appInfo.db_schema_version && (
                                <>
                                    <span className="hidden xl:inline">{appInfo.db_schema_version}</span>
                                    <span className="xl:hidden">{appInfo.db_schema_version.split('_')[0]}</span>
                                </>
                            )}
                            {appInfo.db_provenance && (
                                <>
                                    <span className="hidden 2xl:inline"> · {appInfo.db_provenance}</span>
                                    <span className="2xl:hidden"> · {appInfo.db_provenance.startsWith('copied_from') ? 'copied' : 'restored'}</span>
                                </>
                            )}
                        </InfoPill>
                    )}
                </Segment>

                {/* Right edge padding */}
                <span className="w-1 shrink-0" />
            </div>

        </>
    );
};

export const STATUS_BAR_HEIGHT_PX = STATUS_BAR_HEIGHT;
