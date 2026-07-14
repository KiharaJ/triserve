import { ArrayUnique, IsArray, IsIn, IsString } from 'class-validator';
import { ALL_PERMISSIONS, type Permission } from '@triserve/shared';

/**
 * PUT /roles/{role}/permissions — the DESIRED effective grant set for the
 * role. The service diffs this against the static defaults and persists only
 * the delta. Every entry must be a known permission string.
 */
export class UpdateRolePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsIn(ALL_PERMISSIONS as readonly string[], {
    each: true,
    message: 'Unknown permission',
  })
  permissions!: Permission[];
}
