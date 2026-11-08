/**
 * QaTestPlanPanel
 *
 * Floating action button (bottom-right, like a support chat widget)
 * that opens a side panel with QA test plan steps.
 * Supports pin/unpin: when pinned, the panel sits alongside the app
 * (pushes content left) instead of overlaying it.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Badge, Button, Heading, Spinner } from './ui/primitives';
import { FiClipboard, FiCheckSquare, FiSquare, FiChevronLeft, FiX } from 'react-icons/fi';
import { API_URL, AppInfo } from '../types';

const QA_PANEL_WIDTH = 380;

// ── Context: exposes pinned width + panel controls so StatusBar can trigger open ──
interface QaPinContext {
    pinnedWidth: number;
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    appInfo: AppInfo | null;
    doneCount: number;
    totalSteps: number;
}
const QaPinCtx = createContext<QaPinContext>({
    pinnedWidth: 0,
    isOpen: false,
    setIsOpen: () => { },
    appInfo: null,
    doneCount: 0,
    totalSteps: 0,
});
export const useQaPinnedWidth = () => useContext(QaPinCtx).pinnedWidth;
export const useQaContext = () => useContext(QaPinCtx);

/** Sub-step: something to do in the UI, a command to run, and what to check. */
interface TestAction {
    do?: string;
    run?: string;
    expect?: string;
}

interface TestStep {
    id: number;
    title: string;
    description?: string;
    commands?: string[];
    actions?: TestAction[];
    /** A single expectation, or one per variant (e.g. "default", "taxable swaps"). */
    expected?: string | Record<string, string>;
    verification?: string;
}

interface TestPlan {
    name: string;
    description: string;
    preconditions?: string[];
    commands?: string[];
    steps: TestStep[];
}

const CommandBlock: React.FC<{ code: string }> = ({ code }) => {
    const [copied, setCopied] = useState(false);
    return (
        <div className="relative mb-1" onClick={e => e.stopPropagation()}>
            <pre className="cursor-text overflow-x-auto whitespace-pre bg-slate-900 p-2 pr-14 text-[11px] leading-snug text-slate-100">{code}</pre>
            <button
                type="button"
                className="absolute right-1 top-1 bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-100 hover:bg-slate-600"
                onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true)); }}
            >
                {copied ? 'Copied' : 'Copy'}
            </button>
        </div>
    );
};

export const QaTestPlanProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [pinnedWidth, setPinnedWidth] = useState(0);
    const [isOpen, setIsOpen] = useState(false);
    const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
    const [doneCount, setDoneCount] = useState(0);
    const [totalSteps, setTotalSteps] = useState(0);

    // Fetch app info once (shared with StatusBar via context)
    useEffect(() => {
        const fetchAppInfo = async () => {
            try {
                const response = await fetch(`${API_URL}/config/info`);
                if (response.ok) {
                    const data: AppInfo = await response.json();
                    setAppInfo(data);
                }
            } catch {
                // ignore
            }
        };
        fetchAppInfo();
    }, []);

    return (
        <QaPinCtx.Provider value={{ pinnedWidth, isOpen, setIsOpen, appInfo, doneCount, totalSteps }}>
            {children}
            <QaTestPlanPanelInner
                onPinnedWidthChange={setPinnedWidth}
                isOpen={isOpen}
                setIsOpen={setIsOpen}
                appInfo={appInfo}
                onProgressChange={(done, total) => { setDoneCount(done); setTotalSteps(total); }}
            />
        </QaPinCtx.Provider>
    );
};

interface PanelInnerProps {
    onPinnedWidthChange: (w: number) => void;
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
    appInfo: AppInfo | null;
    onProgressChange: (done: number, total: number) => void;
}

const QaTestPlanPanelInner: React.FC<PanelInnerProps> = ({ onPinnedWidthChange, isOpen, setIsOpen, appInfo, onProgressChange }) => {
    const [pinned, setPinned] = useState(false);
    const [activeScenario, setActiveScenario] = useState<string | null>(null);
    const [testPlan, setTestPlan] = useState<TestPlan | null>(null);
    const [loading, setLoading] = useState(false);
    const [checkedSteps, setCheckedSteps] = useState<Record<string, Set<number>>>({});

    // Notify parent of pinned width changes
    useEffect(() => {
        onPinnedWidthChange(pinned && isOpen ? QA_PANEL_WIDTH : 0);
    }, [pinned, isOpen, onPinnedWidthChange]);

    // Auto-select single scenario
    useEffect(() => {
        if (appInfo?.qa_scenarios?.length === 1 && !activeScenario) {
            setActiveScenario(appInfo.qa_scenarios[0]);
        }
    }, [appInfo, activeScenario]);

    // Fetch test plan when a scenario is selected
    useEffect(() => {
        if (!activeScenario) { setTestPlan(null); return; }
        setLoading(true);
        const fetchTestPlan = async () => {
            try {
                const response = await fetch(
                    `${API_URL}/config/test-plan?scenario=${encodeURIComponent(activeScenario)}`
                );
                if (response.ok) {
                    setTestPlan(await response.json() as TestPlan);
                }
            } catch {
                // ignore
            } finally {
                setLoading(false);
            }
        };
        fetchTestPlan();
    }, [activeScenario]);

    const toggleStep = (stepId: number) => {
        if (!activeScenario) return;
        setCheckedSteps(prev => {
            const scenarioSet = new Set(prev[activeScenario] ?? []);
            if (scenarioSet.has(stepId)) scenarioSet.delete(stepId);
            else scenarioSet.add(stepId);
            return { ...prev, [activeScenario]: scenarioSet };
        });
    };

    const scenarios = appInfo?.qa_scenarios ?? [];

    const doneSet = activeScenario ? (checkedSteps[activeScenario] ?? new Set<number>()) : new Set<number>();
    const totalSteps = testPlan?.steps?.length ?? 0;
    const doneCount = doneSet.size;
    const hasMultiple = scenarios.length > 1;

    // Report progress to parent context
    useEffect(() => {
        onProgressChange(doneCount, totalSteps);
    }, [doneCount, totalSteps, onProgressChange]);

    if (scenarios.length === 0) return null;

    const handleClose = () => {
        setIsOpen(false);
        if (pinned) { setPinned(false); }
    };

    const togglePin = () => setPinned(p => !p);

    // ── Panel content (shared between pinned & overlay modes) ────────
    const panelContent = (
        <>
            {/* Header */}
            <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2">
                    <FiClipboard size={16} />
                    <Heading className="text-sm">{activeScenario ? `QA: ${activeScenario}` : 'QA Test Plans'}</Heading>
                </div>
                <div className="flex gap-1">
                    <Button
                        aria-label={pinned ? 'Unpin panel' : 'Pin panel'}
                        variant="ghost"
                        size="sm"
                        onClick={togglePin}
                        title={pinned ? 'Unpin (overlay mode)' : 'Pin (side-by-side)'}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {pinned ? (
                                // Pinned icon — filled pin
                                <>
                                    <line x1="12" y1="17" x2="12" y2="22" />
                                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" fill="currentColor" />
                                </>
                            ) : (
                                // Unpinned icon — outline pin with slash
                                <>
                                    <line x1="12" y1="17" x2="12" y2="22" />
                                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                                    <line x1="2" y1="2" x2="22" y2="22" />
                                </>
                            )}
                        </svg>
                    </Button>
                    <Button aria-label="Close" variant="ghost" size="sm" onClick={handleClose}>
                        <FiX size={16} />
                    </Button>
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-3">
                {/* Scenario picker */}
                {(!activeScenario || (hasMultiple && !testPlan)) && (
                    <div className="mb-4">
                        <span className="mb-2 block text-xs text-slate-500">Select a scenario:</span>
                        <div className="flex flex-col gap-2">
                            {scenarios.map(s => {
                                const sDone = checkedSteps[s]?.size ?? 0;
                                return (
                                    <div
                                        key={s}
                                        className="cursor-pointer border border-slate-200 p-3 hover:border-purple-300 hover:bg-purple-50"
                                        onClick={() => setActiveScenario(s)}
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-bold">{s}</span>
                                            {sDone > 0 && (
                                                <Badge colorScheme="green" className="text-xs">{sDone} done</Badge>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Back button when viewing a scenario in multi mode */}
                {hasMultiple && activeScenario && testPlan && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="mb-3"
                        onClick={() => { setActiveScenario(null); setTestPlan(null); }}
                    >
                        <FiChevronLeft /> All scenarios
                    </Button>
                )}

                {loading && (
                    <div className="flex justify-center py-8"><Spinner size="lg" /></div>
                )}

                {testPlan && (
                    <div>
                        <Heading className="mb-1 text-xs">{testPlan.name}</Heading>
                        <span className="mb-4 block text-xs text-slate-500">{testPlan.description}</span>
                        {testPlan.preconditions && testPlan.preconditions.length > 0 && (
                            <div className="mb-3">
                                <span className="mb-1 block text-xs font-semibold">Preconditions</span>
                                <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-600">
                                    {testPlan.preconditions.map(item => <li key={item}>{item}</li>)}
                                </ul>
                            </div>
                        )}
                        {testPlan.commands?.map(code => <CommandBlock key={code} code={code} />)}

                        <Badge
                            colorScheme={doneCount === totalSteps ? 'green' : 'purple'}
                            className="mb-3 text-xs"
                        >
                            {doneCount} / {totalSteps} completed
                        </Badge>

                        {testPlan.steps.map((step) => {
                            const isDone = doneSet.has(step.id);
                            return (
                                <div
                                    key={step.id}
                                    className={`mb-2 cursor-pointer border p-2 transition-all hover:border-purple-300 ${isDone ? 'border-green-200 bg-green-50 opacity-70' : 'border-slate-200 bg-white'}`}
                                    onClick={() => toggleStep(step.id)}
                                >
                                    <div className="flex items-start gap-2">
                                        <div className={`mt-[2px] shrink-0 ${isDone ? 'text-green-500' : 'text-slate-400'}`}>
                                            {isDone ? <FiCheckSquare size={14} /> : <FiSquare size={14} />}
                                        </div>
                                        <div className="flex-1">
                                            <span className="mb-0.5 block text-xs font-bold">
                                                {step.id}. {step.title}
                                            </span>
                                            {step.description && (
                                                <span className="mb-1 block text-xs text-slate-600">{step.description}</span>
                                            )}
                                            {step.commands?.map(code => <CommandBlock key={code} code={code} />)}
                                            {step.actions && step.actions.length > 0 && (
                                                <ol className="mb-1 space-y-2">
                                                    {step.actions.map((action, i) => (
                                                        <li key={i} className="flex gap-1.5">
                                                            <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center bg-purple-100 text-[10px] font-semibold text-purple-700">
                                                                {String.fromCharCode(97 + i)}
                                                            </span>
                                                            <div className="min-w-0 flex-1">
                                                                {action.do && <p className="mb-1 text-xs text-slate-800">{action.do}</p>}
                                                                {action.run && <CommandBlock code={action.run} />}
                                                                {action.expect && (
                                                                    <p className="bg-blue-50 px-2 py-1 text-xs text-blue-700">
                                                                        <strong>Expect:</strong> {action.expect}
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </li>
                                                    ))}
                                                </ol>
                                            )}
                                            {step.expected && (
                                                <div className="mb-1 bg-blue-50 px-2 py-1 text-xs text-blue-700">
                                                    {typeof step.expected === 'string' ? (
                                                        <span><strong>Expected:</strong> {step.expected}</span>
                                                    ) : (
                                                        <div className="space-y-1">
                                                            <strong>Expected:</strong>
                                                            {Object.entries(step.expected).map(([variant, text]) => (
                                                                <p key={variant}><strong className="font-semibold">{variant}:</strong> {String(text)}</p>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {step.verification && (
                                                <span className="block text-xs italic text-slate-500">✓ {step.verification}</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );

    return (
        <>
            {/* Overlay mode (unpinned): backdrop + fixed panel */}
            {isOpen && !pinned && (
                <>
                    <div
                        className="fixed inset-0 z-[199] bg-black/40"
                        onClick={handleClose}
                    />
                    <div
                        className="fixed bottom-0 right-0 top-0 z-[200] flex w-[380px] max-w-[90vw] flex-col border-l border-slate-200 bg-white shadow-xl"
                    >
                        {panelContent}
                    </div>
                </>
            )}

            {/* Pinned mode: fixed panel, no backdrop, app shrinks via margin */}
            {isOpen && pinned && (
                <div
                    className="fixed bottom-0 right-0 top-0 z-10 flex w-[380px] flex-col border-l border-slate-200 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.08)]"
                >
                    {panelContent}
                </div>
            )}
        </>
    );
};
