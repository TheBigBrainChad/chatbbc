/** Safe catalog metadata. Skill bodies remain main-process data until prompt preparation. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  /** Stable model-facing path in the managed library or an approved project/root. */
  path: string;
}

export type SkillScope = 'managed' | 'repo' | 'user' | 'system' | 'admin';
export type SkillSource = 'managed' | 'repo-agents' | 'project-codex' | 'user-agents' | 'codex-home' | 'bundled' | 'admin';
export interface SkillMetadata {
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  allowImplicitInvocation: boolean;
  /** Descriptive only: these declarations never register tools or enable plugins. */
  dependencies?: Array<{ type: string; value: string; description?: string }>;
}
export interface LibrarySkill extends SkillSummary, SkillMetadata {
  scope: SkillScope;
  source: SkillSource;
  managed: boolean;
  /** Resolved for this skill. Present on inventory reads; the model-facing catalog carries only enabled rows. */
  enabled?: boolean;
  /**
   * UTF-8 size of the skill body, so Settings can show what a skill costs before it is sent.
   * Present wherever the body was already read to build the row; informational only, never a gate.
   */
  bytes?: number;
}
export interface SkillLibrary {
  skills: LibrarySkill[];
  errors: string[];
  roots: Array<{ path: string; scope: SkillScope; source: SkillSource }>;
  includeInstructions: boolean;
  maxContextTokens?: number;
}
/**
 * The Settings page's view of the library: the model-facing catalog, plus the rows it omits.
 *
 * The catalog must not carry a skill the user switched off, and the page must still be able to
 * show it — otherwise turning a skill off would be a one-way door. Both are projected from one
 * pass over the library, so the two can never disagree about what "off" means.
 */
export interface SkillLibraryPage extends SkillLibrary {
  disabled: LibrarySkill[];
}
export interface SkillsDraftScope { sessionId?: string | null; projectId?: string | null }

/**
 * The app's own record of the bundled Skill pack and the user's choices about it.
 *
 * Declared here, not in the main process, because the renderer and the preload bridge show
 * and set the same choices; a second declaration would be a divergence waiting to happen.
 */
export interface SkillState {
  version: 1;
  /** Skill id -> sha256 of the directory contents this app last wrote. */
  seeded: Record<string, string>;
  /** User enablement. Absent means inherit. */
  enabled: Record<string, boolean>;
  /** User implicit-invocation choice. Absent means inherit. */
  implicit: Record<string, boolean>;
  /** Bundled ids the user removed. Never re-seeded. */
  removed: string[];
}

export const MAX_SKILLS = 64;
export const MAX_SKILL_BYTES = 128_000;
export const MAX_SKILL_CHARS = 96_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
