import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CsatService, type PublicCsatWire } from './csat.service';
import { SubmitCsatDto } from './dto/logistics.dto';

/**
 * /api/v1/public/csat/{token} — the customer-facing satisfaction survey
 * (SCMS proposal Module 6, §7 step 5).
 *
 * DELIBERATELY UNAUTHENTICATED. The recipient is a member of the public who
 * has no account and never will; requiring a login to answer "how did we do?"
 * would collect no data at all.
 *
 * What makes that safe:
 *   - the 32-byte CSPRNG token IS the credential, and it grants access to
 *     exactly ONE survey row — not an account, not a job, not a customer;
 *   - the token expires (30 days);
 *   - the response exposes only what the page must render: company, branch,
 *     job number and device description. No phone number, no address, no
 *     pricing, no repair detail;
 *   - a bad or expired token returns the SAME message as an unknown one, so
 *     probing cannot distinguish "wrong guess" from "expired real link".
 *
 * Note the absence of AuthGuard/PermissionsGuard on this controller, and that
 * it is the ONLY controller in the system without them. There is no request
 * context, so the Prisma company-scope extension applies no tenant filter
 * here — which is why CsatService.loadByToken is written to be safe on its
 * own, resolving strictly by the unguessable token.
 */
@Controller('public/csat')
export class PublicCsatController {
  constructor(private readonly csat: CsatService) {}

  @Get(':token')
  view(@Param('token') token: string): Promise<PublicCsatWire> {
    return this.csat.publicView(token);
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  submit(
    @Param('token') token: string,
    @Body() dto: SubmitCsatDto,
  ): Promise<PublicCsatWire> {
    return this.csat.submit(token, dto.score, dto.comment);
  }
}
