import { z } from 'zod';
import { EDITABLE_FIELD_PATHS, PRIVACY, SCENARIO_TYPES } from '@cf/shared';
import { PaginationQuery } from '../../common/http/pagination';
import { IMPORT_MAX_BYTES } from './scenario-io';

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const ListScenariosQuery = PaginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  type: z.enum(SCENARIO_TYPES).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  privacy: z.enum(PRIVACY).optional(),
  tag: z.string().trim().max(40).optional(),
  isTemplate: bool.optional(),
  includeArchived: bool.optional(),
  sort: z.enum(['updated', 'created', 'name']).default('updated'),
});
export type ListScenariosQuery = z.infer<typeof ListScenariosQuery>;

const ImportText = z.string().min(1).max(IMPORT_MAX_BYTES + 1024);
const Format = z.enum(['yaml', 'json', 'auto']).default('auto');
const OptName = z.string().trim().min(1).max(120).optional();

export const CreateScenarioBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('blank'), name: z.string().trim().min(1).max(120), type: z.enum(SCENARIO_TYPES).optional() }),
  z.object({ source: z.literal('template'), templateKey: z.string().min(1).max(80), name: OptName }),
  z.object({ source: z.literal('import'), text: ImportText, format: Format, name: OptName }),
  z.object({ source: z.literal('duplicate'), scenarioId: z.string().min(1).max(64), versionId: z.string().min(1).max(64).optional(), name: OptName }),
]);
export type CreateScenarioBody = z.infer<typeof CreateScenarioBody>;

export const LockedFields = z
  .array(z.enum(EDITABLE_FIELD_PATHS))
  .max(EDITABLE_FIELD_PATHS.length)
  .transform((a) => Array.from(new Set(a)));

export const UpdateDraftBody = z
  .object({
    revision: z.number().int().min(0),
    config: z.record(z.unknown()).optional(),
    patch: z
      .array(z.object({ path: z.string().min(1).max(200), value: z.unknown() }))
      .max(100)
      .optional(),
    lockedFields: LockedFields.optional(),
  })
  .refine((b) => b.config !== undefined || b.patch !== undefined || b.lockedFields !== undefined, {
    message: 'Provide config, patch or lockedFields',
  });
export type UpdateDraftBody = z.infer<typeof UpdateDraftBody>;

export const ImportDraftBody = z.object({ revision: z.number().int().min(0), text: ImportText, format: Format });
export const RevertDraftBody = z.object({ revision: z.number().int().min(0), versionId: z.string().min(1).max(64).optional() });

export const ValidateBody = z.object({ config: z.record(z.unknown()).optional() }).default({});

export const PublishBody = z
  .object({
    changeNote: z.string().trim().max(1000).optional(),
    /** If given, publish only if the draft is still at this revision (what the author reviewed). */
    revision: z.number().int().min(0).optional(),
  })
  .default({});

export const RollbackBody = z.object({ changeNote: z.string().trim().max(1000).optional() }).default({});

export const DiffQuery = z.object({
  from: z.string().min(1).max(64).default('latest'),
  to: z.string().min(1).max(64).default('draft'),
});

export const ExportQuery = z.object({
  format: z.enum(['yaml', 'json']).default('yaml'),
  source: z.enum(['draft', 'version']).default('draft'),
  versionId: z.string().min(1).max(64).optional(),
});

export const PreviewQuery = z.object({
  source: z.enum(['draft', 'version']).default('draft'),
  versionId: z.string().min(1).max(64).optional(),
});

export const UpdateScenarioMetaBody = z.object({ isTemplate: z.boolean().optional() });

export const GalleryListBody = z.object({ listed: z.boolean() });

export const AssistantBody = z.object({ instruction: z.string().trim().min(3).max(4000) });
export const ApplyProposalBody = z
  .object({ paths: z.array(z.enum(EDITABLE_FIELD_PATHS)).min(1).max(EDITABLE_FIELD_PATHS.length).optional() })
  .default({});

export const GalleryQuery = PaginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  type: z.enum(SCENARIO_TYPES).optional(),
  tag: z.string().trim().max(40).optional(),
});
export type GalleryQuery = z.infer<typeof GalleryQuery>;
