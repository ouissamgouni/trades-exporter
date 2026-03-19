import { Box, Badge, HStack, Text, VStack } from "@chakra-ui/react";
import { Tooltip } from "@chakra-ui/react/tooltip";
import { LuClock, LuCheck, LuX, LuInfo } from "react-icons/lu";
import { EnabledConnector } from "../types";

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
            <Box
                px={3}
                py={2}
                bg="gray.50"
                borderRadius="md"
                fontSize="sm"
                color="gray.500"
            >
                No sync history
            </Box>
        );
    }

    // Status badge configuration
    const statusConfig = {
        completed: { color: "green", icon: LuCheck, label: "Completed" },
        failed: { color: "red", icon: LuX, label: "Failed" },
        running: { color: "blue", icon: LuClock, label: "Running" },
        queued: { color: "gray", icon: LuClock, label: "Queued" },
        skipped: { color: "orange", icon: LuInfo, label: "Skipped" },
        aborted: { color: "orange", icon: LuInfo, label: "Aborted" },
    };

    const config = statusConfig[last_job_status as keyof typeof statusConfig] || statusConfig.completed;
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

    return (
        <Tooltip.Root disabled={!last_job_error_message}>
            <Tooltip.Trigger asChild>
                <Box
                    px={3}
                    py={2}
                    bg={last_job_status === "failed" ? "red.50" : "gray.50"}
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor={last_job_status === "failed" ? "red.200" : "gray.200"}
                    cursor={onClick ? "pointer" : "default"}
                    _hover={onClick ? { bg: last_job_status === "failed" ? "red.100" : "gray.100", borderColor: config.color + ".300" } : undefined}
                    onClick={onClick}
                    transition="all 0.2s"
                >
                    <HStack justify="space-between" gap={2}>
                        <HStack gap={2} flex={1} minW={0}>
                            <Badge colorScheme={config.color} display="flex" alignItems="center" gap={1}>
                                <StatusIcon size={12} />
                                {config.label}
                            </Badge>
                            <Text fontSize="xs" color="gray.600" truncate>
                                {timeText}
                            </Text>
                        </HStack>
                        <Text fontSize="xs" color="gray.700" fontWeight="medium" flexShrink={0}>
                            {metricsText}
                        </Text>
                    </HStack>
                </Box>
            </Tooltip.Trigger>
            <Tooltip.Positioner>
                <Tooltip.Content>
                    {last_job_error_message || "Click to view full job details"}
                </Tooltip.Content>
            </Tooltip.Positioner>
        </Tooltip.Root>
    );
};
