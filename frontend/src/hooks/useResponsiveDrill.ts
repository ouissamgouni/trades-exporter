/**
 * useResponsiveDrill
 *
 * Hook that determines the optimal drill-down layout based on viewport width.
 * Returns layout mode ('sidebar' | 'stacked' | 'sheet') and responsive helpers.
 *
 * Breakpoints align with Chakra UI defaults:
 *  - >= 1024px (lg): sidebar layout — detail view in side panel
 *  - >= 640px (sm): stacked layout — full-width detail replaces table
 *  - < 640px: bottom sheet — detail slides up from bottom
 */

import { useState, useEffect, useCallback } from 'react';

export type DrillLayout = 'sidebar' | 'stacked' | 'sheet';

interface UseResponsiveDrillReturn {
    /** Current layout mode */
    layout: DrillLayout;
    /** Whether the sidebar/sheet is open (controlled by drill context) */
    isOpen: boolean;
    /** Open the detail panel */
    open: () => void;
    /** Close the detail panel */
    close: () => void;
    /** Toggle the detail panel */
    toggle: () => void;
    /** Sidebar width for CSS (only relevant in 'sidebar' mode) */
    sidebarWidth: string;
}

const LG_BREAKPOINT = 1024;
const SM_BREAKPOINT = 640;

function getLayout(width: number): DrillLayout {
    if (width >= LG_BREAKPOINT) return 'sidebar';
    if (width >= SM_BREAKPOINT) return 'stacked';
    return 'sheet';
}

export function useResponsiveDrill(): UseResponsiveDrillReturn {
    const [layout, setLayout] = useState<DrillLayout>(() =>
        typeof window !== 'undefined' ? getLayout(window.innerWidth) : 'stacked'
    );
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        const handleResize = () => {
            setLayout(getLayout(window.innerWidth));
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const open = useCallback(() => setIsOpen(true), []);
    const close = useCallback(() => setIsOpen(false), []);
    const toggle = useCallback(() => setIsOpen(prev => !prev), []);

    return {
        layout,
        isOpen,
        open,
        close,
        toggle,
        sidebarWidth: layout === 'sidebar' ? '420px' : '100%',
    };
}
