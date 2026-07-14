import { LuClock, LuCheck, LuX, LuInfo } from "react-icons/lu";
import { EnabledConnector } from "../types";
import { Badge, type BadgeColorScheme } from "./ui/primitives";
import { Tooltip } from "./ui/tooltip";

interface ConnectorJobSnippetProps {
    connector: EnabledConnector;
    onClick?: () => void;
}

// Simple relative time formatter
const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
};

export const ConnectorJobSnippet = ({ connector, onClick }: ConnectorJobSnippetProps) => {
    const {
        last_job_status,
        last_job_started_at,
        last_job_finished_at,
        last_job_new = 0,
        last_job_updated = 0,
        last_job_errors = 0,
        last_job_error_message
    } = connector;

    // No job data available
    if (!last_job_status) {
        return (
            <div className="px-3 py-2 bg-slate-50 text-sm text-slate-500">
                No sync history
            </div>
        );
    }

    // Status badge configuration
    const statusConfig: Record<string, { color: BadgeColorScheme; icon: typeof LuCheck; label: string }> = {
        completed: { color: "green", icon: LuCheck, label: "Completed" },
        failed: { color: "red", icon: LuX, label: "Failed" },
        running: { color: "blue", icon: LuClock, label: "Running" },
        queued: { color: "gray", icon: LuClock, label: "Queued" },
        skipped: { color: "orange", icon: LuInfo, label: "Skipped" },
        aborted: { color: "orange", icon: LuInfo, label: "Aborted" },
    };

    const config = statusConfig[last_job_status] || statusConfig.completed;
    const StatusIcon = config.icon;

    // Format timing
    const timeText = last_job_finished_at
        ? formatRelativeTime(last_job_finished_at)
        : last_job_started_at
            ? `Started ${formatRelativeTime(last_job_started_at)}`
            : "";

    // Build metrics text
    const metrics: string[] = [];
    if (last_job_new > 0) metrics.push(`${last_job_new} new`);
    if (last_job_updated > 0) metrics.push(`${last_job_updated} updated`);
    if (last_job_errors > 0) metrics.push(`${last_job_errors} errors`);
    const metricsText = metrics.length > 0 ? metrics.join(", ") : "No changes";

    const isFailed = last_job_status === "failed";

    const content = (
        <div
            className={`px-3 py-2 border ${isFailed ? 'bg-red-50 border-red-200 hover:bg-red-100' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'} ${onClick ? 'cursor-pointer' : 'cursor-default'} transition-colors`}
            onClick={onClick}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Badge colorScheme={config.color}>
                        <StatusIcon size={12} />
                        {config.label}
                    </Badge>
                    <span className="truncate text-xs text-slate-600">
                        {timeText}
                    </span>
                </div>
                <span className="flex-shrink-0 text-xs font-medium text-slate-700">
                    {metricsText}
                </span>
            </div>
        </div>
    );

    if (!last_job_error_message) {
        return content;
    }

    return (
        <Tooltip content={last_job_error_message}>
            {content}
        </Tooltip>
    );
};
