/**
 * Drag handles that resize editor panels. A handle reports pointer deltas;
 * {@link usePanelSize} owns one clamped size and persists it in localStorage
 * so the layout survives reloads. Double-clicking a handle restores the default.
 *
 * @module @dsh-plugins/flow-ui/client/editor/Resizer
 */

import { useCallback, useState, type PointerEvent, type ReactNode } from 'react'

/**
 * A persisted, clamped panel size in pixels.
 * @param key - localStorage key.
 * @param fallback - default size.
 * @param min - minimum size.
 * @param max - maximum size.
 * @returns the size, a delta-based resize, and a reset.
 */
export function usePanelSize(key: string, fallback: number, min: number, max: number): { size: number; resize(delta: number): void; reset(): void } {
  const clamp = (value: number): number => Math.min(max, Math.max(min, value))
  const [size, setSize] = useState(() => {
    const stored = Number(localStorage.getItem(key))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : fallback
  })
  const resize = useCallback((delta: number): void => {
    setSize((current) => {
      const next = clamp(current + delta)
      localStorage.setItem(key, String(next))
      return next
    })
  }, [key, min, max])
  const reset = useCallback((): void => {
    localStorage.removeItem(key)
    setSize(fallback)
  }, [key, fallback])
  return { size, resize, reset }
}

/**
 * A drag handle between panels.
 * @param props - `axis` is the resize direction; `sign` flips the delta for panels that grow toward the pointer's origin (a right or bottom panel).
 * @returns the handle.
 */
export function Resizer({ axis, sign, onResize, onReset, label }: { axis: 'x' | 'y'; sign: 1 | -1; onResize(delta: number): void; onReset(): void; label: string }): ReactNode {
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    let last = axis === 'x' ? event.clientX : event.clientY
    const move = (moveEvent: globalThis.PointerEvent): void => {
      const position = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      onResize((position - last) * sign)
      last = position
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      document.body.classList.remove('dsflow-resizing')
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
    document.body.classList.add('dsflow-resizing')
  }
  return (
    <div
      className={`dsflow-resizer dsflow-resizer--${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  )
}
