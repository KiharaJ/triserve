import { useEffect, useState } from 'react'
import { FormField } from '@/components/shared/form-field'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

/** A transition awaiting the user's confirmation. */
export interface PendingMove {
  jobId: string
  toStateCode: string
  fromLabel: string
  toLabel: string
  requiresApproval?: boolean
}

/**
 * Confirmation gate for a job state move. A single click (a detail-page
 * "Next" button) or a drag-drop on the board is easy to trigger by accident,
 * and most moves cannot be walked back — so we make the user acknowledge the
 * exact from → to change (and optionally note WHY) before it is applied.
 */
export function ConfirmTransitionDialog({
  move,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  move: PendingMove | null
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (note: string) => void
}) {
  const [note, setNote] = useState('')
  // Clear the note whenever the dialog closes / a new move opens it.
  useEffect(() => {
    if (!move) setNote('')
  }, [move])

  return (
    <Dialog open={move !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move this job?</DialogTitle>
          <DialogDescription>
            {move && (
              <>
                This changes the job from <strong>{move.fromLabel}</strong> to{' '}
                <strong>{move.toLabel}</strong>. It is recorded in the job
                history
                {move.requiresApproval
                  ? ' and needs manager approval before it takes effect'
                  : ''}
                . Check the stage before confirming.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <FormField label="Note (optional)" htmlFor="transition-note">
          <Textarea
            id="transition-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add context for the history…"
          />
        </FormField>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isPending} onClick={() => onConfirm(note)}>
            {isPending
              ? 'Moving…'
              : move?.requiresApproval
                ? 'Request approval'
                : `Move to ${move?.toLabel ?? 'next stage'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
