import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import type { ApprovalEntry } from '../approvals/approvals.service';
import {
  CreateManualJournalDto,
  JournalEntryListQueryDto,
} from './dto/accounting.dto';
import { JournalService, type JournalEntryWire } from './journal.service';

/**
 * /api/v1/journal-entries (Task 0.6, DESIGN.md §4.9 / E1 + §4.11).
 *
 *   GET  /journal-entries?from=&to=&source_type=&page=  'accounting.read'
 *   POST /journal-entries                               'accounting.post'
 *   POST /journal-entries/{approvalId}/post             'accounting.post'
 *
 * POST /journal-entries does NOT write the ledger: it validates the
 * proposed MANUAL entry (unbalanced payloads are rejected up front with
 * 422) and creates a PENDING MANUAL_JOURNAL approval carrying it — hence
 * 202 ACCEPTED with the approval, not 201 with an entry. After a manager
 * approves it (POST /approvals/{id}/approve, Task 0.5), any
 * 'accounting.post' holder posts it via /journal-entries/{approvalId}/post,
 * which is when JournalService.post() writes entry + lines atomically.
 * Non-approved proposals can never be posted (409).
 */
@Controller('journal-entries')
@UseGuards(AuthGuard, PermissionsGuard)
export class JournalEntriesController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  @RequirePermissions('accounting.read')
  list(
    @Query() query: JournalEntryListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<JournalEntryWire>> {
    return this.journal.list(query, user);
  }

  /** Propose a MANUAL journal → PENDING MANUAL_JOURNAL approval (202). */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('accounting.post')
  propose(
    @Body() dto: CreateManualJournalDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ApprovalEntry> {
    return this.journal.proposeManual(dto, user);
  }

  /** Post an APPROVED manual-journal approval to the ledger (201). */
  @Post(':approvalId/post')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('accounting.post')
  postApproved(
    @Param('approvalId', ParseUUIDPipe) approvalId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JournalEntryWire> {
    return this.journal.postApproved(approvalId, user);
  }
}
