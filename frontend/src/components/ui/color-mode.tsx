"use client"

import type { ThemeProviderProps } from "next-themes"
import { ThemeProvider, useTheme } from "next-themes"
import * as React from "react"
import { LuMoon, LuSun } from "react-icons/lu"
import { cn } from "../../lib/cn"

export interface ColorModeProviderProps extends ThemeProviderProps { }

export function ColorModeProvider(props: ColorModeProviderProps) {
  return (
    <ThemeProvider attribute="class" disableTransitionOnChange {...props} />
  )
}

export type ColorMode = "light" | "dark"

export interface UseColorModeReturn {
  colorMode: ColorMode
  setColorMode: (colorMode: ColorMode) => void
  toggleColorMode: () => void
}

export function useColorMode(): UseColorModeReturn {
  const { resolvedTheme, setTheme, forcedTheme } = useTheme()
  const colorMode = forcedTheme || resolvedTheme
  const toggleColorMode = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark")
  }
  return {
    colorMode: colorMode as ColorMode,
    setColorMode: setTheme,
    toggleColorMode,
  }
}

export function useColorModeValue<T>(light: T, dark: T) {
  const { colorMode } = useColorMode()
  return colorMode === "dark" ? dark : light
}

export function ColorModeIcon() {
  const { colorMode } = useColorMode()
  return colorMode === "dark" ? <LuMoon /> : <LuSun />
}

interface ColorModeButtonProps extends Omit<React.ComponentPropsWithoutRef<"button">, "aria-label"> { }

export const ColorModeButton = React.forwardRef<
  HTMLButtonElement,
  ColorModeButtonProps
>(function ColorModeButton({ className, ...props }, ref) {
  const { toggleColorMode } = useColorMode()
  return (
    <button
      type="button"
      onClick={toggleColorMode}
      aria-label="Toggle color mode"
      ref={ref}
      // Circular icon toggle is an allowed exception to square-corners.
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
        className,
      )}
      {...props}
    >
      <ColorModeIcon />
    </button>
  )
})

export const LightMode = React.forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<"span">>(
  function LightMode({ className, ...props }, ref) {
    return (
      <span
        className={cn("contents", "chakra-theme light", className)}
        ref={ref}
        {...props}
      />
    )
  },
)

export const DarkMode = React.forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<"span">>(
  function DarkMode({ className, ...props }, ref) {
    return (
      <span
        className={cn("contents", "chakra-theme dark", className)}
        ref={ref}
        {...props}
      />
    )
  },
)
