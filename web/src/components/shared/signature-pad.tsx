import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '@/lib/utils'

export interface SignaturePadHandle {
  clear(): void
  isEmpty(): boolean
  /** `data:image/png;base64,...` — matches POST /attachments/signature. */
  toDataUrl(): string
}

/**
 * Hand-rolled canvas signature capture (Task 1.5, DESIGN.md §4.12 E4) — no
 * extra dependency, just pointer events drawing onto a white-backed canvas.
 * Parent reads the PNG data-URI via the ref at submit time.
 */
export const SignaturePad = forwardRef<
  SignaturePadHandle,
  { className?: string; width?: number; height?: number; onChange?: (hasInk: boolean) => void }
>(function SignaturePad({ className, width = 480, height = 160, onChange }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const hasInk = useRef(false)

  const paintBlank = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
  }

  useEffect(() => {
    paintBlank()
  }, [])

  function pointFromEvent(e: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = e.currentTarget.width / rect.width
    const scaleY = e.currentTarget.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  useImperativeHandle(ref, () => ({
    clear() {
      paintBlank()
      hasInk.current = false
      onChange?.(false)
    },
    isEmpty() {
      return !hasInk.current
    },
    toDataUrl() {
      return canvasRef.current?.toDataURL('image/png') ?? ''
    },
  }))

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      role="img"
      aria-label="Signature capture pad"
      className={cn('touch-none rounded-md border bg-white', className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drawing.current = true
        if (!hasInk.current) {
          hasInk.current = true
          onChange?.(true)
        }
        const ctx = e.currentTarget.getContext('2d')
        const { x, y } = pointFromEvent(e)
        ctx?.beginPath()
        ctx?.moveTo(x, y)
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return
        const ctx = e.currentTarget.getContext('2d')
        const { x, y } = pointFromEvent(e)
        ctx?.lineTo(x, y)
        ctx?.stroke()
      }}
      onPointerUp={() => {
        drawing.current = false
      }}
      onPointerLeave={() => {
        drawing.current = false
      }}
    />
  )
})
