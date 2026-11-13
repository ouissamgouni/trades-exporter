"use client"

import * as RadixToast from "@radix-ui/react-toast"
import * as React from "react"
import { FiAlertCircle, FiAlertTriangle, FiCheckCircle, FiInfo, FiX } from "react-icons/fi"
import { cn } from "../../lib/cn"
import { Spinner } from "./primitives"

export type ToastType = "success" | "error" | "info" | "warning" | "loading"

export interface ToastOptions {
  id?: string
  title?: React.ReactNode
  description?: React.ReactNode
  type?: ToastType
  duration?: number
}

interface ToastRecord extends ToastOptions {
  id: string
  duration: number
}

type Listener = () => void

const PERSISTENT = 1_000_000

const store = (() => {
  let toasts: ToastRecord[] = []
  const listeners = new Set<Listener>()
  let counter = 0
  const emit = () => listeners.forEach((l) => l())

  const create = (opts: ToastOptions) => {
    const id = opts.id ?? `toast-${++counter}`
    const record: ToastRecord = {
      type: "info",
      duration: opts.type === "loading" ? PERSISTENT : 5000,
      ...opts,
      id,
    }
    toasts = [...toasts.filter((t) => t.id !== id), record]
    emit()
    return id
  }

  const dismiss = (id?: string) => {
    toasts = id ? toasts.filter((t) => t.id !== id) : []
    emit()
  }

  return {
    create,
    dismiss,
    subscribe: (l: Listener) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSnapshot: () => toasts,
  }
})()

export const toaster = {
  create: (o: ToastOptions) => store.create(o),
  success: (o: ToastOptions) => store.create({ ...o, type: "success" }),
  error: (o: ToastOptions) => store.create({ ...o, type: "error" }),
  info: (o: ToastOptions) => store.create({ ...o, type: "info" }),
  warning: (o: ToastOptions) => store.create({ ...o, type: "warning" }),
  loading: (o: ToastOptions) => store.create({ ...o, type: "loading" }),
  dismiss: (id?: string) => store.dismiss(id),
}

// Left accent color per toast type. Square corners by design system.
const ACCENT: Record<ToastType, string> = {
  success: "border-l-4 border-l-green-500",
  error: "border-l-4 border-l-red-500",
  warning: "border-l-4 border-l-amber-500",
  info: "border-l-4 border-l-blue-500",
  loading: "border-l-4 border-l-slate-400",
}

function ToastIcon({ type }: { type: ToastType }) {
  switch (type) {
    case "success":
      return <FiCheckCircle className="mt-0.5 shrink-0 text-green-500" size={16} />
    case "error":
      return <FiAlertCircle className="mt-0.5 shrink-0 text-red-500" size={16} />
    case "warning":
      return <FiAlertTriangle className="mt-0.5 shrink-0 text-amber-500" size={16} />
    case "loading":
      return <Spinner size="sm" className="mt-0.5 shrink-0 text-slate-400" />
    default:
      return <FiInfo className="mt-0.5 shrink-0 text-blue-500" size={16} />
  }
}

export const Toaster = () => {
  const toasts = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  return (
    <RadixToast.Provider swipeDirection="right" duration={5000}>
      {toasts.map((toast) => (
        <RadixToast.Root
          key={toast.id}
          duration={toast.duration}
          open
          onOpenChange={(open) => {
            if (!open) toaster.dismiss(toast.id)
          }}
          className={cn(
            "flex items-start gap-2 border border-slate-200 bg-white px-4 py-3 shadow-md",
            "dark:border-slate-700 dark:bg-slate-900",
            ACCENT[toast.type ?? "info"],
            "data-[state=closed]:opacity-0",
          )}
        >
          <ToastIcon type={toast.type ?? "info"} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {toast.title && (
              <RadixToast.Title className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {toast.title}
              </RadixToast.Title>
            )}
            {toast.description && (
              <RadixToast.Description className="text-sm text-slate-600 dark:text-slate-300">
                {toast.description}
              </RadixToast.Description>
            )}
          </div>
          <RadixToast.Close
            aria-label="Dismiss"
            className="shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <FiX size={14} />
          </RadixToast.Close>
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport className="fixed right-4 top-4 z-[2700] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
    </RadixToast.Provider>
  )
}
