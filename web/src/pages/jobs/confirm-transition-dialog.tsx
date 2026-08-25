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
  /**
   * Set instead of a normal move when the user is asking for an override on
   * a GUARD-blocked edge (§4.11) rather than confirming a legal one — the
   * dialog switches to collecting a REQUIRED reason and the caller sends
   * request_override/override_reason instead of applying the move directly.
   */
  overrideReason?: string
}

/**
 * Confirmation gate for a job state move. A single click (a detail-page
 * "Next" button) or a drag-drop on the board is easy to trigger by accident,
 * and most moves cannot be walked back — so we make the user acknowledge the
 * exact from → to change (and optionally note WHY) before it is applied.
 *
 * Doubles as the override-request dialog (`move.overrideReason !== undefined`):
 * same from/to framing, but the note becomes a required justification that is
 * raised as a PENDING approval rather than applied immediately.
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
  const isOverride = move?.overrideReason !== undefined
  const [note, setNote] = useState('')
  // Clear the note whenever the dialog closes / a new move opens it.
  useEffect(() => {
    if (!move) setNote('')
  }, [move])

  const canConfirm = isOverride ? note.trim().length >= 5 : true

  return (
    <Dialog open={move !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isOverride ? 'Request an override?' : 'Move this job?'}
          </DialogTitle>
          <DialogDescription>
            {move && isOverride && (
              <>
                This asks a manager to approve moving the job from{' '}
                <strong>{move.fromLabel}</strong> to{' '}
                <strong>{move.toLabel}</strong> despite the guard currently
                holding it. Nothing changes yet — once approved, come back
                here and apply it.
              </>
            )}
            {move && !isOverride && (
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
        <FormField
          label={isOverride ? 'Reason for the override (required)' : 'Note (optional)'}
          htmlFor="transition-note"
        >
          <Textarea
            id="transition-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              isOverride
                ? 'Why should this move be allowed despite the hold…'
                : 'Add context for the history…'
            }
          />
        </FormField>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={isPending || !canConfirm}
            onClick={() => onConfirm(note)}
          >
            {isPending
              ? 'Saving…'
              : isOverride
                ? 'Request approval'
                : move?.requiresApproval
                  ? 'Request approval'
                  : `Move to ${move?.toLabel ?? 'next stage'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
