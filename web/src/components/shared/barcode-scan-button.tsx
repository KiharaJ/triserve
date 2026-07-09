import { BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import { ScanLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * IMEI/barcode scan affordance (Task 1.5, DESIGN.md §8 "IMEI/barcode
 * scanning at intake"). Opens the device camera via @zxing/browser and
 * decodes continuously; the first hit fills the field and closes the
 * dialog. Manual typing in the surrounding form field ALWAYS works — this
 * button is a pure convenience layered on top, never a hard requirement
 * (no camera / permission denied just leaves manual entry as the path).
 */
export function BarcodeScanButton({
  onDetected,
  label = 'Scan',
}: {
  onDetected: (text: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    let cancelled = false
    const reader = new BrowserMultiFormatReader()

    reader
      .decodeFromVideoDevice(undefined, videoRef.current ?? undefined, (result, _err, controls) => {
        controlsRef.current = controls
        if (result && !cancelled) {
          cancelled = true
          onDetected(result.getText())
          controls.stop()
          setOpen(false)
        }
      })
      .catch((e: unknown) => {
        setError(
          e instanceof Error
            ? e.message
            : 'Camera unavailable — close this and type the IMEI manually',
        )
      })

    return () => {
      cancelled = true
      controlsRef.current?.stop()
      controlsRef.current = null
    }
  }, [open, onDetected])

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ScanLine /> {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scan IMEI / barcode</DialogTitle>
            <DialogDescription>
              Point the camera at the IMEI label or barcode. No camera
              available? Close this and type it in manually.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <video ref={videoRef} className="w-full rounded-md border" muted />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
