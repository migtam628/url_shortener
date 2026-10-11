/** Zod request/response schemas, shared between the API (validation) and the
 *  dashboard (form typing). */

import { z } from 'zod';
import { MAX_SLUG_LENGTH } from './slug.js';

export const redirectCodeSchema = z.union([z.literal(301), z.literal(302), z.literal(307)]);

export const userRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const ruleMatchTypeSchema = z.enum([
  'country',
  'region',
  'device',
  'os',
  'language',
  'referrer',
  'ab',
]);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(200, 'Password cannot exceed 200 characters.');

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SLUG_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Slug must start with a letter or digit and contain only letters, digits, dots, hyphens and underscores.',
  );

export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/,
    'Must be a valid hostname.',
  );

export const utmSchema = z.object({
  source: z.string().trim().max(255).optional(),
  medium: z.string().trim().max(255).optional(),
  campaign: z.string().trim().max(255).optional(),
  term: z.string().trim().max(255).optional(),
  content: z.string().trim().max(255).optional(),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
  tenantName: z.string().trim().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const createLinkSchema = z.object({
  domainId: z.string().uuid().optional(),
  slug: slugSchema.optional(),
  destination: z.string().trim().min(1).max(2048),
  redirectCode: redirectCodeSchema.default(302),
  title: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1000).optional(),
  folderId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(25).default([]),
  utm: utmSchema.optional(),
});

export const updateLinkSchema = z
  .object({
    slug: slugSchema.optional(),
    domainId: z.string().uuid().optional(),
    destination: z.string().trim().min(1).max(2048).optional(),
    redirectCode: redirectCodeSchema.optional(),
    title: z.string().trim().max(300).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    folderId: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(25).optional(),
    archived: z.boolean().optional(),
    /** Free-text note stored on the resulting linkVersion row. */
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

export const bulkLinkSchema = z.object({
  links: z.array(createLinkSchema).min(1).max(1000),
  /** Continue past per-row failures instead of rejecting the whole batch. */
  continueOnError: z.boolean().default(true),
});

export const listLinksQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  domainId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  tag: z.string().trim().max(50).optional(),
  archived: z.coerce.boolean().optional(),
  sort: z.enum(['created_desc', 'created_asc', 'clicks_desc', 'updated_desc']).default('created_desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Domains and folders
// ---------------------------------------------------------------------------

export const createDomainSchema = z.object({
  hostname: hostnameSchema,
  isDefault: z.boolean().default(false),
  mainPageRedirect: z.string().trim().max(2048).nullable().optional(),
  notFoundRedirect: z.string().trim().max(2048).nullable().optional(),
});

export const updateDomainSchema = z
  .object({
    isDefault: z.boolean().optional(),
    mainPageRedirect: z.string().trim().max(2048).nullable().optional(),
    notFoundRedirect: z.string().trim().max(2048).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

export const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const apiKeyScopeSchema = z.enum([
  'links:read',
  'links:write',
  'domains:read',
  'domains:write',
  'analytics:read',
]);

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(apiKeyScopeSchema).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export const analyticsQuerySchema = z.object({
  linkId: z.string().uuid().optional(),
  domainId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  interval: z.enum(['hour', 'day']).default('day'),
  tz: z.string().max(64).default('UTC'),
});

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

const hexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color.');

export const qrQuerySchema = z.object({
  size: z.coerce.number().int().min(64).max(2048).default(512),
  color: hexColor.default('#000000'),
  bg: hexColor.default('#ffffff'),
  ecc: z.enum(['L', 'M', 'Q', 'H']).default('M'),
  margin: z.coerce.number().int().min(0).max(16).default(2),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateLinkInput = z.infer<typeof createLinkSchema>;
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;
export type BulkLinkInput = z.infer<typeof bulkLinkSchema>;
export type ListLinksQuery = z.infer<typeof listLinksQuerySchema>;
export type CreateDomainInput = z.infer<typeof createDomainSchema>;
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type QrQuery = z.infer<typeof qrQuerySchema>;
