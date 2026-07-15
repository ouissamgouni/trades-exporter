import React, { useEffect, useRef, useState } from 'react';
import { LogEntry } from '../types';

interface ConnectorLogViewerProps {
    logs: LogEntry[];
    maxHeight?: string;
}

const getLevelColor = (level: string): string => {
    switch (level) {
        case 'ERROR':
            return 'text-red-400';
        case 'WARNING':
            return 'text-yellow-400';
        case 'INFO':
            return 'text-slate-100';
        case 'DEBUG':
            return 'text-slate-500';
        default:
            return 'text-slate-300';
    }
};

const getLevelBadgeColor = (level: string): string => {
    switch (level) {
        case 'ERROR':
            return 'red';
        case 'WARNING':
            return 'yellow';
        case 'INFO':
            return 'blue';
        case 'DEBUG':
            return 'gray';
        default:
            return 'gray';
    }
};

const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};

export const ConnectorLogViewer: React.FC<ConnectorLogViewerProps> = ({
    logs,
    maxHeight = '200px',
}) => {
    const [autoScroll, setAutoScroll] = useState(true);
    const [filterLevel, setFilterLevel] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new logs arrive
    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    // Handle manual scroll - disable auto-scroll if user scrolls up
    const handleScroll = () => {
        if (scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
            if (!isAtBottom && autoScroll) {
                setAutoScroll(false);
            }
        }
    };

    // Filter logs by level
    const filteredLogs = filterLevel
        ? logs.filter((log) => log.level === filterLevel)
        : logs;

    if (logs.length === 0) {
        return (
            <div className="bg-slate-900 p-3 font-mono text-xs">
                <span className="block text-center text-slate-500">
                    No logs yet...
                </span>
            </div>
        );
    }

    return (
        <div>
            {/* Controls */}
            <div className="mb-2 flex items-center justify-between">
                <div className="flex gap-1">
                    <span
                        className={`cursor-pointer text-xs hover:text-blue-300 ${!filterLevel ? 'text-blue-400' : 'text-slate-500'}`}
                        onClick={() => setFilterLevel(null)}
                    >
                        All
                    </span>
                    <span className="text-xs text-slate-600">|</span>
                    <span
                        className={`cursor-pointer text-xs hover:text-red-300 ${filterLevel === 'ERROR' ? 'text-red-400' : 'text-slate-500'}`}
                        onClick={() => setFilterLevel(filterLevel === 'ERROR' ? null : 'ERROR')}
                    >
                        Errors
                    </span>
                    <span className="text-xs text-slate-600">|</span>
                    <span
                        className={`cursor-pointer text-xs hover:text-yellow-300 ${filterLevel === 'WARNING' ? 'text-yellow-400' : 'text-slate-500'}`}
                        onClick={() => setFilterLevel(filterLevel === 'WARNING' ? null : 'WARNING')}
                    >
                        Warnings
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                        {filteredLogs.length} logs
                    </span>
                    <span
                        className={`cursor-pointer text-xs hover:underline ${autoScroll ? 'text-green-400' : 'text-slate-500'}`}
                        onClick={() => setAutoScroll(!autoScroll)}
                    >
                        Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
                    </span>
                </div>
            </div>

            {/* Log viewer */}
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="log-scrollbar overflow-y-auto bg-slate-900 p-2 font-mono text-xs"
                style={{ maxHeight }}
            >
                {filteredLogs.map((log, idx) => (
                    <div key={idx} className="mb-0.5 flex items-start gap-2">
                        <span className="shrink-0 text-slate-600">
                            {formatTimestamp(log.timestamp)}
                        </span>
                        <span className={`w-[50px] shrink-0 font-medium ${getLevelColor(log.level)}`}>
                            [{log.level.substring(0, 4)}]
                        </span>
                        <span className={`break-words ${getLevelColor(log.level)}`}>
                            {log.message}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};
