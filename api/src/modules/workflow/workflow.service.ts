import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type WorkflowState,
  type WorkflowTransition,
} from '@prisma/client';
import {
  roleHasPermission,
  type PaginatedResponse,
  type Permission,
} from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateWorkflowStateDto,
  CreateWorkflowTransitionDto,
  WorkflowStateListQueryDto,
  WorkflowTransitionListQueryDto,
} from './dto/workflow.dto';
import { WORKFLOW_GUARDS, type WorkflowGuardContext } from './guards/registry';

/** Wire shape of one workflow state (snake_case per API convention). */
export interface WorkflowStateWire {
  id: string;
  code: string;
  label: string;
  is_initial: boolean;
  is_terminal: boolean;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Wire shape of one transition edge — states referenced by code. */
export interface WorkflowTransitionWire {
  id: string;
  from_code: string;
  to_code: string;
  required_permission: string | null;
  requires_approval: boolean;
  guard_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * GET /workflow/graph — everything the web app needs to render the Kanban
 * board: ordered columns (`states`) + legal moves (`transitions`).
 */
export interface WorkflowGraphWire {
  states: WorkflowStateWire[];
  transitions: WorkflowTransitionWire[];
}

/** Result of {@link WorkflowService.canTransition}. */
export interface TransitionCheck {
  allowed: boolean;
  /** Human-readable denial reason; absent when allowed. */
  reason?: string;
  /** The matched edge (present whenever the edge exists), so callers
   *  (Task 1.3) can route `requires_approval` through §4.11 approvals. */
  transition?: WorkflowTransitionWire;
}

const DEFAULT_PAGE_SIZE = 50;

type TransitionWithStates = WorkflowTransition & {
  fromState: WorkflowState;
  toState: WorkflowState;
};

/**
 * The configurable workflow engine (Task 1.2, DESIGN.md §4.10/§5/E7).
 *
 * Job statuses (`workflow_states`) and their legal moves
 * (`workflow_transitions`) are company-level DATA — the §5 lifecycle is just
 * the seeded default. Task 1.3's POST /jobs/{id}/transition validates every
 * move through {@link assertTransition}.
 *
 * A transition is allowed iff, in order:
 *   1. both state codes exist (not soft-deleted) for the company and are
 *      active;
 *   2. an edge from→to exists (otherwise ILLEGAL);
 *   3. the acting user's role holds the edge's `required_permission`, if
 *      any (otherwise UNAUTHORIZED);
 *   4. the edge's `guard_code` (if any) resolves in the guard registry and
 *      its predicate passes — unknown guard codes fail CLOSED.
 *
 * `requires_approval` is NOT evaluated here — it is surfaced on the returned
 * edge for the job lifecycle (Task 1.3) to route through approvals (§4.11).
 */
@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------- queries

  /** GET /workflow/states — paginated; `q` matches code/label. */
  async listStates(
    query: WorkflowStateListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<WorkflowStateWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    // companyId set explicitly AND re-tightened by the scope extension.
    const where: Prisma.WorkflowStateWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q } },
              { label: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.workflowState.count({ where }),
      this.prisma.workflowState.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(stateToWire), page, page_size: pageSize, total };
  }

  /** GET /workflow/transitions — paginated; `q` matches either state code. */
  async listTransitions(
    query: WorkflowTransitionListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<WorkflowTransitionWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.WorkflowTransitionWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.q
        ? {
            OR: [
              { fromState: { code: { contains: query.q } } },
              { toState: { code: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.workflowTransition.count({ where }),
      this.prisma.workflowTransition.findMany({
        where,
        include: { fromState: true, toState: true },
        orderBy: [
          { fromState: { sortOrder: 'asc' } },
          { toState: { sortOrder: 'asc' } },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      data: rows.map(transitionToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  /**
   * GET /workflow/graph — the whole board in one call: states ordered by
   * sort_order (Kanban columns) + every edge (legal moves). Soft-deleted
   * rows excluded; inactive states are INCLUDED (flagged `active:false`) so
   * admins can render/repair them — the engine refuses to move through them.
   */
  async graph(user: AuthUser): Promise<WorkflowGraphWire> {
    const [states, transitions] = await Promise.all([
      this.prisma.workflowState.findMany({
        where: { companyId: user.companyId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.workflowTransition.findMany({
        where: { companyId: user.companyId, deletedAt: null },
        include: { fromState: true, toState: true },
        orderBy: [
          { fromState: { sortOrder: 'asc' } },
          { toState: { sortOrder: 'asc' } },
        ],
      }),
    ]);

    return {
      states: states.map(stateToWire),
      transitions: transitions.map(transitionToWire),
    };
  }

  // ------------------------------------------------------------ mutations

  /** POST /workflow/states (admin, 'config.manage'). */
  async createState(
    dto: CreateWorkflowStateDto,
    user: AuthUser,
  ): Promise<WorkflowStateWire> {
    // A workflow can only have ONE initial column — new jobs must land
    // somewhere unambiguous (Task 1.3).
    if (dto.is_initial) {
      const existingInitial = await this.prisma.workflowState.findFirst({
        where: {
          companyId: user.companyId,
          isInitial: true,
          deletedAt: null,
        },
      });
      if (existingInitial) {
        throw new ConflictException(
          `An initial state already exists ('${existingInitial.code}') — a workflow has exactly one initial state`,
        );
      }
    }

    try {
      const state = await this.prisma.workflowState.create({
        data: {
          companyId: user.companyId, // also force-injected by the extension
          code: dto.code,
          label: dto.label,
          isInitial: dto.is_initial ?? false,
          isTerminal: dto.is_terminal ?? false,
          sortOrder: dto.sort_order ?? 0,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return stateToWire(state);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A workflow state with this code already exists for this company',
        );
      }
      throw e;
    }
  }

  /** POST /workflow/transitions (admin, 'config.manage'). */
  async createTransition(
    dto: CreateWorkflowTransitionDto,
    user: AuthUser,
  ): Promise<WorkflowTransitionWire> {
    const [fromState, toState] = await Promise.all([
      this.findState(user.companyId, dto.from_code),
      this.findState(user.companyId, dto.to_code),
    ]);
    if (!fromState) {
      throw new UnprocessableEntityException(
        `Unknown from_code '${dto.from_code}' — create the state first`,
      );
    }
    if (!toState) {
      throw new UnprocessableEntityException(
        `Unknown to_code '${dto.to_code}' — create the state first`,
      );
    }
    if (fromState.id === toState.id) {
      throw new UnprocessableEntityException(
        'A transition cannot loop a state onto itself',
      );
    }
    // Unknown guard codes would fail CLOSED at runtime — reject the typo at
    // config time instead. Guards ship in code (guards/registry.ts).
    if (dto.guard_code && !(dto.guard_code in WORKFLOW_GUARDS)) {
      throw new UnprocessableEntityException(
        `Unknown guard_code '${dto.guard_code}' — it must be registered in the workflow guard registry`,
      );
    }

    try {
      const transition = await this.prisma.workflowTransition.create({
        data: {
          companyId: user.companyId,
          fromStateId: fromState.id,
          toStateId: toState.id,
          requiredPermission: dto.required_permission ?? null,
          requiresApproval: dto.requires_approval ?? false,
          guardCode: dto.guard_code ?? null,
          createdById: user.userId,
          updatedById: user.userId,
        },
        include: { fromState: true, toState: true },
      });
      return transitionToWire(transition);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A transition ${dto.from_code} → ${dto.to_code} already exists for this company`,
        );
      }
      throw e;
    }
  }

  // --------------------------------------------------------------- engine

  /**
   * May `user` move a job of `companyId` from `fromStateCode` to
   * `toStateCode`? Never throws — returns `{ allowed, reason?, transition? }`
   * (see class doc for the rule order). `guardContext` carries whatever the
   * edge's guard needs (the job row from Task 1.3 onwards).
   */
  async canTransition(
    companyId: string,
    fromStateCode: string,
    toStateCode: string,
    user: AuthUser,
    guardContext?: Partial<WorkflowGuardContext>,
  ): Promise<TransitionCheck> {
    const [fromState, toState] = await Promise.all([
      this.findState(companyId, fromStateCode),
      this.findState(companyId, toStateCode),
    ]);

    if (!fromState) {
      return {
        allowed: false,
        reason: `Unknown workflow state '${fromStateCode}'`,
      };
    }
    if (!toState) {
      return {
        allowed: false,
        reason: `Unknown workflow state '${toStateCode}'`,
      };
    }
    if (!fromState.active) {
      return {
        allowed: false,
        reason: `Workflow state '${fromState.code}' is inactive`,
      };
    }
    if (!toState.active) {
      return {
        allowed: false,
        reason: `Workflow state '${toState.code}' is inactive`,
      };
    }

    const transition = await this.prisma.workflowTransition.findFirst({
      where: {
        companyId,
        fromStateId: fromState.id,
        toStateId: toState.id,
        deletedAt: null,
      },
      include: { fromState: true, toState: true },
    });
    if (!transition) {
      return {
        allowed: false,
        reason: `Illegal transition: ${fromState.code} → ${toState.code} is not an allowed move`,
      };
    }

    const wire = transitionToWire(transition);

    if (
      transition.requiredPermission &&
      !roleHasPermission(user.role, transition.requiredPermission as Permission)
    ) {
      return {
        allowed: false,
        reason: `Not authorized: ${fromState.code} → ${toState.code} requires permission '${transition.requiredPermission}'`,
        transition: wire,
      };
    }

    if (transition.guardCode) {
      const guard = WORKFLOW_GUARDS[transition.guardCode];
      if (!guard) {
        // Fail CLOSED: an edge naming an unregistered guard never opens.
        return {
          allowed: false,
          reason: `Transition guard '${transition.guardCode}' is not registered — transition blocked`,
          transition: wire,
        };
      }
      const ctx: WorkflowGuardContext = { companyId, user, ...guardContext };
      if (!guard(ctx)) {
        return {
          allowed: false,
          reason: `Transition condition '${transition.guardCode}' not satisfied for ${fromState.code} → ${toState.code}`,
          transition: wire,
        };
      }
    }

    return { allowed: true, transition: wire };
  }

  /**
   * Like {@link canTransition} but throws 422 UNPROCESSABLE_ENTITY (via the
   * global filter: `{ error: { code: 'UNPROCESSABLE_ENTITY', message } }`)
   * when the move is illegal/unauthorized/guarded. Returns the successful
   * check so callers can read `transition.requires_approval`.
   */
  async assertTransition(
    companyId: string,
    fromStateCode: string,
    toStateCode: string,
    user: AuthUser,
    guardContext?: Partial<WorkflowGuardContext>,
  ): Promise<TransitionCheck> {
    const check = await this.canTransition(
      companyId,
      fromStateCode,
      toStateCode,
      user,
      guardContext,
    );
    if (!check.allowed) {
      throw new UnprocessableEntityException(check.reason);
    }
    return check;
  }

  // -------------------------------------------------------------- helpers

  private findState(
    companyId: string,
    code: string,
  ): Promise<WorkflowState | null> {
    return this.prisma.workflowState.findFirst({
      where: { companyId, code, deletedAt: null },
    });
  }
}

function stateToWire(s: WorkflowState): WorkflowStateWire {
  return {
    id: s.id,
    code: s.code,
    label: s.label,
    is_initial: s.isInitial,
    is_terminal: s.isTerminal,
    sort_order: s.sortOrder,
    active: s.active,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

function transitionToWire(t: TransitionWithStates): WorkflowTransitionWire {
  return {
    id: t.id,
    from_code: t.fromState.code,
    to_code: t.toState.code,
    required_permission: t.requiredPermission,
    requires_approval: t.requiresApproval,
    guard_code: t.guardCode,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}
