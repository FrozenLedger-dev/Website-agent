/**
 * The editable site model — the stable semantic representation of one
 * generated website.
 *
 * Three objects, three authorities, never collapsed into one:
 *
 * - `SitePlan` is planning authority: strategy, value proposition, what each
 *   page and section is for. Sol writes it; a replan replaces it.
 * - `EditableSiteModel` (this file) is semantic identity: which pages, sections,
 *   blocks, fields and asset slots the site has, under opaque harness-owned IDs,
 *   their editable values, and the typed design tokens a later editor may change.
 * - `BuildOutput` is implementation: the React files Terra writes. The model is
 *   not an AST of them. Generated code advertises the model's identity through
 *   `data-statx-*-id` attributes, and a deterministic gate proves every build
 *   carries exactly the identity and values the model claims.
 *
 * Identity is never positional, textual or source-derived. A section keeps its
 * ID when it moves, its heading changes or its layout changes; an ID retired
 * once is never given to anything else.
 */
import * as z from 'zod/v4';
import { ArtifactRef } from './primitives.js';
import { SectionLayout } from './artifacts.js';

export const EDITABLE_SITE_MODEL_SCHEMA_VERSION = 'statxai-editable-site-model@1';
export const EDITABLE_SITE_MODEL_ARTIFACT = 'editable-site-model';

// ---------------------------------------------------------------------------
// Opaque typed identity
// ---------------------------------------------------------------------------

/** Sixteen hex characters behind a type prefix: opaque, public-safe, never an index, a path or a text. */
const typedId = <Prefix extends string>(prefix: Prefix) => z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{16}$`));

export const PageId = typedId('pg');
export const SectionId = typedId('sec');
export const BlockId = typedId('blk');
export const FieldId = typedId('fld');
export const AssetId = typedId('ast');
export type PageId = z.infer<typeof PageId>;
export type SectionId = z.infer<typeof SectionId>;
export type BlockId = z.infer<typeof BlockId>;
export type FieldId = z.infer<typeof FieldId>;
export type AssetId = z.infer<typeof AssetId>;
export const SemanticId = z.union([PageId, SectionId, BlockId, FieldId, AssetId]);
export type SemanticId = z.infer<typeof SemanticId>;

/** The public HTML attribute each identity kind is advertised under. */
export const SITE_MODEL_MARKERS = Object.freeze({
  page: 'data-statx-page-id',
  section: 'data-statx-section-id',
  block: 'data-statx-block-id',
  field: 'data-statx-field-id',
  asset: 'data-statx-asset-id',
} as const);

// ---------------------------------------------------------------------------
// Design system — typed tokens, never free CSS
// ---------------------------------------------------------------------------

/** A CSS colour as a value, never as a declaration: hex, a colour function of numbers, or a bare colour keyword. */
export const ColorValue = z
  .string()
  .regex(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[-0-9.%deg\s,/]+\)|[a-z]{3,20})$/, 'expected a colour value');
/** One font family, as Google Fonts spells it. No stacks, quotes or declarations. */
export const FontFamily = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/, 'expected one font family name');

export const DesignTokens = z.strictObject({
  colors: z.strictObject({
    background: ColorValue,
    surface: ColorValue,
    text: ColorValue,
    muted: ColorValue,
    accent: ColorValue,
    accentText: ColorValue,
    border: ColorValue,
  }),
  typography: z.strictObject({
    headingFamily: FontFamily,
    bodyFamily: FontFamily,
    baseSize: z.string().regex(/^\d{1,2}(\.\d{1,2})?(px|rem)$/, 'expected a size like "18px"'),
    scale: z.string().regex(/^(1(\.\d{1,3})?|2(\.0{1,3})?)$/, 'expected a type scale ratio like "1.25"'),
  }),
  radius: z.enum(['square', 'subtle', 'rounded']),
  /** The compositional brief every build follows — prose a person may rewrite, never CSS. */
  artDirection: z.string().min(1).max(2_000),
});
export type DesignTokens = z.infer<typeof DesignTokens>;

/** Every design token a semantic patch may set, by path. Nothing else is settable. */
export const DesignTokenPath = z.enum([
  'colors.background',
  'colors.surface',
  'colors.text',
  'colors.muted',
  'colors.accent',
  'colors.accentText',
  'colors.border',
  'typography.headingFamily',
  'typography.bodyFamily',
  'typography.baseSize',
  'typography.scale',
  'radius',
  'artDirection',
]);
export type DesignTokenPath = z.infer<typeof DesignTokenPath>;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A key naming a field's role inside its parent — `heading`, `title`, `action`. Unique per parent, never an ID. */
const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const Visibility = z.enum(['visible', 'hidden']);
export type Visibility = z.infer<typeof Visibility>;

/** An internal route, a phone or mail link, or an https URL. Nothing executable. */
export const LinkHref = z.string().regex(/^(\/([a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)?(#[a-z0-9-]+)?|tel:\+?[0-9 ()-]{5,20}|mailto:[^\s<>"']{3,120}|https:\/\/[^\s<>"']{3,300})$/, 'expected an internal route, tel:, mailto: or https: link');

const PlainText = z.string().trim().min(1).max(600);

export const TextField = z.strictObject({ fieldId: FieldId, key: FieldKey, type: z.literal('text'), value: PlainText });
export const CtaField = z.strictObject({ fieldId: FieldId, key: FieldKey, type: z.literal('cta'), value: z.strictObject({ label: z.string().trim().min(1).max(80), href: LinkHref }) });
export const PhoneField = z.strictObject({ fieldId: FieldId, key: FieldKey, type: z.literal('phone'), value: z.string().regex(/^\+?[0-9 ()-]{5,20}$/) });
export const EmailField = z.strictObject({ fieldId: FieldId, key: FieldKey, type: z.literal('email'), value: z.string().regex(/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/) });
export const AddressField = z.strictObject({ fieldId: FieldId, key: FieldKey, type: z.literal('address'), value: PlainText });
export const AssetField = z.strictObject({ fieldId: FieldId, key: FieldKey, type: z.literal('asset'), value: AssetId });

export const SiteField = z.discriminatedUnion('type', [TextField, CtaField, PhoneField, EmailField, AddressField, AssetField]);
export type SiteField = z.infer<typeof SiteField>;
export type SiteFieldType = SiteField['type'];

/**
 * The block kinds a section may hold, each with exactly the fields it carries.
 * A block's field set is fixed by its kind — adding a block is choosing a kind,
 * never inventing a structure.
 */
export const SUPPORTED_BLOCKS = Object.freeze({
  text: [{ key: 'body', type: 'text' }],
  cta: [{ key: 'action', type: 'cta' }],
  card: [{ key: 'title', type: 'text' }, { key: 'body', type: 'text' }],
  stat: [{ key: 'value', type: 'text' }, { key: 'caption', type: 'text' }],
  step: [{ key: 'title', type: 'text' }, { key: 'body', type: 'text' }],
  faq_item: [{ key: 'question', type: 'text' }, { key: 'answer', type: 'text' }],
  phone: [{ key: 'value', type: 'phone' }],
  email: [{ key: 'value', type: 'email' }],
  address: [{ key: 'value', type: 'address' }],
  image: [{ key: 'image', type: 'asset' }, { key: 'alt', type: 'text' }],
} as const satisfies Record<string, readonly { key: string; type: SiteFieldType }[]>);
export const BlockKind = z.enum(Object.keys(SUPPORTED_BLOCKS) as [keyof typeof SUPPORTED_BLOCKS, ...(keyof typeof SUPPORTED_BLOCKS)[]]);
export type BlockKind = z.infer<typeof BlockKind>;

export const SiteBlock = z.strictObject({
  blockId: BlockId,
  kind: BlockKind,
  visibility: Visibility,
  fields: z.array(SiteField).min(1).max(4),
});
export type SiteBlock = z.infer<typeof SiteBlock>;

export const SiteSection = z.strictObject({
  sectionId: SectionId,
  /** The planning key this section was created from. Matching authority on replan, never rendered, never an ID. */
  planKey: z.string().min(1).max(80),
  layout: SectionLayout,
  visibility: Visibility,
  /** Exactly one `heading` text field, plus nothing else in this schema version. */
  fields: z.array(SiteField).length(1),
  blocks: z.array(SiteBlock).max(40),
});
export type SiteSection = z.infer<typeof SiteSection>;

const Route = z.string().regex(/^\/([a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)?$/, 'expected a route like "/services"');

export const SitePage = z.strictObject({
  pageId: PageId,
  route: Route,
  /** Exactly `title` and `description` text fields: the page's `<title>` and meta description. */
  fields: z.array(SiteField).length(2),
  /** In rendered order. Order is composition; it is never identity. */
  sections: z.array(SiteSection).min(1).max(30),
});
export type SitePage = z.infer<typeof SitePage>;

/**
 * A semantic asset slot. `assetId` is the slot — "the hero image" — and stays
 * when its contents change; `source` is what currently fills it.
 */
export const SiteAsset = z.strictObject({
  assetId: AssetId,
  kind: z.enum(['image', 'illustration', 'logo']),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unassigned') }),
    z.strictObject({
      kind: z.literal('blob'),
      blob: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      width: z.number().int().positive().max(10_000),
      height: z.number().int().positive().max(10_000),
    }),
  ]),
});
export type SiteAsset = z.infer<typeof SiteAsset>;
export type SiteAssetSource = SiteAsset['source'];

// ---------------------------------------------------------------------------
// Provenance, identity ledger, model
// ---------------------------------------------------------------------------

export const EditableSiteModelProvenance = z.discriminatedUnion('kind', [
  /** Materialised by the harness from an exact plan, before any code was generated. */
  z.strictObject({ kind: z.literal('site_plan'), sitePlan: ArtifactRef }),
  /** Reconciled with a revised plan: surviving identity kept, removed identity retired. */
  z.strictObject({ kind: z.literal('replan'), base: ArtifactRef, sitePlan: ArtifactRef }),
  /** One validated semantic patch applied to an exact base model. */
  z.strictObject({ kind: z.literal('semantic_patch'), base: ArtifactRef, operation: z.string().min(1), target: z.union([SemanticId, DesignTokenPath]) }),
]);
export type EditableSiteModelProvenance = z.infer<typeof EditableSiteModelProvenance>;

export const EditableSiteModel = z
  .strictObject({
    schemaVersion: z.literal(EDITABLE_SITE_MODEL_SCHEMA_VERSION),
    projectId: z.string().min(1),
    /** The exact plan this model's planned structure agrees with. */
    sitePlan: ArtifactRef,
    provenance: EditableSiteModelProvenance,
    design: DesignTokens,
    pages: z.array(SitePage).min(1).max(30),
    assets: z.array(SiteAsset).max(100),
    identity: z.strictObject({
      /** Every ID this lineage has ever retired. Never given to anything again. */
      retired: z.array(SemanticId).max(10_000),
      /** How many harness-minted IDs this lineage has allocated. Only ever grows. */
      minted: z.number().int().nonnegative(),
    }),
  })
  .superRefine((model, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const seen = new Set<string>();
    const retired = new Set(model.identity.retired);
    if (retired.size !== model.identity.retired.length) issue('a retired ID is listed twice');
    const claim = (id: string) => {
      if (seen.has(id)) issue(`duplicate semantic ID ${id}`);
      if (retired.has(id)) issue(`retired ID ${id} is in use`);
      seen.add(id);
    };
    const assetIds = new Set(model.assets.map((a) => a.assetId));
    for (const asset of model.assets) claim(asset.assetId);

    const fieldsHave = (fields: readonly SiteField[], expected: readonly { key: string; type: SiteFieldType }[], owner: string) => {
      const keys = fields.map((f) => `${f.key}:${f.type}`).sort();
      const wanted = expected.map((f) => `${f.key}:${f.type}`).sort();
      if (keys.join() !== wanted.join()) issue(`${owner} must have exactly the fields ${wanted.join(', ')}`);
      for (const field of fields) {
        claim(field.fieldId);
        if (field.type === 'asset' && !assetIds.has(field.value)) issue(`field ${field.fieldId} references unknown asset ${field.value}`);
      }
    };

    const routes = new Set<string>();
    for (const page of model.pages) {
      claim(page.pageId);
      if (routes.has(page.route)) issue(`two pages share the route ${page.route}`);
      routes.add(page.route);
      fieldsHave(page.fields, [{ key: 'title', type: 'text' }, { key: 'description', type: 'text' }], `page ${page.pageId}`);
      const planKeys = new Set<string>();
      for (const section of page.sections) {
        claim(section.sectionId);
        if (planKeys.has(section.planKey)) issue(`two sections of ${page.route} share the plan key ${section.planKey}`);
        planKeys.add(section.planKey);
        fieldsHave(section.fields, [{ key: 'heading', type: 'text' }], `section ${section.sectionId}`);
        for (const block of section.blocks) {
          claim(block.blockId);
          fieldsHave(block.fields, SUPPORTED_BLOCKS[block.kind], `${block.kind} block ${block.blockId}`);
        }
      }
    }
    if (!routes.has('/')) issue('the model must have a homepage at "/"');
  });
export type EditableSiteModel = z.infer<typeof EditableSiteModel>;

// ---------------------------------------------------------------------------
// Semantic patches
// ---------------------------------------------------------------------------

export const SemanticPatchOperation = z.discriminatedUnion('op', [
  /** Change one field's value. `expected` is the value the author saw. */
  z.strictObject({ op: z.literal('set_field_value'), fieldId: FieldId, expected: z.unknown(), value: z.unknown() }),
  /** Fill an asset slot with different contents. The slot's ID is unchanged. */
  z.strictObject({ op: z.literal('set_asset'), assetId: AssetId, expected: SiteAsset.shape.source, source: SiteAsset.shape.source }),
  /** Show or hide one section or block. */
  z.strictObject({ op: z.literal('set_visibility'), targetId: z.union([SectionId, BlockId]), visibility: Visibility }),
  /** Move one section to a new position within its own page. */
  z.strictObject({ op: z.literal('move_section'), sectionId: SectionId, toIndex: z.number().int().nonnegative() }),
  /** Change a section's compositional form, within the bounded layouts. */
  z.strictObject({ op: z.literal('set_section_layout'), sectionId: SectionId, expected: SectionLayout, layout: SectionLayout }),
  /** Change one design token to a value of its own type. */
  z.strictObject({ op: z.literal('set_design_token'), token: DesignTokenPath, expected: z.string(), value: z.string() }),
  /** Add one supported block; its IDs are minted by the harness. */
  z.strictObject({
    op: z.literal('add_block'),
    sectionId: SectionId,
    index: z.number().int().nonnegative(),
    kind: BlockKind,
    values: z.record(z.string(), z.unknown()),
  }),
  /** Remove one block. Its IDs are retired, never reused. */
  z.strictObject({ op: z.literal('remove_block'), blockId: BlockId }),
]);
export type SemanticPatchOperation = z.infer<typeof SemanticPatchOperation>;

/** A patch names the exact model version it was written against — never "the current site". */
export const SemanticPatch = z.strictObject({
  baseModel: ArtifactRef.extend({ name: z.literal(EDITABLE_SITE_MODEL_ARTIFACT), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  operation: SemanticPatchOperation,
});
export type SemanticPatch = z.infer<typeof SemanticPatch>;
