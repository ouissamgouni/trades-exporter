import React, { useLayoutEffect, useRef } from 'react';

/**
 * Scroll container exposing `--thead-h` (sticky offset for group headers) and `--scroll-w`
 * (visible width, so full-width header content stays on screen while scrolling horizontally).
 */
export const StickyScrollContainer: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => {
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const update = () => {
            el.style.setProperty('--thead-h', `${el.querySelector('thead')?.offsetHeight ?? 0}px`);
            el.style.setProperty('--scroll-w', `${el.clientWidth}px`);
        };
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(update);
        observer.observe(el);
        const thead = el.querySelector('thead');
        if (thead) observer.observe(thead);
        return () => observer.disconnect();
    }, []);

    return <div ref={ref} className={className}>{children}</div>;
};
