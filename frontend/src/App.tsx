
import React, { Suspense } from 'react';
import { Box, Container, Heading, Tabs, Text, HStack, Badge, Center, Spinner } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TestModeBanner } from './components/TestModeBanner';

// Create a client with sensible defaults
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000, // Data considered fresh for 30 seconds
            refetchOnWindowFocus: false, // Don't refetch on tab focus
            retry: 1, // Only retry once on failure
        },
    },
});

// Lazy load all main tab components for better initial load performance
const UnifiedSetupView = React.lazy(() => import('./components/UnifiedSetupView'));
const SyncJobPanel = React.lazy(() => import('./components/SyncJobPanel').then(m => ({ default: m.SyncJobPanel })));
const ManualTransactionForm = React.lazy(() => import('./components/ManualTransactionForm').then(m => ({ default: m.ManualTransactionForm })));
const InboxView = React.lazy(() => import('./components/InboxView').then(m => ({ default: m.InboxView })));
const TransactionsTable = React.lazy(() => import('./components/TransactionsTable').then(m => ({ default: m.TransactionsTable })));
const PnLPanel = React.lazy(() => import('./components/PnLPanel').then(m => ({ default: m.PnLPanel })));
const PricesViewer = React.lazy(() => import('./components/PricesViewer').then(m => ({ default: m.PricesViewer })));

// Loading fallback component
const TabLoadingFallback = () => (
    <Center h="200px">
        <Spinner size="xl" color="blue.500" />
    </Center>
);

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <Box minH="100vh" bg="gray.50">
                <TestModeBanner />
            <Container maxW="6xl" py={8}>
                <Heading as="h1" size="xl" mb={4} textAlign="center" color="blue.700">
                    Trades Exporter
                </Heading>

                {/* Workflow indicator */}
                <HStack justify="center" mb={6} flexWrap="wrap" gap={2}>
                    <Badge colorScheme="gray" px={2} py={1}>1. Setup</Badge>
                    <Text color="gray.400">→</Text>
                    <Badge colorScheme="blue" px={2} py={1}>2. Sync/Add</Badge>
                    <Text color="gray.400">→</Text>
                    <Badge colorScheme="orange" px={2} py={1}>3. Review</Badge>
                    <Text color="gray.400">→</Text>
                    <Badge colorScheme="green" px={2} py={1}>4. P&L</Badge>
                </HStack>

                <Tabs.Root defaultValue="setup">
                    <Tabs.List>
                        {/* Step 1: Configuration */}
                        <Tabs.Trigger value="setup">⚙️ Setup</Tabs.Trigger>

                        {/* Step 2: Data Import */}
                        <Tabs.Trigger value="sync">🔄 Sync</Tabs.Trigger>
                        <Tabs.Trigger value="add-transaction">➕ Add</Tabs.Trigger>

                        {/* Step 3: Review */}
                        <Tabs.Trigger value="inbox">📥 Inbox</Tabs.Trigger>
                        <Tabs.Trigger value="all-transactions">📋 All</Tabs.Trigger>

                        {/* Step 4: Analysis */}
                        <Tabs.Trigger value="pnl">📊 P&L</Tabs.Trigger>

                        {/* Reference */}
                        <Tabs.Trigger value="prices">📈 Prices</Tabs.Trigger>
                    </Tabs.List>

                    {/* Step 1: Configuration */}
                    <Tabs.Content value="setup">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <UnifiedSetupView />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 2: Data Import */}
                    <Tabs.Content value="sync">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <SyncJobPanel />
                        </Suspense>
                    </Tabs.Content>
                    <Tabs.Content value="add-transaction">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <ManualTransactionForm />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 3: Review */}
                    <Tabs.Content value="inbox">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <InboxView />
                        </Suspense>
                    </Tabs.Content>
                    <Tabs.Content value="all-transactions">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <TransactionsTable />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 4: Analysis */}
                    <Tabs.Content value="pnl">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PnLPanel />
                        </Suspense>
                    </Tabs.Content>

                    {/* Reference */}
                    <Tabs.Content value="prices">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PricesViewer />
                        </Suspense>
                    </Tabs.Content>
                </Tabs.Root>
            </Container>
        </Box>
        </QueryClientProvider>
    );
};

export default App;