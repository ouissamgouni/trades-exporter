---
applyTo: "frontend/**"
---

# Frontend rules

Reference: [frontend/src/pages/MyCalendar.tsx](frontend/src/pages/MyCalendar.tsx), [frontend/src/components/SignInNudge.tsx](frontend/src/components/SignInNudge.tsx).

## Don't
- Don't use `window.alert`, `window.confirm`, `window.prompt`, or rely on `console.*` for user-facing feedback (console is for developer debugging only — leaving existing logs is fine).
- Don't use rounded shapes on UI surfaces (see Shape below).
- Don't use red/rose for positive confirmations (RSVP success, saved, sign-in nudges).
- Don't introduce new top-level dependencies, UI libraries, or icon sets without asking.
- Don't add raw `fetch`/`axios` in components — use the existing client in [frontend/src/api.ts](frontend/src/api.ts).
- Don't use `any` or `@ts-ignore` without a one-line reason comment.
- Don't reformat unrelated lines or do drive-by refactors.

## Shape
- **Square corners by default.** No `rounded`, `rounded-md`, `rounded-lg`, `rounded-full` on buttons, pills, banners, inputs, toasts, popovers, tabs, sections, panels, notifications, modals. Also no `border-radius` in inline styles or CSS.
- Allowed exceptions: avatars (`rounded-full`), small status dots, genuinely circular icon toggles.

## Color
- **Primary** (Sign in, Save, Submit, Share, primary CTAs): `bg-blue-500 text-white hover:bg-blue-600`.
- **Secondary**: `border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`.
- **Active filter / selected pill**: `bg-blue-500 border-blue-500 text-white`.
- **Red is reserved**:
  - Destructive actions (delete account, irreversible removals): `bg-red-600 hover:bg-red-700`.
  - True error states / failed jobs: `bg-red-500` (status indicator, not a button).
- Inside a JSX block you're already editing, convert nearby `rose-*` CTAs → `blue-500`. Don't sweep unrelated files.

## Feedback & forms
- Confirmations: in-app inline UI (toast, inline banner, button state change). Toast/banner styling: neutral (`bg-slate-50 border-slate-200`) or blue (`bg-blue-50 border-blue-100`).
- Loading/disabled states must be visible (spinner or `disabled:opacity-50 cursor-not-allowed`).
- Forms: disable submit while in-flight; show field-level errors inline (not as a toast).

## Accessibility (basics, not exhaustive)
- Buttons need discernible text or `aria-label`. Inputs need labels. Color is not the only signal.
